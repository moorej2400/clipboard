const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { parseCli, loadLocalDevice } = require("../../src/index");

test("parseCli accepts bare start flags without requiring a mode", () => {
  const result = parseCli(["--name", "Configured Device"]);

  assert.equal(result.mode, null);
  assert.deepEqual(result.options, {
    name: "Configured Device"
  });
});

test("loadLocalDevice preserves persisted startup role and hub settings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipboard-sync-index-test-"));
  const localDevicePath = path.join(tempDir, "local_device.json");

  fs.writeFileSync(
    localDevicePath,
    JSON.stringify({
      deviceId: "device-123",
      deviceName: "Existing Device",
      authToken: "auth-token",
      hubUrl: "wss://127.0.0.1:4242",
      hubFingerprint: "AA:BB",
      role: "hub",
      hubPort: 4545,
      hubBindAddress: "127.0.0.1"
    }),
    "utf8"
  );

  const localDevice = loadLocalDevice({ localDevice: localDevicePath }, null);

  assert.equal(localDevice.deviceId, "device-123");
  assert.equal(localDevice.deviceName, "Existing Device");
  assert.equal(localDevice.authToken, "auth-token");
  assert.equal(localDevice.hubUrl, "wss://127.0.0.1:4242");
  assert.equal(localDevice.hubFingerprint, "AA:BB");
  assert.equal(localDevice.role, "hub");
  assert.equal(localDevice.hubPort, 4545);
  assert.equal(localDevice.hubBindAddress, "127.0.0.1");
});

test("loadLocalDevice infers hub role from existing hub state files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipboard-sync-index-test-"));
  const localDevicePath = path.join(tempDir, "local_device.json");
  const trustedDevicesPath = path.join(tempDir, "trusted_devices.json");
  const tlsKeyPath = path.join(tempDir, "tls-key.pem");
  const tlsCertPath = path.join(tempDir, "tls-cert.pem");

  fs.writeFileSync(
    localDevicePath,
    JSON.stringify({
      deviceId: "device-123",
      deviceName: "Existing Device",
      role: null
    }),
    "utf8"
  );
  fs.writeFileSync(trustedDevicesPath, JSON.stringify({ trustedDevices: [] }), "utf8");
  fs.writeFileSync(tlsKeyPath, "key", "utf8");
  fs.writeFileSync(tlsCertPath, "cert", "utf8");

  const localDevice = loadLocalDevice(
    {
      localDevice: localDevicePath,
      trustedDevices: trustedDevicesPath,
      tlsKey: tlsKeyPath,
      tlsCert: tlsCertPath
    },
    null
  );

  assert.equal(localDevice.role, "hub");
});

test("loadLocalDevice infers agent role from existing hub connection state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipboard-sync-index-test-"));
  const localDevicePath = path.join(tempDir, "local_device.json");

  fs.writeFileSync(
    localDevicePath,
    JSON.stringify({
      deviceId: "device-123",
      deviceName: "Existing Device",
      hubUrl: "wss://example.local:4242",
      hubFingerprint: "AA:BB",
      authToken: "auth-token",
      role: null
    }),
    "utf8"
  );

  const localDevice = loadLocalDevice(
    {
      localDevice: localDevicePath,
      trustedDevices: path.join(tempDir, "trusted_devices.json"),
      tlsKey: path.join(tempDir, "tls-key.pem"),
      tlsCert: path.join(tempDir, "tls-cert.pem")
    },
    null
  );

  assert.equal(localDevice.role, "agent");
});
