# Boujot

Code on the go — control AI coding agents from your mobile device.

Open source. Code anywhere.

## Installation

```bash
npm install -g @boujot/happy-coder
```

## Usage

### Claude (default)

```bash
boujot
```

This will:
1. Start a Claude Code session
2. Display a QR code to connect from your mobile device
3. Allow real-time session sharing between Claude Code and your mobile app

### Gemini

```bash
boujot gemini
```

Start a Gemini CLI session with remote control capabilities.

**First time setup:**
```bash
# Authenticate with Google
boujot connect gemini
```

## Architecture & Dependencies

Boujot has five core pieces:

1. `happy-app` (mobile app)
2. Metro (only when developing `happy-app`)
3. `@boujot/happy-coder` (`boujot` command)
4. `boujot daemon` (background mode of the CLI)
5. Boujot server (`HAPPY_SERVER_URL`)

How they depend on each other:

- The server is the shared source of truth for account, sessions, and machines.
- `boujot daemon` is the process that keeps your computer registered as an online machine and routes work to local agent processes.
- `boujot` interactive sessions (Claude/Codex/Gemini) also sync via the server, which is why they appear in the app.
- The app talks to the server, selects a machine, and sends actions that are handled by the daemon on that machine.
- Metro is only needed for app development/hot reload; it is not part of production runtime and not required for CLI/daemon operation.

Minimal end-to-end requirements (app controlling your machine):

1. Server reachable
2. CLI authenticated (`boujot auth login`)
3. Daemon running (`boujot daemon start`)
4. App authenticated to the same account
5. Machine selected in the app

## Commands

### Main Commands

- `boujot` – Start Claude Code session (default)
- `boujot gemini` – Start Gemini CLI session
- `boujot codex` – Start Codex mode

### Utility Commands

- `boujot auth` – Manage authentication
- `boujot connect` – Store AI vendor API keys in Happy cloud
- `boujot notify` – Send a push notification to your devices
- `boujot daemon` – Manage background service
- `boujot doctor` – System diagnostics & troubleshooting

### Connect Subcommands

```bash
boujot connect gemini     # Authenticate with Google for Gemini
boujot connect claude     # Authenticate with Anthropic
boujot connect codex      # Authenticate with OpenAI
boujot connect status     # Show connection status for all vendors
```

### Gemini Subcommands

```bash
boujot gemini                      # Start Gemini session
boujot gemini model set <model>    # Set default model
boujot gemini model get            # Show current model
boujot gemini project set <id>     # Set Google Cloud Project ID (for Workspace accounts)
boujot gemini project get          # Show current Google Cloud Project ID
```

**Available models:** `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`

## Options

### Claude Options

- `-m, --model <model>` - Claude model to use (default: sonnet)
- `-p, --permission-mode <mode>` - Permission mode: auto, default, or plan
- `--claude-env KEY=VALUE` - Set environment variable for Claude Code
- `--claude-arg ARG` - Pass additional argument to Claude CLI

### Global Options

- `-h, --help` - Show help
- `-v, --version` - Show version

## Environment Variables

### Happy Configuration

- `HAPPY_SERVER_URL` - **Required.** Server URL
- `BOUJOT_WEBAPP_URL` - Custom web app URL (default: https://app.happy.engineering)
- `BOUJOT_HOME_DIR` - Custom home directory for Happy data (default: ~/.boujot)
- `HAPPY_DISABLE_CAFFEINATE` - Disable macOS sleep prevention (set to `true`, `1`, or `yes`)
- `HAPPY_EXPERIMENTAL` - Enable experimental features (set to `true`, `1`, or `yes`)

### Gemini Configuration

- `GEMINI_MODEL` - Override default Gemini model
- `GOOGLE_CLOUD_PROJECT` - Google Cloud Project ID (required for Workspace accounts)

## Gemini Authentication

### Personal Google Account

Personal Gmail accounts work out of the box:

```bash
boujot connect gemini
boujot gemini
```

### Google Workspace Account

Google Workspace (organization) accounts require a Google Cloud Project:

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the Gemini API
3. Set the project ID:

```bash
boujot gemini project set your-project-id
```

Or use environment variable:
```bash
GOOGLE_CLOUD_PROJECT=your-project-id boujot gemini
```

**Guide:** https://goo.gle/gemini-cli-auth-docs#workspace-gca

## Contributing

Interested in contributing? See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Boujot Fork: Release Helper

This repo includes an internal helper script to cut a versioned Boujot CLI release branch from the current commit:

```bash
cd packages/happy-cli
npm run release:boujot -- 0.14.0-4 --tag beta
```

Notes:
- The helper requires a clean working tree.
- It creates `boujot-cli-release/<version>`, bumps the CLI version, runs `yarn rebrand`, runs build/tests (unless skipped), and commits the result.
- For publishing, you can set `NPM_TOKEN` or put `NPM_GRANULAR_ACCESS_TOKEN=...` in `packages/happy-cli/.env` (gitignored).

## Requirements

- Node.js >= 20.0.0

### For Claude

- Claude CLI installed & logged in (`claude` command available in PATH)

### For Gemini

- Gemini CLI installed (`npm install -g @google/gemini-cli`)
- Google account authenticated via `boujot connect gemini`

## License

MIT
