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

## macOS Windows App Gate

On macOS, outbound clipboard sync is gated by `Windows App` window state before any local text clipboard or MacWhisper text event is sent.

Current behavior:
- The gate only runs on macOS.
- The gate first checks `Windows App` through `System Events`.
- Set the required Windows App PC/window name with `MAC_WINDOWS_APP_PC_NAME`.
- If the configured session window is not visible, the gate falls back to the active `Windows App` RDP connection for a matching recent bookmark.
- Each outbound clipboard or MacWhisper event that is actually sent plays a local notification sound.

Notes:
- `MAC_WINDOWS_APP_SESSION_TITLE` is still accepted as a legacy alias for `MAC_WINDOWS_APP_PC_NAME`.
- To bypass the Windows App gate for a run, use `npm start -- --force-sync`.
- You can override the sound file with `MAC_CLIPBOARD_SEND_SOUND_PATH`.
- You can override the `Windows App` bookmark database path with `MAC_WINDOWS_APP_DATA_DB_PATH`.

## Getting Started

### 1) Install dependencies

```bash
npm install
```

### 2) Start the hub machine

```bash
npm run start:hub
```

This saves the local role as `hub` in `local_device.json`.

Daily startup on that same machine can then use:

```bash
npm start
```

`npm start` on a hub-configured machine starts the hub and then starts the local agent against `wss://127.0.0.1:<port>`.

Hub startup:
- Prints the current pairing code
- Prints/listens on LAN endpoint(s)
- Persists `wss://127.0.0.1:4242` for the hub machine itself so local restarts stay attached
- Generates `device-info.md` with connection and fingerprint details

### 3) Start agent machine(s)

```bash
npm run start:agent -- --hub wss://<hub-ip>:4242 --code <pair-code> --fingerprint "<fingerprint>"
```

This saves the local role as `agent` in `local_device.json`.

After that initial setup, daily startup can use:

```bash
npm start
```

`npm start` on an agent-configured machine starts only the agent using the stored hub settings.

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

## Windows Background Startup (Recommended)

For reliable clipboard sync on Windows, run the agent from Task Scheduler at user logon. This is preferred over a true Windows Service because clipboard access belongs to the interactive desktop session. The task can still run hidden, start automatically, and keep the app alive in the background.

Create `scripts\start-agent-background.ps1`:
```powershell
$ErrorActionPreference = 'Continue'

$repoRoot = 'C:\path\to\clipboard'
$nodePath = 'C:\Program Files\nodejs\node.exe'
$hubUrl = 'wss://<hub-ip>:4242'
$fingerprint = '<hub-fingerprint>'
$agentLog = Join-Path $env:USERPROFILE 'clipboard-agent.log'
$launcherLog = Join-Path $env:USERPROFILE 'clipboard-launcher.log'
$restartDelaySeconds = 5

$env:AGENT_AUTO_TRUST_FINGERPRINT = '1'

function Write-LauncherLog {
  param([string]$Message)
  $timestamp = Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'
  Add-Content -Path $launcherLog -Value "[$timestamp] $Message"
}

Set-Location $repoRoot
Write-LauncherLog 'background launcher started'

while ($true) {
  Write-LauncherLog 'starting clipboard agent'
  $exitCode = 1

  try {
    & $nodePath 'src\index.js' 'agent' '--hub' $hubUrl '--fingerprint' $fingerprint *>> $agentLog
    if ($null -ne $LASTEXITCODE) {
      $exitCode = $LASTEXITCODE
    }
  } catch {
    Write-LauncherLog ("launcher exception: " + $_.Exception.Message)
  }

  Write-LauncherLog "clipboard agent exited with code $exitCode; restarting in $restartDelaySeconds seconds"
  Start-Sleep -Seconds $restartDelaySeconds
}
```

Replace `<hub-ip>` and `<hub-fingerprint>` with the values shown in `device-info.md` on the hub machine.

Create the hidden logon task from an elevated PowerShell prompt:
```powershell
$scriptPath = 'C:\path\to\clipboard\scripts\start-agent-background.ps1'
$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$userId = (whoami)
$principal = New-ScheduledTaskPrincipal `
  -UserId $userId `
  -LogonType Interactive `
  -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName 'ClipboardSyncAgent' `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Force
```

Start it without rebooting:
```powershell
Start-ScheduledTask -TaskName 'ClipboardSyncAgent'
```

Verify the setup:
```powershell
Get-ScheduledTask -TaskName 'ClipboardSyncAgent' | Get-ScheduledTaskInfo
Get-Content "$env:USERPROFILE\clipboard-launcher.log" -Tail 20
Get-Content "$env:USERPROFILE\clipboard-agent.log" -Tail 20
netstat -ano | findstr "<hub-ip>:4242"
```

Expected behavior:
- Task Scheduler shows `ClipboardSyncAgent` as `Running` after logon.
- No console window remains open because PowerShell starts with `-WindowStyle Hidden`.
- `clipboard-launcher.log` records restarts.
- `clipboard-agent.log` contains normal app output.
- The launcher restarts the agent if Node exits.

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
