# Recovery Sequence (Dev Build + Production Backend)

When the phone shows "Error loading app" / "server not running", or you logged out and need to get back to a working state.

## 1. Fix "Error loading app" (Metro / JS Bundle)

Metro not running or not reachable by the device.

```bash
cd /Volumes/AppleFS/kDrive/Documents/workspace/happy/packages/happy-app
npx expo start
```

- Ensure the iPhone and Mac are on the same Wi-Fi network.
- If the phone can't find the server, check Mac IP: `ipconfig getifaddr en0`
- Enter the URL manually in the Expo dev client if needed.

## 2. Log Into the App (Phone)

- Open the app and log in (or create an account).
- Confirm you are authenticated in the account/settings screen.

## 3. Log Into the CLI (Mac)

Run in a normal interactive terminal:

```bash
cd /Volumes/AppleFS/kDrive/Documents/workspace/happy/packages/happy-cli
./bin/boujot.mjs auth login --force
```

- Choose "Mobile App".
- The CLI displays a QR code.

## 4. Link the CLI from the App (Phone)

- In the app, use "Connect Terminal" (scanner) and scan the CLI QR from step 3.
- Wait until the CLI confirms authentication success.

## 5. Start the Daemon (Mac)

If you suspect stuck processes from earlier, clean first:

```bash
./bin/boujot.mjs doctor clean
```

Then start and verify:

```bash
./bin/boujot.mjs daemon start
./bin/boujot.mjs daemon status
```

## 6. Verify End-to-End in the App

- The Machines list should show your Mac as online.
- Start a new session on that machine.
- Send a message and confirm responses appear.
