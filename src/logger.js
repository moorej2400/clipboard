const fs = require("fs");
const path = require("path");

function createLogger(baseDir) {
  const defaultLogPath = path.join(baseDir, "clipboard-events.log");
  const filePath = process.env.CLIPBOARD_LOG_PATH || defaultLogPath;

  function write(level, event, data = {}) {
    const record = {
      ts: new Date().toISOString(),
      level,
      event,
      pid: process.pid,
      ...data
    };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
    } catch (error) {
      const fallback = `[clipboard-sync logger failure] ${error.message}`;
      if (level === "error") {
        console.error(fallback);
      } else {
        console.log(fallback);
      }
    }
  }

  return {
    path: filePath,
    info: (event, data) => write("info", event, data),
    warn: (event, data) => write("warn", event, data),
    error: (event, data) => write("error", event, data)
  };
}

module.exports = {
  createLogger
};
