# Clipboard Sync

Minimal, local-network clipboard sync for macOS and Windows using Node.js.

The project is intentionally bare-bones:
- Text clipboard only
- One hub device plus many agent devices
- Pairing-based trust controls
- Encrypted LAN transport via `WSS` (self-signed certificate)

## Overview

`clipboard-sync` keeps text clipboards synchronized between trusted machines on the same network.

Each device runs the same app in one of two modes:
- `hub`: accepts trusted device connections and relays clipboard events
- `agent`: watches local clipboard changes and syncs with hub

Once devices are paired, copy operations on one trusted machine propagate to other trusted machines.

## How It Works

1. Hub starts on `0.0.0.0:4242` and generates a session pairing code.
2. Hub creates or reuses a self-signed TLS certificate and exposes a fingerprint.
3. Agent connects to `wss://<hub-ip>:4242`, verifies or trusts the fingerprint, then authenticates.
4. First-time agents submit pairing code and require explicit approval at the hub terminal.
5. Trusted agents send clipboard events when local text changes.
6. Hub relays events to other trusted agents, which update their local clipboard.

## Security Model

- Transport encryption: `WSS` with self-signed cert
- Device trust: pairing code plus explicit hub-side approval
- Session recovery: trusted devices use persistent auth tokens
- Token handling: hub stores token hashes, not raw tokens
- MITM protection: agent pins hub certificate fingerprint after trust

## Project Layout

```text
src/
  index.js       CLI entrypoint and startup flow
  hub.js         WSS hub server, pairing, trust, relay
  agent.js       Hub client, clipboard polling, remote apply
  macwhisper.js  macOS MacWhisper dictation polling source
  clipboard.js   Clipboard read/write wrapper
  protocol.js    Message schema helpers
  store.js       Local JSON persistence helpers
```

## MacWhisper Dictation Sync (macOS)

When running in `agent` mode on macOS, the app auto-detects local MacWhisper dictations at:

`~/Library/Application Support/MacWhisper/Database/main.sqlite`

If found, the agent polls for newly created dictations and:
- writes the new dictation text to local clipboard immediately
- emits a normal `clipboard_event` so trusted peers receive it

Behavior details:
- Local MacWhisper path only (iCloud mirror is not used)
- Future-only on startup (existing historical dictations are not replayed)
- Text preference: `processedText` fallback to `transcribedText`
- Offline-safe: latest new dictation is queued and broadcast after reconnect

## Getting Started

### 1) Install dependencies

```bash
npm install
```

### 2) Start the hub machine

```bash
npm run start:hub
```

Hub startup:
- Prints the current pairing code
- Prints/listens on LAN endpoint(s)
- Persists `wss://127.0.0.1:4242` for the hub machine itself so local restarts stay attached
- Generates `device-info.md` with connection and fingerprint details

### 3) Start agent machine(s)

```bash
npm run start:agent -- --hub wss://<hub-ip>:4242 --code <pair-code> --fingerprint "<fingerprint>"
```

If the agent runs on the same machine as the hub, prefer:

```bash
npm run start:agent -- --hub wss://127.0.0.1:4242 --code <pair-code> --fingerprint "<fingerprint>"
```

On first join:
- Confirm the fingerprint trust prompt on agent
- Approve the device on hub with `y`

After approval, the device remains trusted across restarts.

## Runtime Files

The app stores identity/trust state in OS app-data locations:
- macOS: `~/Library/Application Support/clipboard-sync/`
- Windows: `%APPDATA%/clipboard-sync/`

Common files:
- `local_device.json`
- `trusted_devices.json` (hub)
- `tls-key.pem` and `tls-cert.pem` (hub)

## Windows Startup Task (Recommended)

For reliable clipboard sync on Windows, run the agent in the interactive user session at logon.

Create script (once):
```bat
@echo off
setlocal
cd /d C:\Users\Jared.Moore\Dev\repos\apps\clipboard
set AGENT_AUTO_TRUST_FINGERPRINT=1
"C:\Program Files\nodejs\node.exe" src\index.js agent --hub wss://<hub-ip>:4242 --fingerprint "C1:B1:93:42:01:25:30:A6:CC:08:37:4F:59:92:C9:72:C6:7F:95:21:FD:06:83:8B:FF:59:DF:38:BC:F4:AD:F1" >> "%USERPROFILE%\clipboard-agent.log" 2>&1
endlocal
```

Replace `<hub-ip>` with the current LAN endpoint shown in `device-info.md` on the hub machine.

Create startup task:
```bat
schtasks /Create /TN "ClipboardSyncAgent" /TR "cmd.exe /c \"C:\Users\Jared.Moore\Dev\repos\apps\clipboard\scripts\start-agent.cmd\"" /SC ONLOGON /RU "INT\jared.moore" /RL HIGHEST /IT /F
```

Run immediately:
```bat
schtasks /Run /TN "ClipboardSyncAgent"
```

Verify:
```bat
netstat -ano | findstr "<hub-ip>:4242"
```
Look for `ESTABLISHED`.

## Setup Notes Learned In Practice

- Keep hub running before starting agents.
- If Windows shows `SYN_SENT`, the hub is not reachable yet.
- If `authToken` stays `null`, pairing/auth did not complete for that agent session.
- Use the hub fingerprint from `device-info.md` for first secure join.
- Run Windows agent in the interactive desktop session. Service-only/background contexts can use a different clipboard context and break real sync behavior.
- Keep machines on latest `main` when pairing issues appear, because recent fixes include:
- Agent staying alive after startup.
- UTF-8 BOM-safe JSON state parsing.
- Empty clipboard handling on Windows (`Element not found` treated as empty text).

## E2E Testing (Host + Docker)

The project includes an automated end-to-end test that validates bidirectional sync between:
- host hub + host agent
- Docker Linux agent

The test uses a deterministic file clipboard backend instead of the real OS clipboard so it can run reliably in containerized environments.

### Prerequisites

- Node.js 18+
- Docker with Compose (`docker compose` or `docker-compose`)

### Run E2E

```bash
npm install
npm run test:e2e
```

### Run Unit Tests

```bash
npm run test:unit
```

### What The Test Verifies

1. Host clipboard change propagates to container agent.
2. Container clipboard change propagates to host agent.
3. Pairing and TLS trust complete in non-interactive test mode.
