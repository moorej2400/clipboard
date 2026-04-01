# E2E Testing Plan: Host + Docker Clipboard Sync

## Summary
Build a fully automated E2E test harness that validates bidirectional clipboard sync between:
1. A host-run hub and host-run agent.
2. A Docker-isolated Linux agent.

To make this deterministic and CI-ready, we will add a test clipboard backend (file-based), non-interactive test env controls for pairing/fingerprint prompts, and isolated state directories so tests do not depend on or pollute real user clipboard/device state.

## Current-State Gaps Identified
1. Pairing approval and fingerprint trust are interactive prompts, which blocks automation.
2. Clipboard access is hard-wired to `clipboardy` only, which is fragile in headless Linux containers.
3. Persistent state is stored in global OS app-data paths, which can leak trust state across test runs.
4. No test harness, Docker test topology, or E2E script exists yet.

## Important API / Interface Changes
1. New env vars for non-interactive test control:
- `CLIPBOARD_SYNC_DATA_DIR`  
Purpose: override default OS app-data path for isolated test state.
- `CLIPBOARD_BACKEND` with values `system` (default) or `file`  
Purpose: select clipboard provider.
- `CLIPBOARD_FILE_PATH`  
Required when `CLIPBOARD_BACKEND=file`; points to a plaintext clipboard file.
- `HUB_AUTO_APPROVE_PAIRING=1`  
Purpose: auto-approve pairing requests in hub for automated tests.
- `HUB_PAIR_CODE=<6-digit>`  
Purpose: deterministic pairing code in tests.
- `AGENT_AUTO_TRUST_FINGERPRINT=1`  
Purpose: trust provided/presented cert without interactive prompt in tests.

2. Internal clipboard provider contract (module-level interface):
- `readClipboardText(): Promise<string>`
- `writeClipboardText(text: string): Promise<void>`
- Implementations:
- `system` provider (existing `clipboardy` behavior)
- `file` provider (read/write from `CLIPBOARD_FILE_PATH`)

3. New npm scripts:
- `test:e2e` to run Node E2E test suite.
- `e2e:up` and `e2e:down` helper scripts for Docker compose lifecycle.

## Implementation Plan
1. Refactor clipboard abstraction for pluggable backends.
- Update `src/clipboard.js` to select provider via env.
- Keep current behavior as default (`system`) so runtime users are unaffected.
- Add file-based provider logic for deterministic host/container testing.

2. Add deterministic, non-interactive runtime controls.
- Update `src/hub.js`:
- Use `HUB_PAIR_CODE` when provided.
- Bypass approval prompt when `HUB_AUTO_APPROVE_PAIRING=1`.
- Update `src/agent.js`:
- Bypass fingerprint prompt when `AGENT_AUTO_TRUST_FINGERPRINT=1`.
- Preserve secure interactive defaults when env vars are not set.

3. Add isolated storage path override.
- Update `src/store.js`:
- If `CLIPBOARD_SYNC_DATA_DIR` is set, use it as base dir.
- Else keep existing macOS/Windows defaults.

4. Add Docker E2E topology files.
- Add `docker-compose.e2e.yml` with one Linux agent service on Node LTS Debian.
- Configure service to connect to host hub using `host.docker.internal`.
- Add `extra_hosts: host.docker.internal:host-gateway` for Linux host compatibility.
- Mount workspace and a container clipboard/state temp path.

5. Build Node E2E harness with built-in `node:test`.
- Add `test/e2e/clipboard-sync.e2e.test.js`.
- Test flow:
1. Allocate ephemeral test temp directories.
2. Start host hub process with deterministic env (`HUB_PAIR_CODE`, auto-approve, isolated state).
3. Read hub fingerprint and pairing code from host-generated `device-info.md`.
4. Start host agent process with file backend and auto-trust enabled.
5. Start container agent via docker compose with file backend and same pairing/fingerprint.
6. Assert host -> container propagation by writing host clipboard file and waiting for container clipboard file update.
7. Assert container -> host propagation by writing container clipboard file and waiting for host clipboard file update.
8. Teardown all processes/containers and clean temp state.

6. Add test scripts and docs.
- Update `package.json` with E2E scripts.
- Update `README.md` with E2E setup/run section and prerequisites (`Docker`, `Node`).

## Test Cases and Scenarios
1. `E2E_Bidirectional_FileBackend`
- Given trusted host + container agents
- When host clipboard changes
- Then container clipboard matches within timeout.
- When container clipboard changes
- Then host clipboard matches within timeout.

2. `E2E_Pairing_NonInteractive`
- Given deterministic pairing code and auto-approve
- Then both agents authenticate without manual input.

3. `E2E_IsolatedState`
- Given per-test `CLIPBOARD_SYNC_DATA_DIR`
- Then repeated test runs do not reuse prior trust state unexpectedly.

4. `E2E_CertPinning_Path`
- Given expected fingerprint passed to agents
- Then connection succeeds only when fingerprint matches.

5. `E2E_Teardown_Cleanliness`
- Given abrupt failures
- Then harness still stops child processes and docker services.

## Failure Modes and Handling
1. Docker unavailable:
- Test should skip/fail fast with clear prerequisite message.
2. `host.docker.internal` resolution failure:
- Provide compose override path using host-gateway mapping.
3. Startup race conditions:
- Poll for readiness markers (`device-info.md`, websocket connect) before assertions.
4. Timing variability:
- Use retry polling with bounded timeout instead of fixed sleeps.

## Rollout
1. Local-first execution via `npm run test:e2e`.
2. Structure scripts so GitHub Actions can run later without redesign.
3. Keep default runtime behavior secure and interactive for non-test usage.

## Assumptions and Defaults
1. E2E uses file clipboard backend for deterministic automation.
2. Runtime default remains `system` clipboard for regular use.
3. Topology is host hub + host agent + container agent.
4. Node built-in test runner is used.
5. Docker Compose is used for container orchestration.
6. First milestone is local execution; CI wiring is deferred but prepared.
