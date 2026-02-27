# Machine Registration: Why "Login Successful" Can Still Show "No Machines"

The Boujot iOS app shows "machines" by calling the backend:

- `GET <HAPPY_SERVER_URL>/v1/machines`

If that endpoint returns an empty list for your account, the app will show "No machines" and it will block sending messages until you select one.

## Key Point

`happy auth login` does two things locally:

- Stores CLI credentials (token + encryption material) in `~/.happy/access.key`
- Ensures a local `machineId` exists in `~/.happy/settings.json`

It does **not** guarantee the server has a machine record yet.

The server machine record is created/updated when the **daemon** runs and successfully registers the machine.

## Bring-Up Sequence (Mac + iPhone)

On your Mac:

1. Check authentication:
   - `happy auth status`
2. Start the daemon:
   - `happy daemon start`
3. Confirm the daemon is actually running:
   - `happy daemon status`
   - You should see `✓ Daemon is running` plus PID/HTTP port.

On your iPhone:

1. Make sure the app is pointing at the correct server in Settings (Server Configuration).
2. Go back to the New Session screen (or restart the app) so it refetches machines.

## Troubleshooting

### Daemon Not Running

If `happy auth status` is authenticated but `happy daemon status` shows not running, the server will usually have no machine for that account.

Fix:

- `happy daemon start`

### "Daemon lock file already held"

The daemon uses `~/.happy/daemon.state.json.lock` as an exclusive lock. If a daemon crashed during startup, the lock can remain held by a stuck process.

Fix (preferred):

- `happy daemon stop`
- `happy daemon start`

If `happy daemon stop` cannot stop it, inspect the PID in the lock file and kill it, then retry:

```bash
cat ~/.happy/daemon.state.json.lock
ps -p <PID> -o pid,ppid,stat,command
kill <PID>
happy daemon start
```

### Wrong Server URL In The App

The app fetches machines from `getServerUrl()`:

- `packages/happy-app/sources/sync/serverConfig.ts`

If the app is pointed at a custom server (or an old dev server), you can be logged in successfully but looking at the wrong backend.

Fix:

- In the app: Settings -> Server Configuration -> Reset to Default.

### Network/DNS Issues On The Mac

If the daemon can't reach your server (`HAPPY_SERVER_URL`), it can't register the machine.

Quick check:

```bash
curl -sS $HAPPY_SERVER_URL/v1/version | head
```

If that fails, fix network/DNS first, then restart the daemon.

