# clipboard

Bare-bones cross-platform clipboard sync for macOS and Windows using Node.js.

## Getting Started

### 1) Install
```bash
npm install
```

### 2) Start hub machine
```bash
npm run start:hub
```
This prints a pairing code and writes `device-info.md` with the hub URL and TLS fingerprint.

### 3) Start agent machine(s)
```bash
npm run start:agent -- --hub wss://<hub-ip>:4242 --code <pair-code> --fingerprint "<fingerprint>"
```
On first connect, approve pairing on the hub prompt.

### Notes
- Text clipboard only (no images/files).
- Pairing code rotates on each hub startup.
- Trusted devices persist in local app-data JSON files.
