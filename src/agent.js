const readline = require("readline");
const WebSocket = require("ws");
const crypto = require("crypto");
const { makeClipboardEvent, MESSAGE_TYPES, safeParseMessage } = require("./protocol");
const { readClipboardText, writeClipboardText } = require("./clipboard");
const { createMacWhisperSource } = require("./macwhisper");
const { createMacClipboardPolicy } = require("./macClipboardPolicy");

const CLIPBOARD_POLL_INTERVAL_MS = 500;
const DICTATION_POLL_INTERVAL_MS = 500;

function promptInput(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || "").trim());
    });
  });
}

async function promptYesNo(question) {
  const answer = (await promptInput(question)).toLowerCase();
  return answer === "y" || answer === "yes";
}

function isString(value) {
  return typeof value === "string" && value.length > 0;
}

function shouldSyncClipboardText(text) {
  return typeof text === "string" && text.length > 0;
}

function summarizeText(text) {
  const normalized = typeof text === "string" ? text : "";
  return {
    textLength: normalized.length,
    textHash: crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16)
  };
}

function enqueuePendingDictationEvent(queue, dictation) {
  if (!Array.isArray(queue) || !dictation || !isString(dictation.text)) {
    return 0;
  }

  queue.push({
    text: dictation.text,
    dictationId: isString(dictation.idHex) ? dictation.idHex : null
  });

  return queue.length;
}

function flushPendingDictationEvents(queue, canSendClipboardEvent, emitClipboardEvent) {
  if (!Array.isArray(queue) || typeof canSendClipboardEvent !== "function" || typeof emitClipboardEvent !== "function") {
    return 0;
  }

  let flushed = 0;
  while (queue.length > 0 && canSendClipboardEvent()) {
    const nextEvent = queue[0];
    const emitted = emitClipboardEvent(nextEvent.text, {
      source: "macwhisper_reconnect_flush",
      dictationId: nextEvent.dictationId
    });

    if (!emitted) {
      break;
    }

    queue.shift();
    flushed += 1;
  }

  return flushed;
}

function createSerializedAsyncTask(task) {
  let inFlight = false;

  return async function runSerializedAsyncTask(...args) {
    if (inFlight) {
      return false;
    }

    inFlight = true;
    try {
      await task(...args);
      return true;
    } finally {
      inFlight = false;
    }
  };
}

function shouldSuppressClipboardEcho(currentText, suppressedText, suppressUntil, now = Date.now()) {
  return now < suppressUntil && currentText === suppressedText;
}

async function startAgent({
  hubUrl,
  pairCode,
  expectedFingerprint,
  localDevice,
  saveLocalDevice,
  logger,
  forceSync = false
}) {
  const autoTrustFingerprint = process.env.AGENT_AUTO_TRUST_FINGERPRINT === "1";
  let currentPairCode = isString(pairCode) ? pairCode : null;
  let reconnectDelayMs = 1000;
  let authenticated = false;
  let stopped = false;
  let ws = null;
  let clipboardPollTimer = null;
  let dictationPollTimer = null;
  let dictationPollInFlight = false;
  let suppressBroadcastUntil = 0;
  let suppressedBroadcastText = null;
  let lastAppliedTimestamp = 0;
  let lastClipboardText = "";
  let lastObservedClipboardText = "";
  const pendingDictationEvents = [];
  let clipboardReadErrorCount = 0;
  let lastClipboardReadErrorKey = "";
  const seenEventIds = new Map();
  const macWhisperSource = createMacWhisperSource();
  const macClipboardPolicy = createMacClipboardPolicy(forceSync ? { forceSync } : {});

  try {
    lastClipboardText = await readClipboardText();
  } catch (_error) {
    lastClipboardText = "";
  }
  lastObservedClipboardText = lastClipboardText;
  if (logger) {
    logger.info("agent_start", {
      deviceId: localDevice.deviceId,
      deviceName: localDevice.deviceName,
      hubUrl
    });
  }

  function cleanupSeenEvents() {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [eventId, seenAt] of seenEventIds.entries()) {
      if (seenAt < cutoff) {
        seenEventIds.delete(eventId);
      }
    }
  }

  function canSendClipboardEvent() {
    return authenticated && !!ws && ws.readyState === WebSocket.OPEN;
  }

  function emitClipboardEvent(text, metadata = null) {
    if (!canSendClipboardEvent()) {
      return false;
    }

    const event = makeClipboardEvent(localDevice.deviceId, text);
    seenEventIds.set(event.eventId, Date.now());
    cleanupSeenEvents();
    ws.send(JSON.stringify(event));

    if (logger) {
      logger.info("clipboard_event_emitted", {
        direction: "local_to_remote",
        eventId: event.eventId,
        timestamp: event.timestamp,
        source: metadata && metadata.source ? metadata.source : "clipboard_poll",
        ...(metadata && metadata.dictationId ? { dictationId: metadata.dictationId } : {}),
        ...summarizeText(text)
      });
    }

    return true;
  }

  async function notifyOutboundClipboardSync(metadata) {
    try {
      await macClipboardPolicy.notifyOutboundSyncSent();
    } catch (error) {
      if (logger) {
        logger.warn("clipboard_send_sound_failed", {
          source: metadata && metadata.source ? metadata.source : "clipboard_poll",
          error: error.message
        });
      }
    }
  }

  async function attemptOutboundClipboardSync(text, metadata = null) {
    if (!canSendClipboardEvent()) {
      return {
        sent: false,
        reason: "socket_unavailable"
      };
    }

    const policyDecision = await macClipboardPolicy.shouldAllowOutboundSync();
    if (!policyDecision.allowed) {
      if (logger) {
        logger.warn("clipboard_event_blocked_local_policy", {
          source: metadata && metadata.source ? metadata.source : "clipboard_poll",
          policyReason: policyDecision.reason,
          sessionTitle: policyDecision.expectedTitle || macClipboardPolicy.getSessionTitle(),
          ...(Array.isArray(policyDecision.observedWindowTitles)
            ? { observedWindowTitles: policyDecision.observedWindowTitles }
            : {}),
          ...(policyDecision.error ? { error: policyDecision.error } : {}),
          ...summarizeText(text)
        });
      }

      return {
        sent: false,
        reason: "local_policy_blocked"
      };
    }

    const sent = emitClipboardEvent(text, metadata);
    if (sent) {
      await notifyOutboundClipboardSync(metadata);
    }

    return {
      sent,
      reason: sent ? "sent" : "emit_failed"
    };
  }

  async function getPairCode() {
    if (isString(currentPairCode)) {
      return currentPairCode;
    }
    currentPairCode = await promptInput("Enter pairing code from hub: ");
    return currentPairCode;
  }

  function persistLocalState() {
    saveLocalDevice(localDevice);
  }

  async function handleIncomingClipboardEvent(message) {
    if (logger) {
      logger.info("clipboard_event_received", {
        direction: "remote_to_local",
        eventId: message.eventId,
        originDeviceId: message.originDeviceId,
        timestamp: message.timestamp,
        ...summarizeText(message.text)
      });
    }
    if (!isString(message.eventId) || typeof message.timestamp !== "number" || typeof message.text !== "string") {
      if (logger) {
        logger.warn("clipboard_event_ignored_malformed", {
          eventId: message.eventId || null
        });
      }
      return;
    }
    if (!shouldSyncClipboardText(message.text)) {
      if (logger) {
        logger.info("clipboard_event_ignored_empty", {
          eventId: message.eventId
        });
      }
      return;
    }
    if (seenEventIds.has(message.eventId)) {
      if (logger) {
        logger.info("clipboard_event_ignored_duplicate", {
          eventId: message.eventId
        });
      }
      return;
    }
    if (message.timestamp < lastAppliedTimestamp) {
      if (logger) {
        logger.info("clipboard_event_ignored_stale", {
          eventId: message.eventId,
          eventTimestamp: message.timestamp,
          lastAppliedTimestamp
        });
      }
      return;
    }

    lastAppliedTimestamp = message.timestamp;
    seenEventIds.set(message.eventId, Date.now());
    cleanupSeenEvents();

    try {
      await writeClipboardText(message.text);
      lastClipboardText = message.text;
      lastObservedClipboardText = message.text;
      // Suppress only this exact payload briefly so synchronized devices do not
      // echo it back, while still allowing rapid follow-up local edits through.
      suppressBroadcastUntil = Date.now() + 1500;
      suppressedBroadcastText = message.text;
      if (logger) {
        logger.info("clipboard_event_applied", {
          direction: "remote_to_local",
          eventId: message.eventId,
          ...summarizeText(message.text)
        });
      }
    } catch (error) {
      console.error(`Failed to write clipboard: ${error.message}`);
      if (logger) {
        logger.error("clipboard_apply_failed", {
          eventId: message.eventId,
          error: error.message
        });
      }
    }
  }

  async function applyDictationText(text, dictationId) {
    try {
      await writeClipboardText(text);
      lastClipboardText = text;
      if (logger) {
        logger.info("dictation_text_applied", {
          source: "macwhisper",
          dictationId: dictationId || null,
          ...summarizeText(text)
        });
      }
      return true;
    } catch (error) {
      console.error(`Failed to write clipboard from dictation: ${error.message}`);
      if (logger) {
        logger.error("dictation_clipboard_apply_failed", {
          source: "macwhisper",
          dictationId: dictationId || null,
          error: error.message
        });
      }
      return false;
    }
  }

  async function flushPendingDictationEvent() {
    if (pendingDictationEvents.length === 0) {
      return;
    }
    if (!canSendClipboardEvent()) {
      return;
    }

    let flushed = 0;
    while (pendingDictationEvents.length > 0 && canSendClipboardEvent()) {
      const nextEvent = pendingDictationEvents[0];
      suppressBroadcastUntil = Date.now() + 1500;
      suppressedBroadcastText = nextEvent.text;
      const result = await attemptOutboundClipboardSync(nextEvent.text, {
        source: "macwhisper_reconnect_flush",
        dictationId: nextEvent.dictationId
      });

      if (!result.sent) {
        if (result.reason === "local_policy_blocked") {
          const droppedCount = pendingDictationEvents.length;
          pendingDictationEvents.length = 0;
          if (logger) {
            logger.warn("dictation_event_dropped_local_policy", {
              source: "macwhisper_reconnect_flush",
              droppedCount
            });
          }
        }
        break;
      }

      pendingDictationEvents.shift();
      flushed += 1;
    }

    if (flushed > 0 && logger) {
      logger.info("dictation_event_flush_succeeded", {
        source: "macwhisper",
        flushedCount: flushed
      });
    }
  }

  async function handleNewDictation(dictation) {
    if (!dictation || !isString(dictation.text)) {
      return;
    }

    if (logger) {
      logger.info("dictation_detected", {
        source: "macwhisper",
        dictationId: dictation.idHex || null,
        dateCreated: isString(dictation.dateCreated) ? dictation.dateCreated : null,
        ...summarizeText(dictation.text)
      });
    }

    const wroteClipboard = await applyDictationText(dictation.text, dictation.idHex);
    if (!wroteClipboard) {
      return;
    }

    if (canSendClipboardEvent()) {
      suppressBroadcastUntil = Date.now() + 1500;
      suppressedBroadcastText = dictation.text;
      const result = await attemptOutboundClipboardSync(dictation.text, {
        source: "macwhisper_poll",
        dictationId: dictation.idHex
      });
      if (result.sent) {
        pendingDictationEvents.length = 0;
        return;
      }

      if (result.reason === "local_policy_blocked") {
        if (logger) {
          logger.warn("dictation_event_dropped_local_policy", {
            source: "macwhisper_poll",
            dictationId: dictation.idHex || null,
            ...summarizeText(dictation.text)
          });
        }
        return;
      }

      return;
    }

    enqueuePendingDictationEvent(pendingDictationEvents, dictation);
    if (logger) {
      logger.info("dictation_event_queued_offline", {
        source: "macwhisper",
        dictationId: dictation.idHex || null,
        pendingQueueLength: pendingDictationEvents.length,
        ...summarizeText(dictation.text)
      });
    }
  }

  function startClipboardPolling() {
    if (clipboardPollTimer) {
      return;
    }

    // Windows clipboard reads spawn a PowerShell process; overlapping reads can
    // contend for the desktop clipboard and produce persistent ExternalException noise.
    const pollClipboardOnce = createSerializedAsyncTask(async () => {
      if (!authenticated || !ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }

      let currentText;
      try {
        currentText = await readClipboardText();
        if (clipboardReadErrorCount > 0 && logger) {
          logger.info("clipboard_read_recovered", {
            previousConsecutiveErrors: clipboardReadErrorCount
          });
        }
        clipboardReadErrorCount = 0;
        lastClipboardReadErrorKey = "";
      } catch (error) {
        clipboardReadErrorCount += 1;
        const transient = Boolean(error && error.clipboardTransient);
        const reason = transient ? error.clipboardReason || "unknown_transient" : null;
        const errorMessage = String(error && error.message ? error.message : error);
        const errorKey = `${reason || "generic"}:${errorMessage}`;
        const shouldConsoleLog = !transient || errorKey !== lastClipboardReadErrorKey || clipboardReadErrorCount % 50 === 0;
        if (shouldConsoleLog) {
          console.error(`Failed to read clipboard: ${errorMessage}`);
        }
        lastClipboardReadErrorKey = errorKey;
        if (logger) {
          logger.warn("clipboard_read_issue", {
            transient,
            reason,
            error: errorMessage,
            consecutiveErrorCount: clipboardReadErrorCount
          });
        }
        return;
      }

      if (currentText === lastObservedClipboardText) {
        return;
      }

      lastObservedClipboardText = currentText;

      if (!shouldSyncClipboardText(currentText)) {
        if (logger) {
          logger.info("clipboard_local_change_ignored_empty", {
            direction: "local_to_remote"
          });
        }
        return;
      }

      if (currentText === lastClipboardText) {
        return;
      }

      if (logger) {
        logger.info("clipboard_local_change_detected", {
          direction: "local_to_remote",
          ...summarizeText(currentText)
        });
      }

      if (shouldSuppressClipboardEcho(currentText, suppressedBroadcastText, suppressBroadcastUntil)) {
        if (logger) {
          logger.info("clipboard_local_change_suppressed", {
            reason: "suppression_window",
            ...summarizeText(currentText)
          });
        }
        return;
      }

      lastClipboardText = currentText;
      await attemptOutboundClipboardSync(currentText, { source: "clipboard_poll" });
    });

    clipboardPollTimer = setInterval(() => {
      void pollClipboardOnce();
    }, CLIPBOARD_POLL_INTERVAL_MS);
  }

  function stopClipboardPolling() {
    if (!clipboardPollTimer) {
      return;
    }
    clearInterval(clipboardPollTimer);
    clipboardPollTimer = null;
  }

  function startDictationPolling() {
    if (dictationPollTimer || !macWhisperSource.isEnabled()) {
      return;
    }

    dictationPollTimer = setInterval(async () => {
      if (dictationPollInFlight || stopped) {
        return;
      }

      dictationPollInFlight = true;
      try {
        const newDictations = await macWhisperSource.pollNewDictationsSinceHighWater();
        for (const dictation of newDictations) {
          await handleNewDictation(dictation);
        }
      } finally {
        dictationPollInFlight = false;
      }
    }, DICTATION_POLL_INTERVAL_MS);
  }

  function stopDictationPolling() {
    if (!dictationPollTimer) {
      return;
    }
    clearInterval(dictationPollTimer);
    dictationPollTimer = null;
  }

  async function initializeDictationPolling() {
    if (!macWhisperSource.isEnabled()) {
      return;
    }

    const initState = await macWhisperSource.initializeHighWaterMark();
    if (!initState.enabled || !initState.dbPath) {
      if (macWhisperSource.isEnabled()) {
        if (logger) {
          logger.warn("dictation_polling_init_degraded", {
            source: "macwhisper",
            dbPath: macWhisperSource.getDbPath()
          });
        }
        startDictationPolling();
      }
      return;
    }

    if (logger) {
      logger.info("dictation_polling_enabled", {
        source: "macwhisper",
        dbPath: initState.dbPath
      });
    } else {
      console.log(`MacWhisper dictation polling enabled at ${initState.dbPath}`);
    }
    startDictationPolling();
  }

  function scheduleReconnect() {
    if (stopped) {
      return;
    }
    const waitMs = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10000);
    setTimeout(connect, waitMs);
  }

  async function verifyAndTrustHubCertificate(socket) {
    const peerCertificate = socket && socket.getPeerCertificate ? socket.getPeerCertificate() : null;
    const fingerprint = peerCertificate && peerCertificate.fingerprint256;

    if (!isString(fingerprint)) {
      console.error("Could not read hub certificate fingerprint.");
      return false;
    }

    if (isString(expectedFingerprint) && expectedFingerprint !== fingerprint) {
      console.error("Hub fingerprint does not match expected fingerprint. Connection refused.");
      return false;
    }

    if (isString(localDevice.hubFingerprint) && localDevice.hubFingerprint !== fingerprint) {
      console.error("Trusted hub fingerprint changed. Refusing connection to prevent MITM.");
      return false;
    }

    if (!isString(localDevice.hubFingerprint)) {
      // This is trust-on-first-use: we pin the first accepted fingerprint so future
      // sessions can reject unexpected certificate changes on the LAN.
      const accepted = autoTrustFingerprint
        ? true
        : await promptYesNo(
            `Trust hub certificate fingerprint ${fingerprint}? (y/n): `
          );
      if (!accepted) {
        return false;
      }
      localDevice.hubFingerprint = fingerprint;
      localDevice.hubUrl = hubUrl;
      persistLocalState();
    }

    return true;
  }

  async function connect() {
    if (stopped) {
      return;
    }

    ws = new WebSocket(hubUrl, {
      rejectUnauthorized: false
    });

    ws.on("open", async () => {
      reconnectDelayMs = 1000;
      if (logger) {
        logger.info("hub_socket_open", { hubUrl });
      }
      const certificateIsTrusted = await verifyAndTrustHubCertificate(ws._socket);
      if (!certificateIsTrusted) {
        stopped = true;
        stopDictationPolling();
        ws.close();
        if (logger) {
          logger.warn("hub_socket_closed_untrusted_cert", { hubUrl });
        }
        return;
      }

      ws.send(
        JSON.stringify({
          type: MESSAGE_TYPES.HELLO,
          deviceId: localDevice.deviceId,
          deviceName: localDevice.deviceName,
          authToken: localDevice.authToken || null
        })
      );
    });

    ws.on("message", async (rawMessage) => {
      const message = safeParseMessage(String(rawMessage));
      if (!message || !isString(message.type)) {
        return;
      }

      if (message.type === MESSAGE_TYPES.AUTH_OK) {
        authenticated = true;
        startClipboardPolling();
        await flushPendingDictationEvent();
        if (logger) {
          logger.info("agent_authenticated", { deviceId: localDevice.deviceId });
        }
        return;
      }

      if (message.type === MESSAGE_TYPES.AUTH_REQUIRED) {
        authenticated = false;
        if (logger) {
          logger.info("agent_auth_required", { deviceId: localDevice.deviceId });
        }
        const code = await getPairCode();
        ws.send(
          JSON.stringify({
            type: MESSAGE_TYPES.PAIR_REQUEST,
            deviceId: localDevice.deviceId,
            deviceName: localDevice.deviceName,
            pairCode: code
          })
        );
        return;
      }

      if (message.type === MESSAGE_TYPES.PAIR_RESULT) {
        if (message.ok && isString(message.authToken)) {
          localDevice.authToken = message.authToken;
          localDevice.hubUrl = hubUrl;
          persistLocalState();
          currentPairCode = null;
          if (logger) {
            logger.info("pairing_succeeded", { deviceId: localDevice.deviceId });
          }
          return;
        }

        console.error(`Pairing failed: ${message.reason || "Unknown reason"}`);
        if (logger) {
          logger.warn("pairing_failed", {
            deviceId: localDevice.deviceId,
            reason: message.reason || "Unknown reason"
          });
        }
        currentPairCode = null;
        const retryCode = await getPairCode();
        ws.send(
          JSON.stringify({
            type: MESSAGE_TYPES.PAIR_REQUEST,
            deviceId: localDevice.deviceId,
            deviceName: localDevice.deviceName,
            pairCode: retryCode
          })
        );
        return;
      }

      if (message.type === MESSAGE_TYPES.CLIPBOARD_EVENT) {
        await handleIncomingClipboardEvent(message);
      }
    });

    ws.on("close", () => {
      authenticated = false;
      stopClipboardPolling();
      if (logger) {
        logger.warn("hub_socket_closed", { hubUrl });
      }
      if (!stopped) {
        scheduleReconnect();
      }
    });

    ws.on("error", (error) => {
      console.error(`Hub connection error: ${error.message}`);
      if (logger) {
        logger.error("hub_socket_error", {
          hubUrl,
          error: error.message
        });
      }
    });
  }

  process.on("SIGINT", () => {
    stopped = true;
    stopClipboardPolling();
    stopDictationPolling();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    stopped = true;
    stopClipboardPolling();
    stopDictationPolling();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    process.exit(0);
  });

  await initializeDictationPolling();
  await connect();
  await new Promise(() => {});
}

module.exports = {
  createSerializedAsyncTask,
  enqueuePendingDictationEvent,
  flushPendingDictationEvents,
  shouldSuppressClipboardEcho,
  shouldSyncClipboardText,
  startAgent
};
