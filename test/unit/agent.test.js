const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createSerializedAsyncTask,
  enqueuePendingDictationEvent,
  flushPendingDictationEvents,
  shouldSuppressClipboardEcho,
  shouldSyncClipboardText
} = require("../../src/agent");

test("Pending dictation events are queued and flushed in order", () => {
  const queue = [];

  assert.equal(
    enqueuePendingDictationEvent(queue, { idHex: "dict-1", text: "first dictation" }),
    1
  );
  assert.equal(
    enqueuePendingDictationEvent(queue, { idHex: "dict-2", text: "second dictation" }),
    2
  );

  const emitted = [];
  const flushed = flushPendingDictationEvents(
    queue,
    () => true,
    (text, metadata) => {
      emitted.push({ text, metadata });
      return true;
    }
  );

  assert.equal(flushed, 2);
  assert.deepEqual(queue, []);
  assert.deepEqual(emitted, [
    {
      text: "first dictation",
      metadata: {
        source: "macwhisper_reconnect_flush",
        dictationId: "dict-1"
      }
    },
    {
      text: "second dictation",
      metadata: {
        source: "macwhisper_reconnect_flush",
        dictationId: "dict-2"
      }
    }
  ]);
});

test("Pending dictation flush leaves unsent items in the queue", () => {
  const queue = [];

  enqueuePendingDictationEvent(queue, { idHex: "dict-1", text: "first dictation" });
  enqueuePendingDictationEvent(queue, { idHex: "dict-2", text: "second dictation" });
  enqueuePendingDictationEvent(queue, { idHex: "dict-3", text: "third dictation" });

  let sendCount = 0;
  const emitted = [];
  const flushed = flushPendingDictationEvents(
    queue,
    () => true,
    (text, metadata) => {
      sendCount += 1;
      emitted.push({ text, metadata });
      return sendCount < 3;
    }
  );

  assert.equal(flushed, 2);
  assert.deepEqual(emitted, [
    {
      text: "first dictation",
      metadata: {
        source: "macwhisper_reconnect_flush",
        dictationId: "dict-1"
      }
    },
    {
      text: "second dictation",
      metadata: {
        source: "macwhisper_reconnect_flush",
        dictationId: "dict-2"
      }
    },
    {
      text: "third dictation",
      metadata: {
        source: "macwhisper_reconnect_flush",
        dictationId: "dict-3"
      }
    }
  ]);
  assert.deepEqual(queue, [
    {
      text: "third dictation",
      dictationId: "dict-3"
    }
  ]);
});

test("Empty clipboard text is not considered syncable", () => {
  assert.equal(shouldSyncClipboardText(""), false);
  assert.equal(shouldSyncClipboardText("https://example.com"), true);
  assert.equal(shouldSyncClipboardText(" "), true);
});

test("Serialized async task skips overlapping runs and allows later runs", async () => {
  let releaseFirstRun;
  let runCount = 0;
  const run = createSerializedAsyncTask(async () => {
    runCount += 1;
    await new Promise((resolve) => {
      releaseFirstRun = resolve;
    });
  });

  const firstRun = run();

  assert.equal(await run(), false);
  assert.equal(runCount, 1);

  releaseFirstRun();
  assert.equal(await firstRun, true);

  let secondRunReleased;
  const secondRun = run();
  assert.equal(runCount, 2);
  secondRunReleased = releaseFirstRun;
  secondRunReleased();
  assert.equal(await secondRun, true);
});

test("Serialized async task clears in-flight state after failure", async () => {
  let runCount = 0;
  const run = createSerializedAsyncTask(async () => {
    runCount += 1;
    if (runCount === 1) {
      throw new Error("first run failed");
    }
  });

  await assert.rejects(run(), /first run failed/);

  assert.equal(await run(), true);
  assert.equal(runCount, 2);
});

test("Clipboard echo suppression only blocks the exact recent payload", () => {
  const suppressUntil = 2000;

  assert.equal(shouldSuppressClipboardEcho("remote text", "remote text", suppressUntil, 1500), true);
  assert.equal(shouldSuppressClipboardEcho("local edit", "remote text", suppressUntil, 1500), false);
  assert.equal(shouldSuppressClipboardEcho("remote text", "remote text", suppressUntil, 2500), false);
});
