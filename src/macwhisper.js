const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_POLL_BATCH_SIZE = 50;
const SQLITE_WARN_THROTTLE_MS = 10000;

function getDefaultMacWhisperDbPath(homeDir = os.homedir()) {
  return path.join(homeDir, "Library", "Application Support", "MacWhisper", "Database", "main.sqlite");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function escapeSqlString(value) {
  return String(value).replace(/'/g, "''");
}

function normalizeHex(value) {
  if (!isNonEmptyString(value)) {
    return null;
  }
  if (!/^[0-9a-fA-F]+$/.test(value)) {
    return null;
  }
  return value.toUpperCase();
}

function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseJsonLines(stdout) {
  return String(stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function buildLatestCursorQuery() {
  return `
SELECT json_object(
  'idHex', lower(hex(id)),
  'dateCreated', dateCreated
)
FROM dictation
WHERE dateDeleted IS NULL
  AND length(trim(COALESCE(NULLIF(processedText, ''), transcribedText))) > 0
ORDER BY dateCreated DESC, id DESC
LIMIT 1;
`.trim();
}

function buildNewRowsQuery({ cursor, limit }) {
  let cursorClause = "";
  if (cursor && isNonEmptyString(cursor.dateCreated) && isNonEmptyString(cursor.idHex)) {
    const escapedDate = escapeSqlString(cursor.dateCreated);
    const normalizedHex = normalizeHex(cursor.idHex);
    if (normalizedHex) {
      cursorClause = `
  AND (
    dateCreated > '${escapedDate}'
    OR (dateCreated = '${escapedDate}' AND id > x'${normalizedHex}')
  )`;
    }
  }

  return `
SELECT json_object(
  'idHex', lower(hex(id)),
  'dateCreated', dateCreated,
  'text', COALESCE(NULLIF(processedText, ''), transcribedText)
)
FROM dictation
WHERE dateDeleted IS NULL
  AND length(trim(COALESCE(NULLIF(processedText, ''), transcribedText))) > 0${cursorClause}
ORDER BY dateCreated ASC, id ASC
LIMIT ${Number(limit)};
`.trim();
}

function createMacWhisperSource(options = {}) {
  const logger = options.logger || console;
  const platform = options.platform || process.platform;
  const dbPath = options.dbPath || getDefaultMacWhisperDbPath(options.homeDir || os.homedir());
  const batchSize = Number(options.batchSize) > 0 ? Number(options.batchSize) : DEFAULT_POLL_BATCH_SIZE;

  let enabled = platform === "darwin" && fs.existsSync(dbPath);
  let cursor = null;
  let initialized = false;
  let sqliteReady = false;
  let sqliteMissingLogged = false;
  let lastSqliteWarnAt = 0;

  async function runJsonQuery(sql) {
    const result = await execFileAsync("sqlite3", ["-readonly", dbPath, sql]);
    return parseJsonLines(result.stdout);
  }

  function logThrottledWarning(message) {
    const now = Date.now();
    if (now - lastSqliteWarnAt >= SQLITE_WARN_THROTTLE_MS) {
      logger.warn(message);
      lastSqliteWarnAt = now;
    }
  }

  async function ensureSqliteAvailable() {
    if (!enabled) {
      return false;
    }
    if (sqliteReady) {
      return true;
    }
    try {
      await execFileAsync("sqlite3", ["-version"]);
      sqliteReady = true;
      return true;
    } catch (error) {
      if (error && error.code === "ENOENT") {
        enabled = false;
        if (!sqliteMissingLogged) {
          logger.warn("MacWhisper polling disabled: sqlite3 CLI is not available.");
          sqliteMissingLogged = true;
        }
        return false;
      }
      logThrottledWarning(`MacWhisper polling query preflight failed: ${error.message}`);
      return false;
    }
  }

  async function initializeHighWaterMark() {
    if (!enabled) {
      return { enabled: false, dbPath: null };
    }
    if (!(await ensureSqliteAvailable())) {
      return { enabled: false, dbPath: null };
    }
    if (initialized) {
      return { enabled: true, dbPath, cursor };
    }

    try {
      const rows = await runJsonQuery(buildLatestCursorQuery());
      const latest = rows[0];
      if (latest && isNonEmptyString(latest.idHex) && isNonEmptyString(latest.dateCreated)) {
        cursor = {
          idHex: latest.idHex,
          dateCreated: latest.dateCreated
        };
      } else {
        cursor = null;
      }
      initialized = true;
      return { enabled: true, dbPath, cursor };
    } catch (error) {
      logThrottledWarning(`MacWhisper polling failed to initialize cursor: ${error.message}`);
      return { enabled: false, dbPath: null };
    }
  }

  async function pollNewDictationsSinceHighWater() {
    if (!enabled) {
      return [];
    }
    if (!(await ensureSqliteAvailable())) {
      return [];
    }
    if (!initialized) {
      const init = await initializeHighWaterMark();
      if (!init.enabled) {
        return [];
      }
    }

    const collected = [];
    while (true) {
      const sql = buildNewRowsQuery({
        cursor,
        limit: batchSize
      });

      let rows;
      try {
        rows = await runJsonQuery(sql);
      } catch (error) {
        logThrottledWarning(`MacWhisper polling query failed: ${error.message}`);
        return collected;
      }

      if (!Array.isArray(rows) || rows.length === 0) {
        return collected;
      }

      for (const row of rows) {
        if (!row || !isNonEmptyString(row.idHex) || !isNonEmptyString(row.dateCreated) || !isNonEmptyString(row.text)) {
          continue;
        }
        cursor = {
          idHex: row.idHex,
          dateCreated: row.dateCreated
        };
        collected.push({
          idHex: row.idHex,
          dateCreated: row.dateCreated,
          text: row.text
        });
      }

      if (rows.length < batchSize) {
        return collected;
      }
    }
  }

  return {
    isEnabled() {
      return enabled;
    },
    getDbPath() {
      return enabled ? dbPath : null;
    },
    getBatchSize() {
      return batchSize;
    },
    initializeHighWaterMark,
    pollNewDictationsSinceHighWater
  };
}

module.exports = {
  DEFAULT_POLL_BATCH_SIZE,
  createMacWhisperSource,
  getDefaultMacWhisperDbPath
};
