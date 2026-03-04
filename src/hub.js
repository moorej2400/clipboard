const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const readline = require("readline");
const selfsigned = require("selfsigned");
const WebSocket = require("ws");
const { X509Certificate } = require("crypto");
const { MESSAGE_TYPES, safeParseMessage } = require("./protocol");
const { readJson, writeJson } = require("./store");

function generatePairCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createAuthToken() {
  return crypto.randomBytes(24).toString("hex");
}

function buildTlsMaterial(paths) {
  if (fs.existsSync(paths.tlsKey) && fs.existsSync(paths.tlsCert)) {
    const key = fs.readFileSync(paths.tlsKey, "utf8");
    const cert = fs.readFileSync(paths.tlsCert, "utf8");
    return {
      key,
      cert,
      fingerprint256: new X509Certificate(cert).fingerprint256
    };
  }

  const pems = selfsigned.generate(
    [{ name: "commonName", value: "clipboard-sync-local" }],
    {
      days: 3650,
      keySize: 2048,
      algorithm: "sha256",
      extensions: [
        {
          name: "subjectAltName",
          altNames: [
            { type: 2, value: "localhost" },
            { type: 7, ip: "127.0.0.1" }
          ]
        }
      ]
    }
  );

  fs.writeFileSync(paths.tlsKey, pems.private, "utf8");
  fs.writeFileSync(paths.tlsCert, pems.cert, "utf8");

  return {
    key: pems.private,
    cert: pems.cert,
    fingerprint256: new X509Certificate(pems.cert).fingerprint256
  };
}

class ApprovalQueue {
  constructor() {
    this.queue = [];
    this.active = false;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  enqueue(request) {
    return new Promise((resolve) => {
      this.queue.push({ request, resolve });
      this.processNext();
    });
  }

  processNext() {
    if (this.active) {
      return;
    }
    const entry = this.queue.shift();
    if (!entry) {
      return;
    }
    this.active = true;

    const { request, resolve } = entry;
    const prompt = `Approve pairing for "${request.deviceName}" (${request.deviceId})? (y/n): `;
    this.rl.question(prompt, (answer) => {
      const normalized = String(answer || "").trim().toLowerCase();
      resolve(normalized === "y" || normalized === "yes");
      this.active = false;
      this.processNext();
    });
  }

  close() {
    this.rl.close();
  }
}

function normalizeTrustedState(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.trustedDevices)) {
    return { trustedDevices: [] };
  }
  return {
    trustedDevices: raw.trustedDevices.filter((entry) => {
      return (
        entry &&
        typeof entry.deviceId === "string" &&
        typeof entry.deviceName === "string" &&
        typeof entry.authTokenHash === "string" &&
        typeof entry.approvedAt === "string"
      );
    })
  };
}

function isString(value) {
  return typeof value === "string" && value.length > 0;
}

async function startHub({ port, bindAddress, localDevice, paths }) {
  const tlsMaterial = buildTlsMaterial(paths);
  const pairCode = generatePairCode();

  const trustedState = normalizeTrustedState(readJson(paths.trustedDevices, { trustedDevices: [] }));
  const trustedByDeviceId = new Map(trustedState.trustedDevices.map((entry) => [entry.deviceId, entry]));
  const clients = new Map();
  const approvals = new ApprovalQueue();

  function persistTrustedDevices() {
    writeJson(paths.trustedDevices, {
      trustedDevices: Array.from(trustedByDeviceId.values())
    });
  }

  const httpsServer = https.createServer({
    key: tlsMaterial.key,
    cert: tlsMaterial.cert
  });

  const wss = new WebSocket.WebSocketServer({ server: httpsServer });

  wss.on("connection", (ws) => {
    clients.set(ws, {
      authenticated: false,
      deviceId: null,
      deviceName: null
    });

    const authTimeout = setTimeout(() => {
      const state = clients.get(ws);
      if (state && !state.authenticated) {
        ws.close(4001, "Authentication timeout");
      }
    }, 30000);

    ws.on("close", () => {
      clearTimeout(authTimeout);
      clients.delete(ws);
    });

    ws.on("message", async (rawMessage) => {
      const state = clients.get(ws);
      if (!state) {
        return;
      }

      const message = safeParseMessage(String(rawMessage));
      if (!message || !isString(message.type)) {
        return;
      }

      if (message.type === MESSAGE_TYPES.HELLO) {
        if (!isString(message.deviceId) || !isString(message.deviceName)) {
          ws.send(JSON.stringify({ type: MESSAGE_TYPES.AUTH_REQUIRED }));
          return;
        }

        state.deviceId = message.deviceId;
        state.deviceName = message.deviceName;

        const trusted = trustedByDeviceId.get(message.deviceId);
        const tokenIsValid =
          trusted &&
          isString(message.authToken) &&
          hashToken(message.authToken) === trusted.authTokenHash;

        if (tokenIsValid) {
          state.authenticated = true;
          ws.send(JSON.stringify({ type: MESSAGE_TYPES.AUTH_OK }));
        } else {
          ws.send(JSON.stringify({ type: MESSAGE_TYPES.AUTH_REQUIRED }));
        }
        return;
      }

      if (message.type === MESSAGE_TYPES.PAIR_REQUEST) {
        if (!isString(message.deviceId) || !isString(message.deviceName) || !isString(message.pairCode)) {
          ws.send(JSON.stringify({ type: MESSAGE_TYPES.PAIR_RESULT, ok: false, reason: "Malformed pairing request" }));
          return;
        }
        if (message.pairCode !== pairCode) {
          ws.send(JSON.stringify({ type: MESSAGE_TYPES.PAIR_RESULT, ok: false, reason: "Invalid pairing code" }));
          return;
        }

        state.deviceId = message.deviceId;
        state.deviceName = message.deviceName;

        // The pairing code is intentionally not sufficient on its own; explicit hub-side approval
        // prevents passive exposure of clipboard data when someone learns the code.
        const approved = await approvals.enqueue({
          deviceId: message.deviceId,
          deviceName: message.deviceName
        });

        if (!approved) {
          ws.send(JSON.stringify({ type: MESSAGE_TYPES.PAIR_RESULT, ok: false, reason: "Pairing denied by operator" }));
          return;
        }

        const authToken = createAuthToken();
        trustedByDeviceId.set(message.deviceId, {
          deviceId: message.deviceId,
          deviceName: message.deviceName,
          authTokenHash: hashToken(authToken),
          approvedAt: new Date().toISOString()
        });
        persistTrustedDevices();

        state.authenticated = true;
        ws.send(JSON.stringify({ type: MESSAGE_TYPES.PAIR_RESULT, ok: true, authToken }));
        ws.send(JSON.stringify({ type: MESSAGE_TYPES.AUTH_OK }));
        return;
      }

      if (message.type === MESSAGE_TYPES.CLIPBOARD_EVENT) {
        if (!state.authenticated) {
          return;
        }
        if (
          !isString(message.eventId) ||
          !isString(message.originDeviceId) ||
          typeof message.timestamp !== "number" ||
          typeof message.text !== "string"
        ) {
          return;
        }

        const outbound = JSON.stringify({
          type: MESSAGE_TYPES.CLIPBOARD_EVENT,
          eventId: message.eventId,
          originDeviceId: message.originDeviceId,
          timestamp: message.timestamp,
          text: message.text
        });

        for (const [clientSocket, clientState] of clients.entries()) {
          if (clientSocket === ws) {
            continue;
          }
          if (!clientState.authenticated) {
            continue;
          }
          if (clientSocket.readyState !== WebSocket.OPEN) {
            continue;
          }
          clientSocket.send(outbound);
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    httpsServer.once("error", reject);
    httpsServer.listen(port, bindAddress, resolve);
  });

  function stop() {
    approvals.close();
    wss.close();
    httpsServer.close();
  }

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`Hub started on ${bindAddress}:${port}`);
  console.log(`Pairing code for this session: ${pairCode}`);

  return {
    pairCode,
    certFingerprint256: tlsMaterial.fingerprint256,
    deviceId: localDevice.deviceId
  };
}

module.exports = {
  startHub
};
