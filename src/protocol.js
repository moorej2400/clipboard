const crypto = require("crypto");

const MESSAGE_TYPES = Object.freeze({
  HELLO: "hello",
  AUTH_OK: "auth_ok",
  AUTH_REQUIRED: "auth_required",
  PAIR_REQUEST: "pair_request",
  PAIR_RESULT: "pair_result",
  CLIPBOARD_EVENT: "clipboard_event"
});

function safeParseMessage(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch (_error) {
    return null;
  }
}

function makeClipboardEvent(originDeviceId, text) {
  return {
    type: MESSAGE_TYPES.CLIPBOARD_EVENT,
    eventId: crypto.randomUUID(),
    originDeviceId,
    timestamp: Date.now(),
    text
  };
}

module.exports = {
  MESSAGE_TYPES,
  safeParseMessage,
  makeClipboardEvent
};
