const { execFile, spawn } = require("child_process");
const os = require("os");
const path = require("path");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const DEFAULT_WINDOWS_APP_SESSION_TITLE = "Solera PC";
const DEFAULT_SEND_SOUND_PATH = "/System/Library/Sounds/Glass.aiff";
const DEFAULT_WINDOWS_APP_DATA_DB_PATH = path.join(
  os.homedir(),
  "Library/Containers/com.microsoft.rdc.macos/Data/Library/Application Support/com.microsoft.rdc.macos/com.microsoft.rdc.application-data.sqlite"
);

const WINDOWS_APP_WINDOW_QUERY = [
  "const se = Application('System Events');",
  "se.includeStandardAdditions = true;",
  "const proc = se.applicationProcesses.byName('Windows App');",
  "const names = [];",
  "const windows = proc.windows();",
  "for (let i = 0; i < windows.length; i += 1) {",
  "  try {",
  "    names.push(String(windows[i].name()));",
  "  } catch (_error) {",
  "    names.push('');",
  "  }",
  "}",
  "JSON.stringify(names);"
].join("\n");

async function listWindowsAppWindowTitles() {
  const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", WINDOWS_APP_WINDOW_QUERY], {
    maxBuffer: 1024 * 1024
  });

  const parsed = JSON.parse(String(stdout || "[]").trim() || "[]");
  if (!Array.isArray(parsed)) {
    throw new Error("Windows App window query returned a non-array payload");
  }

  return parsed.map((value) => String(value || "").trim());
}

async function playMacSendSound(soundPath = DEFAULT_SEND_SOUND_PATH) {
  await new Promise((resolve, reject) => {
    const child = spawn("afplay", [soundPath], {
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function getBookmarkedHostForSession(
  sessionTitle,
  dbPath = process.env.MAC_WINDOWS_APP_DATA_DB_PATH || DEFAULT_WINDOWS_APP_DATA_DB_PATH
) {
  const escapedSessionTitle = String(sessionTitle || "").replace(/'/g, "''");
  const sql = [
    "SELECT ZHOSTNAME",
    "FROM ZBOOKMARKENTITY",
    `WHERE ZFRIENDLYNAME = '${escapedSessionTitle}'`,
    "ORDER BY ZLASTCONNECTED DESC",
    "LIMIT 1;"
  ].join(" ");

  const { stdout } = await execFileAsync("sqlite3", ["-noheader", dbPath, sql], {
    maxBuffer: 1024 * 1024
  });
  const host = String(stdout || "").trim();
  return host || null;
}

function parseLsofRemoteEndpoint(line) {
  const match = String(line || "").match(/->([^:]+):(\d+)\s+\(ESTABLISHED\)/);
  if (!match) {
    return null;
  }

  return {
    remoteHost: match[1],
    remotePort: Number(match[2])
  };
}

async function listActiveWindowsAppRdpConnections() {
  const { stdout } = await execFileAsync("lsof", ["-Pan", "-c", "Windows", "-iTCP", "-sTCP:ESTABLISHED"], {
    maxBuffer: 1024 * 1024
  });

  return String(stdout || "")
    .split("\n")
    .slice(1)
    .map(parseLsofRemoteEndpoint)
    .filter(Boolean);
}

function createMacClipboardPolicy({
  platform = process.platform,
  sessionTitle = process.env.MAC_WINDOWS_APP_SESSION_TITLE || DEFAULT_WINDOWS_APP_SESSION_TITLE,
  getWindowTitles = listWindowsAppWindowTitles,
  getBookmarkedHost = (title) => getBookmarkedHostForSession(title),
  listActiveRdpConnections = listActiveWindowsAppRdpConnections,
  playSendSound = () => playMacSendSound(process.env.MAC_CLIPBOARD_SEND_SOUND_PATH || DEFAULT_SEND_SOUND_PATH)
} = {}) {
  const enabled = platform === "darwin";

  return {
    isEnabled() {
      return enabled;
    },

    getSessionTitle() {
      return sessionTitle;
    },

    async shouldAllowOutboundSync() {
      if (!enabled) {
        return {
          allowed: true,
          reason: "unsupported_platform"
        };
      }

      let windowQueryError = null;
      let observedWindowTitles = [];
      try {
        const windowTitles = await getWindowTitles();
        observedWindowTitles = windowTitles.filter((title) => title.length > 0);
        const matchedTitle = windowTitles.find((title) => title === sessionTitle);

        if (matchedTitle) {
          return {
            allowed: true,
            reason: "session_window_open",
            matchedTitle
          };
        }
      } catch (error) {
        windowQueryError = String(error && error.message ? error.message : error);
      }

      try {
        const bookmarkedHost = await getBookmarkedHost(sessionTitle);
        if (bookmarkedHost) {
          const activeConnections = await listActiveRdpConnections();
          const matchedConnection = activeConnections.find(
            (connection) => connection.remoteHost === bookmarkedHost && connection.remotePort === 3389
          );

          if (matchedConnection) {
            return {
              allowed: true,
              reason: "active_rdp_connection",
              remoteHost: matchedConnection.remoteHost,
              remotePort: matchedConnection.remotePort
            };
          }

          return {
            allowed: false,
            reason: "session_window_missing",
            expectedTitle: sessionTitle,
            expectedHost: bookmarkedHost,
            activeConnections,
            observedWindowTitles
          };
        }
      } catch (error) {
        if (!windowQueryError) {
          windowQueryError = String(error && error.message ? error.message : error);
        }
      }

      return {
        allowed: false,
        reason: windowQueryError ? "window_query_failed" : "session_window_missing",
        expectedTitle: sessionTitle,
        ...(observedWindowTitles.length > 0 ? { observedWindowTitles } : {}),
        ...(windowQueryError ? { error: windowQueryError } : {})
      };
    },

    async notifyOutboundSyncSent() {
      if (!enabled) {
        return false;
      }

      await playSendSound();
      return true;
    }
  };
}

module.exports = {
  DEFAULT_WINDOWS_APP_DATA_DB_PATH,
  DEFAULT_WINDOWS_APP_SESSION_TITLE,
  createMacClipboardPolicy,
  getBookmarkedHostForSession,
  listActiveWindowsAppRdpConnections,
  listWindowsAppWindowTitles,
  parseLsofRemoteEndpoint,
  playMacSendSound
};
