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

function classifyWindowsClipboardReadFailure(message) {
  const normalized = String(message || "");
  if (/Element not found/i.test(normalized)) {
    return "element_not_found";
  }
  if (/The operation completed successfully/i.test(normalized)) {
    return "operation_completed_successfully_bug";
  }
  if (/Could not paste from clipboard/i.test(normalized) && /code:\s*0/i.test(normalized)) {
    return "paste_failed_code_0";
  }
  if (/Could not paste from clipboard/i.test(normalized) && /code:\s*1168/i.test(normalized)) {
    return "paste_failed_code_1168";
  }
  return null;
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
    if (process.platform === "win32") {
      const reason = classifyWindowsClipboardReadFailure(message);
      if (reason) {
        error.clipboardTransient = true;
        error.clipboardReason = reason;
      }
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
