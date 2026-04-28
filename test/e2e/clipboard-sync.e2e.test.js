const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ENTRYPOINT = path.join(REPO_ROOT, "src", "index.js");
const COMPOSE_FILE = path.join(REPO_ROOT, "docker-compose.e2e.yml");
const DOCKER_COMPOSE = getDockerComposeCommand();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(checkFn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await checkFn();
      if (value) {
        return value;
      }
    } catch (_error) {}
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function getDockerComposeCommand() {
  const dockerComposeStatus = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status;
  if (dockerComposeStatus === 0) {
    return { cmd: "docker", prefixArgs: ["compose"] };
  }

  const legacyComposeStatus = spawnSync("docker-compose", ["version"], { stdio: "ignore" }).status;
  if (legacyComposeStatus === 0) {
    return { cmd: "docker-compose", prefixArgs: [] };
  }

  return null;
}

function runCommand(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd || REPO_ROOT,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`Command failed (${cmd} ${args.join(" ")}): ${stderr || stdout || `exit ${code}`}`));
    });
  });
}

function startProcess(name, args, options = {}) {
  const child = spawn(process.execPath, [ENTRYPOINT, ...args], {
    cwd: options.cwd || REPO_ROOT,
    env: options.env || process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const state = { name, stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    state.stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    state.stderr += String(chunk);
  });

  return { child, state };
}

async function stopProcess(proc) {
  if (!proc || proc.killed) {
    return;
  }

  proc.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => proc.once("close", resolve)),
    delay(3000).then(() => {
      if (!proc.killed) {
        proc.kill("SIGKILL");
      }
    })
  ]);
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    server.on("listening", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : null;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function parseFingerprintFromMarkdown(markdown) {
  const match = markdown.match(/Certificate Fingerprint \(SHA-256\):\s*(.+)/);
  if (!match) {
    throw new Error("Could not parse hub fingerprint from device-info.md");
  }
  return match[1].trim();
}

function parsePairCodeFromMarkdown(markdown) {
  const match = markdown.match(/Pairing Code:\s*([0-9]{6})/);
  if (!match) {
    throw new Error("Could not parse hub pairing code from device-info.md");
  }
  return match[1].trim();
}

function getAuthTokenFromState(statePath) {
  const localDeviceRaw = readIfExists(statePath);
  if (!localDeviceRaw) {
    return null;
  }
  const localDevice = JSON.parse(localDeviceRaw);
  if (typeof localDevice.authToken === "string" && localDevice.authToken.length > 0) {
    return localDevice.authToken;
  }
  return null;
}

test("E2E_Bidirectional_FileBackend", { timeout: 120000, skip: !DOCKER_COMPOSE }, async () => {
  const dockerCompose = DOCKER_COMPOSE;

  const port = await getFreePort();
  const pairCode = "123456";
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clipboard-e2e-"));
  const sharedDir = path.join(runRoot, "shared");
  const hubCwd = path.join(runRoot, "hub-cwd");
  const hostAgentCwd = path.join(runRoot, "host-agent-cwd");
  const hubStateDir = path.join(runRoot, "hub-state");
  const hostAgentStateDir = path.join(runRoot, "host-agent-state");
  const hostClipboardFile = path.join(sharedDir, "host-clipboard.txt");
  const containerClipboardFile = path.join(sharedDir, "container-clipboard.txt");

  fs.mkdirSync(sharedDir, { recursive: true });
  fs.mkdirSync(hubCwd, { recursive: true });
  fs.mkdirSync(hostAgentCwd, { recursive: true });
  fs.mkdirSync(hubStateDir, { recursive: true });
  fs.mkdirSync(hostAgentStateDir, { recursive: true });
  fs.writeFileSync(hostClipboardFile, "", "utf8");
  fs.writeFileSync(containerClipboardFile, "", "utf8");

  let hubProcess;
  let hostAgentProcess;
  const composeEnv = {
    ...process.env
  };

  try {
    hubProcess = startProcess(
      "hub",
      ["hub", "--port", String(port), "--bind", "0.0.0.0", "--name", "e2e-hub"],
      {
        cwd: hubCwd,
        env: {
          ...process.env,
          CLIPBOARD_SYNC_DATA_DIR: hubStateDir,
          HUB_PAIR_CODE: pairCode,
          HUB_AUTO_APPROVE_PAIRING: "1"
        }
      }
    );

    const hubDeviceInfoPath = path.join(hubCwd, "device-info.md");
    const hubDeviceInfo = await waitFor(() => {
      const content = readIfExists(hubDeviceInfoPath);
      return content && content.includes("Certificate Fingerprint") ? content : null;
    }, 20000, "hub device-info");

    const hubFingerprint = parseFingerprintFromMarkdown(hubDeviceInfo);
    const pairCodeFromHubInfo = parsePairCodeFromMarkdown(hubDeviceInfo);

    hostAgentProcess = startProcess(
      "host-agent",
      [
        "agent",
        "--hub",
        `wss://127.0.0.1:${port}`,
        "--code",
        pairCodeFromHubInfo,
        "--name",
        "e2e-host-agent",
        "--fingerprint",
        hubFingerprint,
        "--force-sync"
      ],
      {
        cwd: hostAgentCwd,
        env: {
          ...process.env,
          CLIPBOARD_SYNC_DATA_DIR: hostAgentStateDir,
          CLIPBOARD_BACKEND: "file",
          CLIPBOARD_FILE_PATH: hostClipboardFile,
          AGENT_AUTO_TRUST_FINGERPRINT: "1"
        }
      }
    );

    await waitFor(
      () => getAuthTokenFromState(path.join(hostAgentStateDir, "local_device.json")),
      30000,
      "host agent auth token"
    );

    composeEnv.E2E_SHARED_DIR = sharedDir;
    composeEnv.HUB_PORT = String(port);
    composeEnv.PAIR_CODE = pairCodeFromHubInfo;
    composeEnv.HUB_FINGERPRINT = hubFingerprint;
    composeEnv.HUB_URL = `wss://host.docker.internal:${port}`;

    await runCommand(
      dockerCompose.cmd,
      [...dockerCompose.prefixArgs, "-f", COMPOSE_FILE, "up", "-d", "--remove-orphans"],
      { cwd: REPO_ROOT, env: composeEnv }
    );

    await waitFor(
      () => getAuthTokenFromState(path.join(sharedDir, "container-state", "local_device.json")),
      45000,
      "container agent auth token"
    );

    const hostToContainerValue = `host-to-container-${Date.now()}`;
    fs.writeFileSync(hostClipboardFile, hostToContainerValue, "utf8");
    await waitFor(() => {
      const current = readIfExists(containerClipboardFile);
      return current === hostToContainerValue;
    }, 30000, "host->container clipboard sync");

    const containerToHostValue = `container-to-host-${Date.now()}`;
    await runCommand(
      dockerCompose.cmd,
      [
        ...dockerCompose.prefixArgs,
        "-f",
        COMPOSE_FILE,
        "exec",
        "-T",
        "agent",
        "bash",
        "-lc",
        `printf '%s' '${containerToHostValue}' > /e2e/container-clipboard.txt`
      ],
      { cwd: REPO_ROOT, env: composeEnv }
    );
    await waitFor(() => {
      const current = readIfExists(hostClipboardFile);
      return current === containerToHostValue;
    }, 30000, "container->host clipboard sync");
  } finally {
    try {
      if (dockerCompose) {
        await runCommand(
          dockerCompose.cmd,
          [...dockerCompose.prefixArgs, "-f", COMPOSE_FILE, "down", "-v", "--remove-orphans"],
          { cwd: REPO_ROOT, env: composeEnv }
        );
      }
    } catch (_error) {}

    await stopProcess(hostAgentProcess && hostAgentProcess.child);
    await stopProcess(hubProcess && hubProcess.child);
  }

  assert.equal(1, 1);
});

test("E2E_TrustedReconnect_NoRePair", { timeout: 180000, skip: !DOCKER_COMPOSE }, async () => {
  const dockerCompose = DOCKER_COMPOSE;

  const port = await getFreePort();
  const pairCode = "654321";
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clipboard-e2e-reconnect-"));
  const sharedDir = path.join(runRoot, "shared");
  const hubCwd = path.join(runRoot, "hub-cwd");
  const hostAgentCwd = path.join(runRoot, "host-agent-cwd");
  const hubStateDir = path.join(runRoot, "hub-state");
  const hostAgentStateDir = path.join(runRoot, "host-agent-state");
  const hostClipboardFile = path.join(sharedDir, "host-clipboard.txt");
  const containerClipboardFile = path.join(sharedDir, "container-clipboard.txt");

  fs.mkdirSync(sharedDir, { recursive: true });
  fs.mkdirSync(hubCwd, { recursive: true });
  fs.mkdirSync(hostAgentCwd, { recursive: true });
  fs.mkdirSync(hubStateDir, { recursive: true });
  fs.mkdirSync(hostAgentStateDir, { recursive: true });
  fs.writeFileSync(hostClipboardFile, "", "utf8");
  fs.writeFileSync(containerClipboardFile, "", "utf8");

  let hubProcess;
  let hostAgentProcess;
  const composeEnv = {
    ...process.env
  };

  try {
    hubProcess = startProcess(
      "hub-reconnect",
      ["hub", "--port", String(port), "--bind", "0.0.0.0", "--name", "e2e-hub-reconnect"],
      {
        cwd: hubCwd,
        env: {
          ...process.env,
          CLIPBOARD_SYNC_DATA_DIR: hubStateDir,
          HUB_PAIR_CODE: pairCode,
          HUB_AUTO_APPROVE_PAIRING: "1"
        }
      }
    );

    const hubDeviceInfoPath = path.join(hubCwd, "device-info.md");
    const hubDeviceInfo = await waitFor(() => {
      const content = readIfExists(hubDeviceInfoPath);
      return content && content.includes("Certificate Fingerprint") ? content : null;
    }, 20000, "hub device-info for reconnect");

    const hubFingerprint = parseFingerprintFromMarkdown(hubDeviceInfo);
    const pairCodeFromHubInfo = parsePairCodeFromMarkdown(hubDeviceInfo);

    hostAgentProcess = startProcess(
      "host-agent-initial",
      [
        "agent",
        "--hub",
        `wss://127.0.0.1:${port}`,
        "--code",
        pairCodeFromHubInfo,
        "--name",
        "e2e-host-agent-initial",
        "--fingerprint",
        hubFingerprint,
        "--force-sync"
      ],
      {
        cwd: hostAgentCwd,
        env: {
          ...process.env,
          CLIPBOARD_SYNC_DATA_DIR: hostAgentStateDir,
          CLIPBOARD_BACKEND: "file",
          CLIPBOARD_FILE_PATH: hostClipboardFile,
          AGENT_AUTO_TRUST_FINGERPRINT: "1"
        }
      }
    );

    const hostStatePath = path.join(hostAgentStateDir, "local_device.json");
    const containerStatePath = path.join(sharedDir, "container-state", "local_device.json");
    const hostInitialToken = await waitFor(
      () => getAuthTokenFromState(hostStatePath),
      30000,
      "host agent initial auth token"
    );

    composeEnv.E2E_SHARED_DIR = sharedDir;
    composeEnv.HUB_PORT = String(port);
    composeEnv.PAIR_CODE = pairCodeFromHubInfo;
    composeEnv.HUB_FINGERPRINT = hubFingerprint;
    composeEnv.HUB_URL = `wss://host.docker.internal:${port}`;

    await runCommand(
      dockerCompose.cmd,
      [...dockerCompose.prefixArgs, "-f", COMPOSE_FILE, "up", "-d", "--remove-orphans"],
      { cwd: REPO_ROOT, env: composeEnv }
    );

    const containerInitialToken = await waitFor(
      () => getAuthTokenFromState(containerStatePath),
      45000,
      "container agent initial auth token"
    );

    // Restart both agents and do not pass pairing code. Trusted devices should reconnect
    // by auth token; if re-pair is unexpectedly required, this flow will stall and fail.
    await stopProcess(hostAgentProcess && hostAgentProcess.child);
    hostAgentProcess = null;
    await runCommand(
      dockerCompose.cmd,
      [...dockerCompose.prefixArgs, "-f", COMPOSE_FILE, "down", "--remove-orphans"],
      { cwd: REPO_ROOT, env: composeEnv }
    );

    hostAgentProcess = startProcess(
      "host-agent-restart",
      [
        "agent",
        "--hub",
        `wss://127.0.0.1:${port}`,
        "--name",
        "e2e-host-agent-restart",
        "--fingerprint",
        hubFingerprint,
        "--force-sync"
      ],
      {
        cwd: hostAgentCwd,
        env: {
          ...process.env,
          CLIPBOARD_SYNC_DATA_DIR: hostAgentStateDir,
          CLIPBOARD_BACKEND: "file",
          CLIPBOARD_FILE_PATH: hostClipboardFile,
          AGENT_AUTO_TRUST_FINGERPRINT: "1"
        }
      }
    );

    composeEnv.PAIR_CODE = "";
    await runCommand(
      dockerCompose.cmd,
      [...dockerCompose.prefixArgs, "-f", COMPOSE_FILE, "up", "-d", "--remove-orphans"],
      { cwd: REPO_ROOT, env: composeEnv }
    );

    await waitFor(() => getAuthTokenFromState(hostStatePath) === hostInitialToken, 15000, "host token reuse");
    await waitFor(
      () => getAuthTokenFromState(containerStatePath) === containerInitialToken,
      25000,
      "container token reuse"
    );

    const hostToContainerAfterRestart = `host-after-restart-${Date.now()}`;
    fs.writeFileSync(hostClipboardFile, hostToContainerAfterRestart, "utf8");
    await waitFor(() => readIfExists(containerClipboardFile) === hostToContainerAfterRestart, 30000, "host->container after restart");

    const containerToHostAfterRestart = `container-after-restart-${Date.now()}`;
    await runCommand(
      dockerCompose.cmd,
      [
        ...dockerCompose.prefixArgs,
        "-f",
        COMPOSE_FILE,
        "exec",
        "-T",
        "agent",
        "bash",
        "-lc",
        `printf '%s' '${containerToHostAfterRestart}' > /e2e/container-clipboard.txt`
      ],
      { cwd: REPO_ROOT, env: composeEnv }
    );
    await waitFor(() => readIfExists(hostClipboardFile) === containerToHostAfterRestart, 30000, "container->host after restart");
  } finally {
    try {
      if (dockerCompose) {
        await runCommand(
          dockerCompose.cmd,
          [...dockerCompose.prefixArgs, "-f", COMPOSE_FILE, "down", "-v", "--remove-orphans"],
          { cwd: REPO_ROOT, env: composeEnv }
        );
      }
    } catch (_error) {}

    await stopProcess(hostAgentProcess && hostAgentProcess.child);
    await stopProcess(hubProcess && hubProcess.child);
  }

  assert.equal(1, 1);
});
