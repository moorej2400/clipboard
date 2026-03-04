const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_FOLDER = "clipboard-sync";

function getAppDataDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_FOLDER);
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, APP_FOLDER);
  }
  return path.join(os.homedir(), ".config", APP_FOLDER);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function getPaths() {
  const baseDir = ensureDir(getAppDataDir());
  return {
    baseDir,
    localDevice: path.join(baseDir, "local_device.json"),
    trustedDevices: path.join(baseDir, "trusted_devices.json"),
    tlsKey: path.join(baseDir, "tls-key.pem"),
    tlsCert: path.join(baseDir, "tls-cert.pem")
  };
}

function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallbackValue;
    }
    throw error;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

module.exports = {
  getPaths,
  readJson,
  writeJson
};
