const fs = require("fs");
const path = require("path");

let clipboardyPromise;

function getClipboardBackend() {
  return process.env.CLIPBOARD_BACKEND === "file" ? "file" : "system";
}

function getClipboardFilePath() {
  const filePath = process.env.CLIPBOARD_FILE_PATH;
  if (!filePath) {
    throw new Error("CLIPBOARD_FILE_PATH is required when CLIPBOARD_BACKEND=file");
  }
  return filePath;
}

async function getClipboardy() {
  if (!clipboardyPromise) {
    clipboardyPromise = import("clipboardy");
  }
  const module = await clipboardyPromise;
  return module.default || module;
}

async function readClipboardText() {
  if (getClipboardBackend() === "file") {
    const filePath = getClipboardFilePath();
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  const clipboardy = await getClipboardy();
  try {
    return await clipboardy.read();
  } catch (error) {
    const message = String((error && error.message) || error || "");
    if (process.platform === "win32" && /Element not found/i.test(message)) {
      return "";
    }
    throw error;
  }
}

async function writeClipboardText(text) {
  if (getClipboardBackend() === "file") {
    const filePath = getClipboardFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text, "utf8");
    return;
  }

  const clipboardy = await getClipboardy();
  return clipboardy.write(text);
}

module.exports = {
  readClipboardText,
  writeClipboardText
};
