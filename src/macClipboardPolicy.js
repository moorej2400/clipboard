const { execFile, spawn } = require("child_process");
const dns = require("dns").promises;
const os = require("os");
const path = require("path");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const DEFAULT_WINDOWS_APP_SESSION_TITLE = "";
// Preferred clipboard send sounds are Submarine and Ping. Default to Submarine for now,
// with the path kept centralized so it can be changed easily later if tastes shift.
const DEFAULT_SEND_SOUND_PATH = "/System/Library/Sounds/Submarine.aiff";
const DEFAULT_SEND_SOUND_VOLUME = "0.95";
const DEFAULT_WINDOWS_APP_DATA_DB_PATH = path.join(
  os.homedir(),
  "Library/Containers/com.microsoft.rdc.macos/Data/Library/Application Support/com.microsoft.rdc.macos/com.microsoft.rdc.application-data.sqlite"
);
const SQLITE_COLUMN_SEPARATOR = "\t";

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

const WINDOWS_APP_CORE_GRAPHICS_WINDOW_QUERY = [
  "import Foundation",
  "import CoreGraphics",
  "let options = CGWindowListOption(arrayLiteral: .optionAll)",
  "let windowInfo = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []",
  "let names = windowInfo.compactMap { row -> String? in",
  "  guard String(describing: row[kCGWindowOwnerName as String] ?? \"\") == \"Windows App\" else { return nil }",
  "  let name = String(describing: row[kCGWindowName as String] ?? \"\").trimmingCharacters(in: .whitespacesAndNewlines)",
  "  return name.isEmpty ? nil : name",
  "}",
  "let data = try! JSONSerialization.data(withJSONObject: names, options: [])",
  "FileHandle.standardOutput.write(data)"
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

async function listWindowsAppCoreGraphicsWindowTitles() {
  const { stdout } = await execFileAsync("swift", ["-e", WINDOWS_APP_CORE_GRAPHICS_WINDOW_QUERY], {
    maxBuffer: 1024 * 1024
  });

  const parsed = JSON.parse(String(stdout || "[]").trim() || "[]");
  if (!Array.isArray(parsed)) {
    throw new Error("Windows App CoreGraphics query returned a non-array payload");
  }

  return parsed.map((value) => String(value || "").trim());
}

function buildAfplayArgs(soundPath = DEFAULT_SEND_SOUND_PATH, volume = DEFAULT_SEND_SOUND_VOLUME) {
  return ["-v", String(volume), soundPath];
}

async function playMacSendSound(soundPath = DEFAULT_SEND_SOUND_PATH, volume = DEFAULT_SEND_SOUND_VOLUME) {
  await new Promise((resolve, reject) => {
    const child = spawn("afplay", buildAfplayArgs(soundPath, volume), {
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function dedupeNonEmptyStrings(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter((value) => value.length > 0)
    )
  );
}

function isTruthyEnvValue(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function getWindowsAppSessionTitleFromEnv(env = process.env) {
  return String(env.MAC_WINDOWS_APP_PC_NAME || env.MAC_WINDOWS_APP_SESSION_TITLE || "").trim();
}

async function getBookmarkedHostsForSession(
  sessionTitle,
  dbPath = process.env.MAC_WINDOWS_APP_DATA_DB_PATH || DEFAULT_WINDOWS_APP_DATA_DB_PATH
) {
  const sql = [
    "SELECT ZFRIENDLYNAME, ZHOSTNAME",
    "FROM ZBOOKMARKENTITY",
    "WHERE ZHOSTNAME IS NOT NULL",
    "AND TRIM(ZHOSTNAME) != ''",
    "ORDER BY ZLASTCONNECTED DESC",
    ";"
  ].join(" ");

  const { stdout } = await execFileAsync("sqlite3", ["-noheader", "-separator", SQLITE_COLUMN_SEPARATOR, dbPath, sql], {
    maxBuffer: 1024 * 1024
  });

  const rows = String(stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [friendlyName = "", host = ""] = line.split(SQLITE_COLUMN_SEPARATOR);
      return {
        friendlyName: String(friendlyName || "").trim(),
        host: String(host || "").trim()
      };
    })
    .filter((row) => row.host.length > 0);

  const normalizedSessionTitle = String(sessionTitle || "").trim();
  const exactHosts = dedupeNonEmptyStrings(
    rows.filter((row) => row.friendlyName === normalizedSessionTitle).map((row) => row.host)
  );
  if (exactHosts.length > 0) {
    return exactHosts;
  }

  return dedupeNonEmptyStrings(rows.map((row) => row.host));
}

async function getBookmarkedHostForSession(
  sessionTitle,
  dbPath = process.env.MAC_WINDOWS_APP_DATA_DB_PATH || DEFAULT_WINDOWS_APP_DATA_DB_PATH
) {
  const hosts = await getBookmarkedHostsForSession(sessionTitle, dbPath);
  return hosts[0] || null;
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

function isMatchingSessionWindowTitle(title, sessionTitle = DEFAULT_WINDOWS_APP_SESSION_TITLE) {
  const normalizedTitle = String(title || "").trim().toLowerCase();
  const normalizedSessionTitle = String(sessionTitle || "").trim().toLowerCase();

  if (normalizedTitle.length === 0 || normalizedSessionTitle.length === 0) {
    return false;
  }

  if (normalizedTitle.includes(normalizedSessionTitle)) {
    return true;
  }

  const sessionTokens = normalizedSessionTitle
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);

  return sessionTokens.some((token) => normalizedTitle.includes(token));
}

async function defaultLookupHostAddresses(host) {
  const records = await dns.lookup(host, { all: true });
  return records.map((record) => String(record.address || "").trim()).filter((address) => address.length > 0);
}

async function listActiveWindowsAppRdpConnections() {
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("lsof", ["-Pan", "-c", "Windows", "-iTCP", "-sTCP:ESTABLISHED"], {
      maxBuffer: 1024 * 1024
    }));
  } catch (error) {
    if (error && error.code === 1) {
      return [];
    }
    throw error;
  }

  return String(stdout || "")
    .split("\n")
    .slice(1)
    .map(parseLsofRemoteEndpoint)
    .filter(Boolean);
}

function createMacClipboardPolicy(options = {}) {
  const env = options.env || process.env;
  const {
    platform = process.platform,
    sessionTitle = getWindowsAppSessionTitleFromEnv(env) || DEFAULT_WINDOWS_APP_SESSION_TITLE,
    forceSync = isTruthyEnvValue(env.MAC_CLIPBOARD_FORCE_SYNC),
    getWindowTitles = listWindowsAppWindowTitles,
    getCoreGraphicsWindowTitles = listWindowsAppCoreGraphicsWindowTitles,
    getBookmarkedHosts = (title) => getBookmarkedHostsForSession(title),
    getBookmarkedHost = (title) => getBookmarkedHostForSession(title),
    listActiveRdpConnections = listActiveWindowsAppRdpConnections,
    lookupHostAddresses = defaultLookupHostAddresses,
    playSendSound = () =>
      playMacSendSound(
        env.MAC_CLIPBOARD_SEND_SOUND_PATH || DEFAULT_SEND_SOUND_PATH,
        env.MAC_CLIPBOARD_SEND_VOLUME || DEFAULT_SEND_SOUND_VOLUME
      )
  } = options;
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

      if (forceSync) {
        return {
          allowed: true,
          reason: "force_sync"
        };
      }

      let windowQueryError = null;
      let observedWindowTitles = [];
      try {
        const windowTitles = await getWindowTitles();
        observedWindowTitles = windowTitles.filter((title) => title.length > 0);
        const matchedTitle = windowTitles.find((title) => isMatchingSessionWindowTitle(title, sessionTitle));

        if (matchedTitle) {
          return {
            allowed: true,
            reason: "session_window_open",
            matchedTitle
          };
        }

        // System Events can report zero Windows App windows even while the RDP
        // surface is visible. CoreGraphics still exposes the rendered title.
        const coreGraphicsWindowTitles = await getCoreGraphicsWindowTitles();
        observedWindowTitles = dedupeNonEmptyStrings([...observedWindowTitles, ...coreGraphicsWindowTitles]);
        const matchedCoreGraphicsTitle = coreGraphicsWindowTitles.find((title) =>
          isMatchingSessionWindowTitle(title, sessionTitle)
        );

        if (matchedCoreGraphicsTitle) {
          return {
            allowed: true,
            reason: "session_window_open",
            matchedTitle: matchedCoreGraphicsTitle
          };
        }
      } catch (error) {
        windowQueryError = String(error && error.message ? error.message : error);
      }

      try {
        let bookmarkedHosts = [];
        if (typeof getBookmarkedHosts === "function") {
          bookmarkedHosts = dedupeNonEmptyStrings(await getBookmarkedHosts(sessionTitle));
        } else {
          const bookmarkedHost = await getBookmarkedHost(sessionTitle);
          bookmarkedHosts = bookmarkedHost ? [bookmarkedHost] : [];
        }

        if (bookmarkedHosts.length > 0) {
          const activeConnections = await listActiveRdpConnections();
          let expectedHosts = [];
          for (const bookmarkedHost of bookmarkedHosts) {
            expectedHosts.push(bookmarkedHost);
            try {
              expectedHosts.push(...(await lookupHostAddresses(bookmarkedHost)));
            } catch (_error) {
              // Keep the literal bookmark host when DNS lookup fails.
            }
          }
          expectedHosts = dedupeNonEmptyStrings(expectedHosts);
          const matchedConnection = activeConnections.find(
            (connection) => expectedHosts.includes(connection.remoteHost) && connection.remotePort === 3389
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
            expectedHosts,
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
  buildAfplayArgs,
  DEFAULT_WINDOWS_APP_DATA_DB_PATH,
  DEFAULT_WINDOWS_APP_SESSION_TITLE,
  DEFAULT_SEND_SOUND_VOLUME,
  createMacClipboardPolicy,
  getWindowsAppSessionTitleFromEnv,
  getBookmarkedHostsForSession,
  getBookmarkedHostForSession,
  lookupHostAddresses: defaultLookupHostAddresses,
  listActiveWindowsAppRdpConnections,
  listWindowsAppCoreGraphicsWindowTitles,
  listWindowsAppWindowTitles,
  parseLsofRemoteEndpoint,
  playMacSendSound
};
