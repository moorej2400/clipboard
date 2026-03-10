const assert = require("node:assert/strict");
const test = require("node:test");

const { enqueuePendingDictationEvent, flushPendingDictationEvents } = require("../../src/agent");

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
