const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { randomUUID } = require("crypto");
const { startHub } = require("./hub");
const { startAgent } = require("./agent");
const { getPaths, readJson, writeJson } = require("./store");
const { createLogger } = require("./logger");

const DEVICE_ROLES = new Set(["hub", "agent"]);

function parseCli(argv) {
  const firstToken = argv[0];
  const mode = DEVICE_ROLES.has(firstToken) ? firstToken : null;
  const options = {};
  const optionStartIndex = mode ? 1 : 0;
  for (let i = optionStartIndex; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    i += 1;
  }
  return { mode, options };
}

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

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const entries of Object.values(interfaces)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (!entry || entry.internal || entry.family !== "IPv4") {
        continue;
      }
      ips.push(entry.address);
    }
  }
  if (ips.length === 0) {
    ips.push("127.0.0.1");
  }
  return Array.from(new Set(ips));
}

function getLoopbackHubUrl(port) {
  return `wss://127.0.0.1:${port}`;
}

function getLanHubUrls(port) {
  return getLanAddresses().map((ip) => `wss://${ip}:${port}`);
}

function saveLocalDevice(paths, localDevice) {
  writeJson(paths.localDevice, localDevice);
}

function isValidRole(value) {
  return DEVICE_ROLES.has(value);
}

function loadLocalDevice(paths, requestedName) {
  const existing = readJson(paths.localDevice, null);
  const localDevice = {
    deviceId: existing && typeof existing.deviceId === "string" ? existing.deviceId : randomUUID(),
    deviceName:
      typeof requestedName === "string" && requestedName.length > 0
        ? requestedName
        : existing && typeof existing.deviceName === "string"
          ? existing.deviceName
          : os.hostname(),
    authToken: existing && typeof existing.authToken === "string" ? existing.authToken : null,
    hubUrl: existing && typeof existing.hubUrl === "string" ? existing.hubUrl : null,
    hubFingerprint: existing && typeof existing.hubFingerprint === "string" ? existing.hubFingerprint : null,
    role: existing && isValidRole(existing.role) ? existing.role : null,
    hubPort:
      existing && Number.isInteger(existing.hubPort) && existing.hubPort > 0 ? existing.hubPort : 4242,
    hubBindAddress:
      existing && typeof existing.hubBindAddress === "string" && existing.hubBindAddress.length > 0
        ? existing.hubBindAddress
        : "0.0.0.0"
  };
  saveLocalDevice(paths, localDevice);
  return localDevice;
}

function writeDeviceInfoMarkdown(markdownPath, content) {
  fs.writeFileSync(markdownPath, content, "utf8");
}

function buildHubMarkdown({ deviceName, deviceId, port, pairCode, certFingerprint256 }) {
  const localUrl = getLoopbackHubUrl(port);
  const lanUrls = getLanHubUrls(port);
  return [
    "# Clipboard Sync Device Info",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Device",
    `- Name: ${deviceName}`,
    `- ID: ${deviceId}`,
    `- Mode: hub`,
    "",
    "## Pairing",
    `- Pairing Code: ${pairCode}`,
    "",
    "## Local Hub Endpoint",
    `- ${localUrl}`,
    "",
    "## LAN Hub Endpoints",
    ...lanUrls.map((url) => `- ${url}`),
    "",
    "## TLS",
    `- Certificate Fingerprint (SHA-256): ${certFingerprint256}`,
    "",
    "## Local Agent Join Example",
    "```bash",
    `node src/index.js agent --hub ${localUrl} --code ${pairCode} --fingerprint "${certFingerprint256}"`,
    "```",
    "",
    "## Remote Agent Join Example",
    "```bash",
    `node src/index.js agent --hub ${lanUrls[0]} --code ${pairCode} --fingerprint "${certFingerprint256}"`,
    "```",
    ""
  ].join("\n");
}

function buildAgentMarkdown({ deviceName, deviceId, hubUrl, hubFingerprint }) {
  return [
    "# Clipboard Sync Device Info",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Device",
    `- Name: ${deviceName}`,
    `- ID: ${deviceId}`,
    `- Mode: agent`,
    "",
    "## Hub Target",
    `- URL: ${hubUrl || "Not configured yet"}`,
    `- Trusted Fingerprint: ${hubFingerprint || "Not trusted yet"}`,
    ""
  ].join("\n");
}

function printUsage() {
  console.log("Usage:");
  console.log("  npm start");
  console.log("  node src/index.js hub --port 4242 --name \"My Hub\"");
  console.log("  node src/index.js agent --hub wss://192.168.1.10:4242 --code 123456 --name \"My Device\" --fingerprint \"AA:...\"");
}

function persistHubConfiguration(paths, localDevice, { port, bindAddress }) {
  localDevice.role = "hub";
  localDevice.hubPort = port;
  localDevice.hubBindAddress = bindAddress;
  localDevice.hubUrl = getLoopbackHubUrl(port);
  saveLocalDevice(paths, localDevice);
}

function persistAgentConfiguration(paths, localDevice, { hubUrl }) {
  localDevice.role = "agent";
  localDevice.hubUrl = hubUrl;
  saveLocalDevice(paths, localDevice);
}

async function startConfiguredHub({ options, paths, localDevice, logger, markdownPath }) {
  const port = Number(options.port || localDevice.hubPort || 4242);
  const bindAddress =
    typeof options.bind === "string"
      ? options.bind
      : typeof localDevice.hubBindAddress === "string" && localDevice.hubBindAddress.length > 0
        ? localDevice.hubBindAddress
        : "0.0.0.0";

  const hubState = await startHub({
    port,
    bindAddress,
    localDevice,
    paths,
    logger
  });

  persistHubConfiguration(paths, localDevice, { port, bindAddress });
  writeDeviceInfoMarkdown(
    markdownPath,
    buildHubMarkdown({
      deviceName: localDevice.deviceName,
      deviceId: localDevice.deviceId,
      port,
      pairCode: hubState.pairCode,
      certFingerprint256: hubState.certFingerprint256
    })
  );
  console.log(`Device info written to ${markdownPath}`);

  return {
    hubUrl: getLoopbackHubUrl(port),
    pairCode: hubState.pairCode,
    expectedFingerprint: hubState.certFingerprint256
  };
}

async function startConfiguredAgent({
  options,
  paths,
  localDevice,
  logger,
  markdownPath,
  fallbackHubUrl = null,
  fallbackPairCode = null,
  fallbackFingerprint = null,
  persistRole = true,
  writeDeviceInfo = true
}) {
  let hubUrl = typeof options.hub === "string" ? options.hub : localDevice.hubUrl || fallbackHubUrl;
  if (!hubUrl) {
    hubUrl = await promptInput("Hub URL (wss://HOST:PORT): ");
  }
  if (!hubUrl) {
    console.error("Hub URL is required.");
    process.exit(1);
  }

  if (persistRole) {
    persistAgentConfiguration(paths, localDevice, { hubUrl });
  } else {
    localDevice.hubUrl = hubUrl;
    saveLocalDevice(paths, localDevice);
  }
  if (writeDeviceInfo) {
    writeDeviceInfoMarkdown(
      markdownPath,
      buildAgentMarkdown({
        deviceName: localDevice.deviceName,
        deviceId: localDevice.deviceId,
        hubUrl,
        hubFingerprint: localDevice.hubFingerprint
      })
    );
    console.log(`Device info written to ${markdownPath}`);
  }

  await startAgent({
    hubUrl,
    pairCode: typeof options.code === "string" ? options.code : fallbackPairCode,
    expectedFingerprint:
      typeof options.fingerprint === "string" ? options.fingerprint : localDevice.hubFingerprint || fallbackFingerprint,
    localDevice,
    saveLocalDevice: (updated) => saveLocalDevice(paths, updated),
    logger
  });
}

async function main() {
  const { mode, options } = parseCli(process.argv.slice(2));

  const paths = getPaths();
  const logger = createLogger(paths.baseDir);
  const localDevice = loadLocalDevice(paths, options.name);
  const markdownPath = path.join(process.cwd(), "device-info.md");

  if (mode === "hub") {
    await startConfiguredHub({ options, paths, localDevice, logger, markdownPath });
    return;
  }

  if (mode === "agent") {
    await startConfiguredAgent({ options, paths, localDevice, logger, markdownPath });
    return;
  }

  if (localDevice.role === "hub") {
    const hubRuntime = await startConfiguredHub({ options, paths, localDevice, logger, markdownPath });
    await startConfiguredAgent({
      options,
      paths,
      localDevice,
      logger,
      markdownPath,
      fallbackHubUrl: hubRuntime.hubUrl,
      fallbackPairCode: localDevice.authToken ? null : hubRuntime.pairCode,
      fallbackFingerprint: hubRuntime.expectedFingerprint,
      persistRole: false,
      writeDeviceInfo: false
    });
    return;
  }

  if (localDevice.role === "agent") {
    await startConfiguredAgent({ options, paths, localDevice, logger, markdownPath });
    return;
  }

  printUsage();
  console.error(
    "No configured role found. Run `node src/index.js hub ...` or `node src/index.js agent ...` once to save startup config."
  );
  process.exit(1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  parseCli,
  loadLocalDevice,
  isValidRole
};
