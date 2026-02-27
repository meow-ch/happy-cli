# Dev Bring-Up: App, CLI, Daemon, Server, Metro

How to get everything running for local testing.

## Components

### Backend Server (set via `HAPPY_SERVER_URL`)

- System of record for accounts, sessions, messages, and machines.
- Both the mobile app and the CLI/daemon connect to it (HTTP plus realtime updates).
- If the app says the "server isn't running", it usually means connectivity/auth to this backend, not Metro.

### CLI (`happy` / `boujot`)

- Runs locally on your Mac from the workspace at `packages/happy-cli`.
- Two flavors via runtime detection:
  - `./bin/happy.mjs` — happy flavor (default for dev)
  - `./bin/boujot.mjs` — boujot flavor (sets `HAPPY_FLAVOR=boujot`, gitignored)
- After auth, credentials are stored under `~/.happy/` or `~/.boujot/` depending on flavor.

### Daemon (`<cli> daemon ...`)

- Long-running local process on your Mac.
- Registers your Mac as a "machine" with the backend.
- Maintains a connection so the backend (and the app) can RPC into your Mac (spawn sessions, list models, run commands, etc.).
- If the daemon is not running, the app shows "no machines" and machine-scoped features fail.

### Mobile App

- Authenticates independently of the CLI (app credentials and CLI credentials are separate).
- Talks to the backend to show machines/sessions/messages.
- When you start a new session on a specific machine, it asks the backend to deliver an RPC to that machine (handled by the daemon).

### Metro (Expo Dev Server)

- Only needed for local app development (dev builds).
- Serves the JavaScript bundle to the dev app running on a device/simulator.
- The phone and Mac must be on the same network.

## Quick Start

From the workspace root:

```bash
cd /Volumes/AppleFS/kDrive/Documents/workspace/happy
```

### 1. Build the CLI

```bash
cd packages/happy-cli
yarn build
```

### 2. Start the daemon (boujot flavor)

```bash
./bin/boujot.mjs daemon start
./bin/boujot.mjs daemon status   # should show "Boujot CLI Doctor"
```

### 3. Start Metro for the mobile app

```bash
cd packages/happy-app
npx expo start
```

Ensure the phone and Mac are on the same Wi-Fi network. If the phone can't find the dev server, check the Mac's IP (`ipconfig getifaddr en0`) and enter it manually in the Expo dev client.

### 4. Open the app on the phone

The dev build should connect to Metro and show the Boujot app. Your Mac should appear as a machine if the daemon is running and authenticated.

## Auth Setup (first time or after logout)

```bash
# Interactive terminal (not from daemon)
./bin/boujot.mjs auth login --force
```

Choose "Mobile App", scan the QR code from the app's "Connect Terminal" flow. Then restart the daemon.

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| "No development servers found" | Metro not running or wrong IP | Start Metro, check same network, verify IP |
| "Error loading app" / red screen | Metro unreachable | Check Mac IP with `ipconfig getifaddr en0`, enter manually in Expo |
| "Server isn't running" in app | Backend auth/connectivity | Check app login, verify network |
| "No machines" / "select a machine" | Daemon not running | `./bin/boujot.mjs daemon start` |
| Daemon starts but machine doesn't appear | Auth expired | Re-auth: `./bin/boujot.mjs auth login --force`, restart daemon |

## Rebuilding after code changes

```bash
cd packages/happy-cli
yarn build
./bin/boujot.mjs daemon stop && ./bin/boujot.mjs daemon start
```

## Flavor Detection

The CLI detects `happy` vs `boujot` at runtime:

1. `HAPPY_FLAVOR` env var (if set) — used by `bin/boujot.mjs`
2. `import.meta.url` path containing `@boujot` — used by npm global installs
3. Default: `happy`

The boujot flavor uses `~/.boujot/` for config, the happy flavor uses `~/.happy/`.
