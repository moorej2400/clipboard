const readline = require("readline");
const WebSocket = require("ws");
const crypto = require("crypto");
const { makeClipboardEvent, MESSAGE_TYPES, safeParseMessage } = require("./protocol");
const { readClipboardText, writeClipboardText } = require("./clipboard");

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

function summarizeText(text) {
  const normalized = typeof text === "string" ? text : "";
  return {
    textLength: normalized.length,
    textHash: crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16)
  };
}

async function startAgent({ hubUrl, pairCode, expectedFingerprint, localDevice, saveLocalDevice, logger }) {
  const autoTrustFingerprint = process.env.AGENT_AUTO_TRUST_FINGERPRINT === "1";
  let currentPairCode = isString(pairCode) ? pairCode : null;
  let reconnectDelayMs = 1000;
  let authenticated = false;
  let stopped = false;
  let ws = null;
  let pollTimer = null;
  let suppressBroadcastUntil = 0;
  let lastAppliedTimestamp = 0;
  let lastClipboardText = "";
  let clipboardReadErrorCount = 0;
  let lastClipboardReadErrorKey = "";
  const seenEventIds = new Map();

  try {
    lastClipboardText = await readClipboardText();
  } catch (_error) {
    lastClipboardText = "";
  }
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

    // We intentionally suppress outbound publish briefly after applying remote clipboard
    // so synchronized devices do not echo the same payload back and forth.
    suppressBroadcastUntil = Date.now() + 1500;
    try {
      await writeClipboardText(message.text);
      lastClipboardText = message.text;
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

  function startClipboardPolling() {
    if (pollTimer) {
      return;
    }
    pollTimer = setInterval(async () => {
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

      if (currentText === lastClipboardText) {
        return;
      }

      if (logger) {
        logger.info("clipboard_local_change_detected", {
          direction: "local_to_remote",
          ...summarizeText(currentText)
        });
      }

      if (Date.now() < suppressBroadcastUntil) {
        if (logger) {
          logger.info("clipboard_local_change_suppressed", {
            reason: "suppression_window",
            ...summarizeText(currentText)
          });
        }
        return;
      }

      lastClipboardText = currentText;
      const event = makeClipboardEvent(localDevice.deviceId, currentText);
      seenEventIds.set(event.eventId, Date.now());
      cleanupSeenEvents();
      ws.send(JSON.stringify(event));
      if (logger) {
        logger.info("clipboard_event_emitted", {
          direction: "local_to_remote",
          eventId: event.eventId,
          timestamp: event.timestamp,
          ...summarizeText(currentText)
        });
      }
    }, 500);
  }

  function stopClipboardPolling() {
    if (!pollTimer) {
      return;
    }
    clearInterval(pollTimer);
    pollTimer = null;
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
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    stopped = true;
    stopClipboardPolling();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    process.exit(0);
  });

  await connect();
  await new Promise(() => {});
}

module.exports = {
  startAgent
};
