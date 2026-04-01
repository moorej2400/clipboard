const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildAfplayArgs,
  createMacClipboardPolicy,
  DEFAULT_WINDOWS_APP_SESSION_TITLE
} = require("../../src/macClipboardPolicy");

test("mac clipboard policy builds afplay args with the default 95 percent volume", () => {
  assert.deepEqual(buildAfplayArgs("/System/Library/Sounds/Submarine.aiff"), [
    "-v",
    "0.95",
    "/System/Library/Sounds/Submarine.aiff"
  ]);
});

test("mac clipboard policy allows outbound sync on non-mac platforms without checking Windows App", async () => {
  let getWindowTitlesCalled = false;
  const policy = createMacClipboardPolicy({
    platform: "linux",
    getWindowTitles: async () => {
      getWindowTitlesCalled = true;
      return [];
    }
  });

  const result = await policy.shouldAllowOutboundSync();

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "unsupported_platform");
  assert.equal(getWindowTitlesCalled, false);
});

test("mac clipboard policy allows outbound sync when Windows App has the configured session window open", async () => {
  const policy = createMacClipboardPolicy({
    platform: "darwin",
    sessionTitle: DEFAULT_WINDOWS_APP_SESSION_TITLE,
    getWindowTitles: async () => ["", "Remote PC"]
  });

  const result = await policy.shouldAllowOutboundSync();

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "session_window_open");
  assert.equal(result.matchedTitle, "Remote PC");
});

test("mac clipboard policy allows outbound sync when a Windows App window title contains the configured session token", async () => {
  const policy = createMacClipboardPolicy({
    platform: "darwin",
    sessionTitle: "Finance Desktop",
    getWindowTitles: async () => ["", "Training VM - Finance East"]
  });

  const result = await policy.shouldAllowOutboundSync();

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "session_window_open");
  assert.equal(result.matchedTitle, "Training VM - Finance East");
});

test("mac clipboard policy blocks outbound sync when Windows App session window is not open", async () => {
  const policy = createMacClipboardPolicy({
    platform: "darwin",
    sessionTitle: DEFAULT_WINDOWS_APP_SESSION_TITLE,
    getWindowTitles: async () => ["", "Another PC"],
    getBookmarkedHost: async () => null,
    listActiveRdpConnections: async () => []
  });

  const result = await policy.shouldAllowOutboundSync();

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "session_window_missing");
});

test("mac clipboard policy blocks outbound sync when window detection fails", async () => {
  const policy = createMacClipboardPolicy({
    platform: "darwin",
    sessionTitle: DEFAULT_WINDOWS_APP_SESSION_TITLE,
    getWindowTitles: async () => {
      throw new Error("Automation not permitted");
    },
    getBookmarkedHosts: async () => [],
    getBookmarkedHost: async () => null,
    listActiveRdpConnections: async () => []
  });

  const result = await policy.shouldAllowOutboundSync();

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "window_query_failed");
  assert.match(result.error, /Automation not permitted/);
});

test("mac clipboard policy allows outbound sync when the configured bookmark host has an active RDP connection", async () => {
  const policy = createMacClipboardPolicy({
    platform: "darwin",
    sessionTitle: DEFAULT_WINDOWS_APP_SESSION_TITLE,
    getWindowTitles: async () => [],
    getBookmarkedHosts: async () => ["192.0.2.23"],
    getBookmarkedHost: async () => "192.0.2.23",
    listActiveRdpConnections: async () => [{ remoteHost: "192.0.2.23", remotePort: 3389 }]
  });

  const result = await policy.shouldAllowOutboundSync();

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "active_rdp_connection");
  assert.equal(result.remoteHost, "192.0.2.23");
});

test("mac clipboard policy allows outbound sync when the bookmark host resolves to the active RDP connection IP", async () => {
  const policy = createMacClipboardPolicy({
    platform: "darwin",
    sessionTitle: DEFAULT_WINDOWS_APP_SESSION_TITLE,
    getWindowTitles: async () => ["Devices"],
    getBookmarkedHost: async () => "remote-pc.example.test",
    listActiveRdpConnections: async () => [{ remoteHost: "198.51.100.208", remotePort: 3389 }],
    lookupHostAddresses: async () => ["198.51.100.208"]
  });

  const result = await policy.shouldAllowOutboundSync();

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "active_rdp_connection");
  assert.equal(result.remoteHost, "198.51.100.208");
});

test("mac clipboard policy allows outbound sync when a bookmark variant resolves to the active RDP connection", async () => {
  const policy = createMacClipboardPolicy({
    platform: "darwin",
    sessionTitle: DEFAULT_WINDOWS_APP_SESSION_TITLE,
    getWindowTitles: async () => [],
    getBookmarkedHost: async () => null,
    getBookmarkedHosts: async () => ["remote-pc.example.test", "192.0.2.23"],
    listActiveRdpConnections: async () => [{ remoteHost: "198.51.100.208", remotePort: 3389 }],
    lookupHostAddresses: async (host) => (host === "remote-pc.example.test" ? ["198.51.100.208"] : [])
  });

  const result = await policy.shouldAllowOutboundSync();

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "active_rdp_connection");
  assert.equal(result.remoteHost, "198.51.100.208");
});

test("mac clipboard policy plays a send sound only on macOS", async () => {
  let macPlayCount = 0;
  let linuxPlayCount = 0;

  const macPolicy = createMacClipboardPolicy({
    platform: "darwin",
    playSendSound: async () => {
      macPlayCount += 1;
    }
  });
  const linuxPolicy = createMacClipboardPolicy({
    platform: "linux",
    playSendSound: async () => {
      linuxPlayCount += 1;
    }
  });

  await macPolicy.notifyOutboundSyncSent();
  await linuxPolicy.notifyOutboundSyncSent();

  assert.equal(macPlayCount, 1);
  assert.equal(linuxPlayCount, 0);
});
