const readline = require("readline");
const WebSocket = require("ws");
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

async function startAgent({ hubUrl, pairCode, expectedFingerprint, localDevice, saveLocalDevice }) {
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
  const seenEventIds = new Map();

  try {
    lastClipboardText = await readClipboardText();
  } catch (_error) {
    lastClipboardText = "";
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
    if (!isString(message.eventId) || typeof message.timestamp !== "number" || typeof message.text !== "string") {
      return;
    }
    if (seenEventIds.has(message.eventId)) {
      return;
    }
    if (message.timestamp < lastAppliedTimestamp) {
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
    } catch (error) {
      console.error(`Failed to write clipboard: ${error.message}`);
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
      } catch (error) {
        console.error(`Failed to read clipboard: ${error.message}`);
        return;
      }

      if (currentText === lastClipboardText) {
        return;
      }

      if (Date.now() < suppressBroadcastUntil) {
        return;
      }

      lastClipboardText = currentText;
      const event = makeClipboardEvent(localDevice.deviceId, currentText);
      seenEventIds.set(event.eventId, Date.now());
      cleanupSeenEvents();
      ws.send(JSON.stringify(event));
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
      const certificateIsTrusted = await verifyAndTrustHubCertificate(ws._socket);
      if (!certificateIsTrusted) {
        stopped = true;
        ws.close();
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
        return;
      }

      if (message.type === MESSAGE_TYPES.AUTH_REQUIRED) {
        authenticated = false;
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
          return;
        }

        console.error(`Pairing failed: ${message.reason || "Unknown reason"}`);
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
      if (!stopped) {
        scheduleReconnect();
      }
    });

    ws.on("error", (error) => {
      console.error(`Hub connection error: ${error.message}`);
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
