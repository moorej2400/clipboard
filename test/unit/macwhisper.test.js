const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const { spawnSync, execFileSync } = require("child_process");

const { createMacWhisperSource } = require("../../src/macwhisper");

const SQLITE_AVAILABLE = spawnSync("sqlite3", ["-version"], { stdio: "ignore" }).status === 0;

function sqlValue(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runSql(dbPath, sql) {
  execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
}

function createTempDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipboard-macwhisper-"));
  const dbPath = path.join(root, "main.sqlite");
  runSql(
    dbPath,
    `
CREATE TABLE dictation (
  id BLOB PRIMARY KEY NOT NULL,
  dateCreated DATETIME NOT NULL,
  transcribedText TEXT,
  processedText TEXT,
  dateDeleted DOUBLE
);
`.trim()
  );
  return { root, dbPath };
}

function insertDictation(dbPath, { idHex, dateCreated, transcribedText, processedText = null, dateDeleted = null }) {
  runSql(
    dbPath,
    `
INSERT INTO dictation (id, dateCreated, transcribedText, processedText, dateDeleted)
VALUES (
  x'${idHex}',
  ${sqlValue(dateCreated)},
  ${sqlValue(transcribedText)},
  ${sqlValue(processedText)},
  ${dateDeleted === null ? "NULL" : sqlValue(dateDeleted)}
);
`.trim()
  );
}

test("MacWhisper source is disabled on non-darwin platforms", async () => {
  const source = createMacWhisperSource({
    platform: "linux",
    dbPath: "/tmp/nonexistent-macwhisper.sqlite"
  });
  assert.equal(source.isEnabled(), false);
  const init = await source.initializeHighWaterMark();
  assert.equal(init.enabled, false);
});

test("MacWhisper polling initializes at current high-water and only returns future rows", { skip: !SQLITE_AVAILABLE }, async () => {
  const { dbPath } = createTempDb();
  insertDictation(dbPath, {
    idHex: "0000000000000001",
    dateCreated: "2026-03-04 21:00:00.000",
    transcribedText: "old text",
    processedText: "old processed"
  });

  const source = createMacWhisperSource({
    platform: "darwin",
    dbPath
  });

  assert.equal(source.isEnabled(), true);

  const init = await source.initializeHighWaterMark();
  assert.equal(init.enabled, true);

  const initialRows = await source.pollNewDictationsSinceHighWater();
  assert.deepEqual(initialRows, []);

  insertDictation(dbPath, {
    idHex: "0000000000000002",
    dateCreated: "2026-03-04 21:00:01.000",
    transcribedText: "new raw",
    processedText: "new processed"
  });

  const rows = await source.pollNewDictationsSinceHighWater();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].idHex, "0000000000000002");
  assert.equal(rows[0].text, "new processed");
});

test("MacWhisper polling falls back to transcribedText and ignores updates to already-seen rows", { skip: !SQLITE_AVAILABLE }, async () => {
  const { dbPath } = createTempDb();
  const source = createMacWhisperSource({
    platform: "darwin",
    dbPath
  });

  await source.initializeHighWaterMark();

  insertDictation(dbPath, {
    idHex: "000000000000000A",
    dateCreated: "2026-03-04 21:05:00.000",
    transcribedText: "fallback text",
    processedText: ""
  });

  const firstPoll = await source.pollNewDictationsSinceHighWater();
  assert.equal(firstPoll.length, 1);
  assert.equal(firstPoll[0].text, "fallback text");

  runSql(
    dbPath,
    `
UPDATE dictation
SET processedText = 'updated processed'
WHERE hex(id) = '000000000000000A';
`.trim()
  );

  const secondPoll = await source.pollNewDictationsSinceHighWater();
  assert.deepEqual(secondPoll, []);
});

test("MacWhisper polling resolves late-filled rows even after newer rows advance the cursor", { skip: !SQLITE_AVAILABLE }, async () => {
  const { dbPath } = createTempDb();
  const source = createMacWhisperSource({
    platform: "darwin",
    dbPath
  });

  await source.initializeHighWaterMark();

  insertDictation(dbPath, {
    idHex: "000000000000000B",
    dateCreated: "2026-03-04 21:10:00.000",
    transcribedText: "",
    processedText: ""
  });

  assert.deepEqual(await source.pollNewDictationsSinceHighWater(), []);

  insertDictation(dbPath, {
    idHex: "000000000000000C",
    dateCreated: "2026-03-04 21:10:01.000",
    transcribedText: "newer row",
    processedText: "newer processed"
  });

  const newerRows = await source.pollNewDictationsSinceHighWater();
  assert.equal(newerRows.length, 1);
  assert.equal(newerRows[0].idHex, "000000000000000c");

  runSql(
    dbPath,
    `
UPDATE dictation
SET processedText = 'late filled row'
WHERE hex(id) = '000000000000000B';
`.trim()
  );

  const lateFilledRows = await source.pollNewDictationsSinceHighWater();
  assert.equal(lateFilledRows.length, 1);
  assert.equal(lateFilledRows[0].idHex, "000000000000000b");
  assert.equal(lateFilledRows[0].text, "late filled row");
});
