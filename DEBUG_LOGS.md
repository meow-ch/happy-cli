# Debugging Happy CLI Logs

## Log Location

All logs are stored in `~/.happy/logs/` with the format:
```
YYYY-MM-DD-HH-MM-SS-pid-XXXXX.log        # Session logs
YYYY-MM-DD-HH-MM-SS-pid-XXXXX-daemon.log # Daemon logs
```

## Finding the Right Log File

```bash
# List recent log files (most recent first)
ls -lt ~/.happy/logs/*.log | head -10

# Find logs containing specific content
grep -l "SEARCH_TERM" ~/.happy/logs/*.log
```

## Monitoring Logs in Real-Time

```bash
# Tail the daemon log
tail -f ~/.happy/logs/*-daemon.log

# Tail a specific session log
tail -f ~/.happy/logs/2026-02-07-21-09-26-pid-61329.log
```

## Key Log Patterns

### Messages from App to CLI

When the app sends a message, look for `[streamToStdin]`:
```bash
grep "streamToStdin" ~/.happy/logs/*.log
```

Example output:
```
[21:11:11.123] [streamToStdin] Sending message (63 bytes): {"type":"user","message":{"role":"user","content":"Grrrringo"}}
```

The decrypted message structure is:
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "Your message here"
  }
}
```

### Encrypted Messages (Before Decryption)

Raw encrypted messages from the socket look like:
```json
{
  "id": "oZeORtWd2rQg",
  "seq": 3305,
  "body": {
    "t": "new-message",
    "sid": "session-id-here",
    "message": {
      "id": "message-id",
      "seq": 10,
      "content": {
        "c": "ADM3ov2Dwb81FlPZlhqhE7yX8S+...",
        "t": "encrypted"
      }
    }
  }
}
```

### Session Spawning

Look for `[DAEMON RUN]` to see session lifecycle:
```bash
grep "DAEMON RUN" ~/.happy/logs/*-daemon.log
```

### Socket Updates

```bash
grep "\[SOCKET\]" ~/.happy/logs/*.log | tail -20
```

## Adding Custom Debug Logging

To add debug logging for decrypted messages, edit `src/api/apiSession.ts` around line 135:

```typescript
console.log('\n\n🔍 [DEBUG] DECRYPTED MESSAGE FROM APP:\n', JSON.stringify(body, null, 2), '\n\n');
```

Then rebuild and restart:
```bash
yarn build
./bin/happy.mjs daemon stop && ./bin/happy.mjs daemon start
```

## Restarting the Daemon

```bash
cd packages/happy-cli
./bin/happy.mjs daemon stop && ./bin/happy.mjs daemon start
```

## Quick Debug Commands

```bash
# See all user messages sent in the last session
grep "streamToStdin" ~/.happy/logs/*.log | tail -10

# See what the daemon is doing
tail -f ~/.happy/logs/*-daemon.log

# Find errors
grep -i "error\|failed" ~/.happy/logs/*.log | tail -20

# See socket activity
grep "\[SOCKET\]" ~/.happy/logs/*.log | tail -30
```
