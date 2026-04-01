<proposed_plan>
# Bare-Bones Node Clipboard Sync (macOS + Windows)

## High-Level Overview
- **Language/Runtime:** JavaScript on **Node LTS** using **CommonJS**.
- **What the system does:** Each machine runs a tiny Node process that syncs **text clipboard** content through a local-network WebSocket hub. A trusted-device pairing flow (pairing code + explicit approval) ensures only authorized devices can receive clipboard events.
- **Scope:** Minimal CLI, no UI, no browser code, no unnecessary features.

## Summary
1. Build one Node app that can run in `hub` mode or `agent` mode.
2. Hub listens on LAN (`0.0.0.0`) over `wss` with a self-signed cert, manages pairing/trust, and relays clipboard events.
3. Agents poll local clipboard every `500ms`, publish local changes, and apply incoming trusted updates.
4. Startup writes a human-readable Markdown file with device identity and pairing details.
5. Security is app-level (pairing code + trusted device allowlist in local JSON).

## Architecture and Data Flow
1. **Hub role**
- Opens WebSocket server on default port `4242`.
- Generates startup pairing code (6 digits) and rotates it each launch.
- Maintains `trusted_devices.json` (device allowlist + long-lived auth token metadata).
- Accepts `pair_request` only when pairing code matches and user approves in CLI.
- Relays `clipboard_event` to all trusted connected agents except sender.

2. **Agent role**
- Connects to hub URL (manual `wss://HOST:4242`).
- If already trusted, authenticates using stored token.
- If untrusted, submits pairing code and waits for approval.
- Polls clipboard every `500ms`; on local change sends `clipboard_event`.
- On incoming event, updates local clipboard and suppresses rebroadcast briefly.

3. **Loop and conflict behavior**
- **Conflict policy:** Last-write-wins via event timestamp.
- **Loop guard:** Event ID dedupe + short suppression window after remote write.
- Each event contains `eventId`, `originDeviceId`, `timestamp`, and `text`.

## Planned File/Module Layout
1. `package.json`
- Scripts: `start:hub`, `start:agent`.
- Deps: `ws`, `clipboardy`.

2. `src/index.js`
- CLI entrypoint, mode dispatch, config loading, startup markdown generation.

3. `src/hub.js`
- WebSocket server, pairing/approval flow, trusted device session management, relay logic.

4. `src/agent.js`
- Hub connection, auth/pairing handshake, clipboard polling, remote apply logic.

5. `src/clipboard.js`
- Clipboard read/write wrapper (`clipboardy`) and change detection helpers.

6. `src/store.js`
- Local JSON persistence helpers for trusted devices and local identity/token.

7. `src/protocol.js`
- Message type constants, payload validation, shared event helpers.

8. `device-info.md` (generated at startup)
- Device name, device ID, current pairing code (hub), connection instructions.

9. OS-specific app data paths for JSON state
- macOS: `~/Library/Application Support/clipboard-sync/`
- Windows: `%APPDATA%/clipboard-sync/`

## Public Interfaces and Types
1. **CLI commands**
- `node src/index.js hub --port 4242 --name "<device-name>"`
- `node src/index.js agent --hub wss://192.0.2.10:4242 --code 123456 --name "<device-name>"`

2. **Config/state files**
- `trusted_devices.json` (hub):
```json
{
  "trustedDevices": [
    {
      "deviceId": "string",
      "deviceName": "string",
      "authTokenHash": "string",
      "approvedAt": "iso8601"
    }
  ]
}
```
- `local_device.json` (agent/hub local identity):
```json
{
  "deviceId": "string",
  "deviceName": "string",
  "authToken": "string|null",
  "hubUrl": "string|null"
}
```

3. **WebSocket message schema**
- `hello`:
```json
{ "type": "hello", "deviceId": "string", "deviceName": "string", "authToken": "string|null" }
```
- `pair_request`:
```json
{ "type": "pair_request", "deviceId": "string", "deviceName": "string", "pairCode": "string" }
```
- `pair_result`:
```json
{ "type": "pair_result", "ok": true, "authToken": "string" }
```
- `clipboard_event`:
```json
{
  "type": "clipboard_event",
  "eventId": "uuid",
  "originDeviceId": "string",
  "timestamp": 1700000000000,
  "text": "string"
}
```

## Security and Authorization Rules
1. Pair code is required for first-time trust and is regenerated on each hub startup.
2. Pairing requires explicit CLI approval on hub (`approve y/n`) before trust is persisted.
3. Only trusted devices may publish/receive clipboard events.
4. Auth tokens are stored hashed on hub; plaintext token only on the owning device.
5. Transport uses `wss` with a self-signed certificate for encrypted LAN traffic in v1.

## Commenting Strategy in Code
1. Add concise comments only where intent is non-obvious:
- Why pairing requires both code and explicit approval.
- Why suppression window exists after remote clipboard apply.
- Why dedupe uses `eventId` plus timestamp fallback.
2. Avoid comments that only restate line-by-line mechanics.

## Test Cases and Acceptance Scenarios
1. **Startup metadata**
- Hub startup creates/rewrites `device-info.md` with device name/ID/pairing code.
- Agent startup creates/rewrites `device-info.md` with device name/ID/hub target.

2. **Pairing and trust**
- Untrusted agent with correct code + approved on hub becomes trusted and reconnects with token.
- Untrusted agent with wrong code is rejected.
- Trusted device reconnects after restart without re-approval.

3. **Clipboard sync**
- Copy text on macOS agent appears on Windows agent through hub.
- Copy text on Windows agent appears on macOS agent.
- Multiple trusted agents all receive updates.

4. **Loop/conflict**
- Remote-applied clipboard does not immediately rebroadcast (loop prevented).
- Near-simultaneous copies resolve to newest timestamp (last-write-wins).

5. **Failure handling**
- Hub unavailable: agent retries with backoff and logs concise reason.
- Malformed messages are ignored and logged without process crash.

## Assumptions and Defaults Chosen
1. Greenfield repo (currently empty).
2. Node LTS + CommonJS.
3. Text-only clipboard sync.
4. One hub + many agents topology.
5. Manual hub address entry (`wss://HOST:4242`) plus pairing code.
6. Polling interval `500ms`.
7. LAN bind `0.0.0.0`.
8. Local JSON for trust persistence.
9. `WSS` self-signed transport for v1.
</proposed_plan>
