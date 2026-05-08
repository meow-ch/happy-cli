/**
 * Global configuration for happy CLI
 *
 * Centralizes all configuration including environment variables and paths
 * Environment files should be loaded using Node's --env-file flag
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import packageJson from '../package.json'

export type Flavor = 'happy' | 'boujot'

/**
 * Detect whether we're running as the boujot or happy flavor.
 * When installed as @boujot/happy-coder, the dist path on disk contains '@boujot'.
 * In dev (tsx src/index.ts from workspace), the path has no '@boujot' → defaults to 'happy'.
 */
function detectFlavor(): Flavor {
  // Env var override for local dev testing (HAPPY_FLAVOR=boujot ./bin/happy.mjs ...)
  const envFlavor = process.env.HAPPY_FLAVOR
  if (envFlavor === 'boujot' || envFlavor === 'happy') return envFlavor

  try {
    const dir = dirname(fileURLToPath(import.meta.url))
    if (dir.includes('@boujot')) return 'boujot'
  } catch {}
  return 'happy'
}

class Configuration {
  public readonly flavor: Flavor
  /** CLI command name: 'happy' or 'boujot' — use in help text and command examples */
  public readonly cliName: string
  /** Display brand: 'Happy' or 'Boujot' — use in user-facing messages */
  public readonly brandName: string
  /** Config directory name: '.happy' or '.boujot' */
  public readonly configDirName: string

  public readonly serverUrl: string
  public readonly webappUrl: string
  public readonly isDaemonProcess: boolean

  // Directories and paths (from persistence)
  public readonly happyHomeDir: string
  public readonly logsDir: string
  public readonly settingsFile: string
  public readonly privateKeyFile: string
  public readonly daemonStateFile: string
  public readonly daemonLockFile: string
  public readonly currentCliVersion: string

  public readonly isExperimentalEnabled: boolean
  public readonly disableCaffeinate: boolean

  constructor() {
    // Flavor detection — determines branding, config dir, command name
    this.flavor = detectFlavor()
    this.cliName = this.flavor === 'boujot' ? 'boujot' : 'happy'
    this.brandName = this.flavor === 'boujot' ? 'Boujot' : 'Happy'
    this.configDirName = this.flavor === 'boujot' ? '.boujot' : '.happy'

    const args = process.argv.slice(2)
    const versionOnly = args.length === 1 && (args[0] === '--version' || args[0] === '-v')

    // Server configuration — required, no fallback default except for pure
    // version checks, which must not need auth, network, or daemon setup.
    if (!process.env.HAPPY_SERVER_URL && !versionOnly) {
      throw new Error('HAPPY_SERVER_URL environment variable is required')
    }
    this.serverUrl = process.env.HAPPY_SERVER_URL || 'https://server.invalid'
    this.webappUrl = process.env.HAPPY_WEBAPP_URL || 'https://app.happy.engineering'

    // Check if we're running as daemon based on process args
    this.isDaemonProcess = args.length >= 2 && args[0] === 'daemon' && (args[1] === 'start-sync')

    // Directory configuration - Priority: HAPPY_HOME_DIR env > default home dir
    if (process.env.HAPPY_HOME_DIR) {
      // Expand ~ to home directory if present
      const expandedPath = process.env.HAPPY_HOME_DIR.replace(/^~/, homedir())
      this.happyHomeDir = expandedPath
    } else {
      this.happyHomeDir = join(homedir(), this.configDirName)
    }

    this.logsDir = join(this.happyHomeDir, 'logs')
    this.settingsFile = join(this.happyHomeDir, 'settings.json')
    this.privateKeyFile = join(this.happyHomeDir, 'access.key')
    this.daemonStateFile = join(this.happyHomeDir, 'daemon.state.json')
    this.daemonLockFile = join(this.happyHomeDir, 'daemon.state.json.lock')

    this.isExperimentalEnabled = ['true', '1', 'yes'].includes(process.env.HAPPY_EXPERIMENTAL?.toLowerCase() || '');
    this.disableCaffeinate = ['true', '1', 'yes'].includes(process.env.HAPPY_DISABLE_CAFFEINATE?.toLowerCase() || '');

    this.currentCliVersion = packageJson.version

    // Validate variant configuration
    const variant = process.env.HAPPY_VARIANT || 'stable'
    if (variant === 'dev' && !this.happyHomeDir.includes('dev')) {
      console.warn('⚠️  WARNING: HAPPY_VARIANT=dev but HAPPY_HOME_DIR does not contain "dev"')
      console.warn(`   Current: ${this.happyHomeDir}`)
      console.warn(`   Expected: Should contain "dev" (e.g., ~/${this.configDirName}-dev)`)
    }

    // Visual indicator on CLI startup (only if not daemon process to avoid log clutter)
    if (!this.isDaemonProcess && variant === 'dev') {
      console.log('\x1b[33m🔧 DEV MODE\x1b[0m - Data: ' + this.happyHomeDir)
    }

    if (!existsSync(this.happyHomeDir)) {
      mkdirSync(this.happyHomeDir, { recursive: true })
    }
    // Ensure directories exist
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true })
    }
  }
}

export const configuration: Configuration = new Configuration()
