let clipboardyPromise;

async function getClipboardy() {
  if (!clipboardyPromise) {
    clipboardyPromise = import("clipboardy");
  }
  const module = await clipboardyPromise;
  return module.default || module;
}

async function readClipboardText() {
  const clipboardy = await getClipboardy();
  return clipboardy.read();
}

async function writeClipboardText(text) {
  const clipboardy = await getClipboardy();
  return clipboardy.write(text);
}

module.exports = {
  readClipboardText,
  writeClipboardText
};
