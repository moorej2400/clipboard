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
  clipboard.js   Clipboard read/write wrapper
  protocol.js    Message schema helpers
  store.js       Local JSON persistence helpers
```

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
- Generates `device-info.md` with connection and fingerprint details

### 3) Start agent machine(s)

```bash
npm run start:agent -- --hub wss://<hub-ip>:4242 --code <pair-code> --fingerprint "<fingerprint>"
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
