import fs from 'fs/promises';
import os from 'os';
import * as tmp from 'tmp';

import { ApiClient } from '@/api/api';
import { TrackedSession } from './types';
import {
  isAgentPlaneSessionEncryptionAttestation,
  type AgentPlaneSessionEncryptionAttestation,
  type MachineMetadata,
  type DaemonState,
  type Metadata,
} from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { writeDaemonState, DaemonLocallyPersistedState, readDaemonState, acquireDaemonLock, releaseDaemonLock, readSettings, getActiveProfile, getEnvironmentVariables, validateProfileForAgent, getProfileEnvironmentVariables } from '@/persistence';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { findAllHappyProcesses } from './doctor';
import { readFileSync } from 'fs';
import { join } from 'path';
import { projectPath } from '@/projectPath';
import { getTmuxUtilities, isTmuxAvailable, parseTmuxSessionIdentifier, formatTmuxSessionIdentifier } from '@/utils/tmux';
import {
  CODEX_EXTERNAL_MCP_SERVERS_ENV,
  CODEX_USE_BUILTIN_HAPPY_MCP_ENV,
} from '@/codex/codexMcpServers';
import { getGlobalClaudeVersion, checkClaudeVersion } from '@/utils/claudeVersionCheck';
import {
  probeClaudeAuthReadiness,
  type ProviderReadinessRequest,
  type ProviderReadinessResponse,
} from '@/claude/claudeAuthReadiness';
import {
  DaemonSessionStatus,
  pidIsAlive,
  pruneDeadDaemonSessionRecords,
  readDaemonSessionRegistry,
  removeDaemonSessionRecord,
  updateDaemonSessionActivity,
  upsertDaemonSessionRecord,
} from './sessionRegistry';
import { waitForSessionWebhook } from './sessionWebhookAwaiter';
import { replayPendingSessionOutboxes } from '@/api/sessionMessageOutboxReplay';
import {
  daemonSessionLifecyclePolicyFromEnvironment,
  selectDaemonSessionsForExpiry,
} from './sessionLifecycle';
import { buildAgentEnvironment } from './agentEnvironment';
import { inspectSessionMessageOutboxOnDisk } from '@/api/sessionMessageOutbox';
import {
  processBirthFingerprintMatches,
  readProcessBirthFingerprint,
} from './processBirthFingerprint';
import {
  executeDaemonSessionPrune,
  type DaemonSessionPruneCandidate,
  type DaemonSessionPruneExecutionResult,
  type DaemonSessionPruneRequest,
} from './sessionPruning';

const SESSION_WEBHOOK_TIMEOUT_MS = 15_000;

function validateRequiredTerminalProtocol(options: SpawnSessionOptions): string | null {
  if (options.requiredTerminalProtocol === undefined) return null;
  if (options.requiredTerminalProtocol !== 1) {
    return `Unsupported required terminal protocol: ${String(options.requiredTerminalProtocol)}`;
  }
  if ((options.agent ?? 'claude') !== 'claude') {
    return 'Authoritative terminal protocol 1 is currently supported only for Claude sessions.';
  }
  return null;
}

function attestedSpawnResult(
  session: TrackedSession,
  requiredTerminalProtocol?: 1,
): SpawnSessionResult {
  if (!session.happySessionId) {
    return { type: 'error', errorMessage: 'Spawned child did not report a session ID.' };
  }
  if (requiredTerminalProtocol !== undefined
    && session.terminalProtocol !== requiredTerminalProtocol) {
    return {
      type: 'error',
      errorMessage: `Spawned child did not attest required terminal protocol ${requiredTerminalProtocol}.`,
    };
  }
  if (!session.processBirthFingerprint) {
    return { type: 'error', errorMessage: 'Spawned child process identity could not be verified.' };
  }
  return {
    type: 'success',
    sessionId: session.happySessionId,
    ...(session.terminalProtocol !== undefined
      ? { terminalProtocol: session.terminalProtocol }
      : {}),
    ...(session.sessionEncryption !== undefined
      ? { sessionEncryption: session.sessionEncryption }
      : {}),
  };
}

export const __testDaemonTerminalProtocol = {
  validateRequiredTerminalProtocol,
  attestedSpawnResult,
};

// Prepare initial metadata
export const initialMachineMetadata: MachineMetadata = {
  host: os.hostname(),
  platform: os.platform(),
  happyCliVersion: packageJson.version,
  homeDir: os.homedir(),
  happyHomeDir: configuration.happyHomeDir,
  happyLibDir: projectPath(),
  claudeCodeVersion: getGlobalClaudeVersion() ?? undefined,
};

// Get environment variables for a profile, filtered for agent compatibility
async function getProfileEnvironmentVariablesForAgent(
  profileId: string,
  agentType: 'claude' | 'codex' | 'gemini'
): Promise<Record<string, string>> {
  try {
    const settings = await readSettings();
    const profile = settings.profiles.find(p => p.id === profileId);

    if (!profile) {
      logger.debug(`[DAEMON RUN] Profile ${profileId} not found`);
      return {};
    }

    // Check if profile is compatible with the agent
    if (!validateProfileForAgent(profile, agentType)) {
      logger.debug(`[DAEMON RUN] Profile ${profileId} not compatible with agent ${agentType}`);
      return {};
    }

    // Get environment variables from profile (new schema)
    const envVars = getProfileEnvironmentVariables(profile);

    logger.debug(`[DAEMON RUN] Loaded ${Object.keys(envVars).length} environment variables from profile ${profileId} for agent ${agentType}`);
    return envVars;
  } catch (error) {
    logger.debug('[DAEMON RUN] Failed to get profile environment variables:', error);
    return {};
  }
}

async function getActiveProfileEnvironmentVariablesForAgent(
  agentType: 'claude' | 'codex' | 'gemini',
): Promise<Record<string, string>> {
  try {
    const settings = await readSettings();
    if (!settings.activeProfileId) {
      logger.debug('[DAEMON RUN] No CLI local active profile set');
      return {};
    }
    logger.debug(`[DAEMON RUN] Loading CLI local active profile: ${settings.activeProfileId}`);
    return getProfileEnvironmentVariablesForAgent(settings.activeProfileId, agentType);
  } catch (error) {
    logger.debug('[DAEMON RUN] Failed to load CLI local profile environment variables:', error);
    return {};
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function prepareIsolatedCodexHome(extraEnv: Record<string, string>): Promise<void> {
  if (extraEnv.CODEX_HOME) {
    logger.debug('[DAEMON RUN] Codex CODEX_HOME supplied explicitly; skipping runtime home isolation');
    return;
  }
  if (process.env.HAPPY_CODEX_ISOLATE_HOME === '0') {
    logger.debug('[DAEMON RUN] HAPPY_CODEX_ISOLATE_HOME=0; skipping Codex runtime home isolation');
    return;
  }

  const sourceCodexHome = process.env.CODEX_HOME || join(os.homedir(), '.codex');
  const filesToCopy = ['auth.json', 'config.toml', 'models_cache.json'];
  const copied: string[] = [];
  const runtimeCodexHome = await fs.mkdtemp(join(os.tmpdir(), 'happy-codex-home-'));

  for (const fileName of filesToCopy) {
    const sourcePath = join(sourceCodexHome, fileName);
    if (!(await fileExists(sourcePath))) continue;
    await fs.copyFile(sourcePath, join(runtimeCodexHome, fileName));
    copied.push(fileName);
  }

  if (copied.length === 0) {
    logger.debug(`[DAEMON RUN] No local Codex auth/config files found in ${sourceCodexHome}; using inherited Codex environment`);
    await fs.rm(runtimeCodexHome, { recursive: true, force: true });
    return;
  }

  extraEnv.CODEX_HOME = runtimeCodexHome;
  logger.debug(`[DAEMON RUN] Prepared isolated Codex runtime home with files: ${copied.join(', ')}`);
}

export async function startDaemon(): Promise<void> {
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let requestShutdown: (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => void;
  let resolvesWhenShutdownRequested = new Promise<({ source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string })>((resolve) => {
    requestShutdown = (source, errorMessage) => {
      logger.debug(`[DAEMON RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);

      // Fallback - in case startup malfunctions - we will force exit the process with code 1
      setTimeout(async () => {
        logger.debug('[DAEMON RUN] Startup malfunctioned, forcing exit with code 1');

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100))

        process.exit(1);
      }, 1_000);

      // Start graceful shutdown
      resolve({ source, errorMessage });
    };
  });

  // Setup signal handlers
  process.on('SIGINT', () => {
    logger.debug('[DAEMON RUN] Received SIGINT');
    requestShutdown('os-signal');
  });

  process.on('SIGTERM', () => {
    logger.debug('[DAEMON RUN] Received SIGTERM');
    requestShutdown('os-signal');
  });

  process.on('uncaughtException', (error) => {
    logger.debug('[DAEMON RUN] FATAL: Uncaught exception', error);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.debug('[DAEMON RUN] FATAL: Unhandled promise rejection', reason);
    logger.debug(`[DAEMON RUN] Rejected promise:`, promise);
    const error = reason instanceof Error ? reason : new Error(`Unhandled promise rejection: ${reason}`);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('exit', (code) => {
    logger.debug(`[DAEMON RUN] Process exiting with code: ${code}`);
  });

  process.on('beforeExit', (code) => {
    logger.debug(`[DAEMON RUN] Process about to exit with code: ${code}`);
  });

  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  // Check if already running
  // Check if running daemon version matches current CLI version
  const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledHappyVersion();
  if (!runningDaemonVersionMatches) {
    logger.debug('[DAEMON RUN] Daemon version mismatch detected, restarting daemon with current CLI version');
    await stopDaemon();
  } else {
    logger.debug('[DAEMON RUN] Daemon version matches, keeping existing daemon');
    console.log('Daemon already running with matching version');
    process.exit(0);
  }

  // Acquire exclusive lock (proves daemon is running)
  const daemonLockHandle = await acquireDaemonLock(5, 200);
  if (!daemonLockHandle) {
    logger.debug('[DAEMON RUN] Daemon lock file already held, another daemon is running');
    process.exit(0);
  }

  // At this point we should be safe to startup the daemon:
  // 1. Not have a stale daemon state
  // 2. Should not have another daemon process running

  try {
    // Start caffeinate
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

    // Ensure auth and machine registration BEFORE anything else
    const { credentials, machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();
    const sessionLifecyclePolicy = daemonSessionLifecyclePolicyFromEnvironment();

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
    let spawnInFlight = 0;

    const trackedProcessIdentityMatches = (pid: number, session: TrackedSession): boolean => (
      processBirthFingerprintMatches(
        session.processBirthFingerprint,
        readProcessBirthFingerprint(pid),
      )
    );

    const discardTrackedSessionsWithInvalidProcessIdentity = () => {
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (!trackedProcessIdentityMatches(pid, session)) {
          logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process-birth identity missing or changed)`);
          pidToTrackedSession.delete(pid);
          removeDaemonSessionRecord({ pid });
        }
      }
    };

    // Helper functions
    const isSessionProcessType = (type: string) => (
      type === 'daemon-spawned-session'
      || type === 'dev-daemon-spawned'
      || type === 'user-session'
      || type === 'dev-session'
    );

    const reconcilePersistedSessions = async () => {
      const records = pruneDeadDaemonSessionRecords();
      if (records.length === 0) return;

      const processByPid = new Map(
        (await findAllHappyProcesses())
          .filter((proc) => isSessionProcessType(proc.type))
          .map((proc) => [proc.pid, proc]),
      );

      for (const record of records) {
        if (pidToTrackedSession.has(record.pid)) continue;
        const proc = processByPid.get(record.pid);
        if (!proc) {
          removeDaemonSessionRecord({ sessionId: record.sessionId, pid: record.pid });
          continue;
        }

        const ownershipMatches = record.startedBy === 'daemon'
          ? proc.type === 'daemon-spawned-session' || proc.type === 'dev-daemon-spawned'
          : proc.type === 'user-session' || proc.type === 'dev-session';
        if (!ownershipMatches) {
          // PID reuse or a stale/malformed registry entry. Never adopt a
          // process whose command-line ownership disagrees with the record.
          removeDaemonSessionRecord({ sessionId: record.sessionId, pid: record.pid });
          logger.debug(`[DAEMON RUN] Refused unsafe session re-adoption for ${record.sessionId} PID ${record.pid}`);
          continue;
        }

        const observedProcessBirthFingerprint = readProcessBirthFingerprint(record.pid);
        if (!processBirthFingerprintMatches(
          record.processBirthFingerprint,
          observedProcessBirthFingerprint,
        )) {
          removeDaemonSessionRecord({ sessionId: record.sessionId, pid: record.pid });
          logger.debug(`[DAEMON RUN] Refused session re-adoption without matching process-birth identity for ${record.sessionId} PID ${record.pid}`);
          continue;
        }

        pidToTrackedSession.set(record.pid, {
          startedBy: record.startedBy,
          happySessionId: record.sessionId,
          pid: record.pid,
          trackingSource: 'registry',
          lastActivityAt: record.lastActivityAt,
          thinking: record.thinking,
          pendingOutbox: record.pendingOutbox,
          activityReportedAt: record.activityReportedAt,
          terminalProtocol: record.terminalProtocol,
          sessionEncryption: record.sessionEncryption,
          processBirthFingerprint: record.processBirthFingerprint,
        });
        logger.debug(`[DAEMON RUN] Re-adopted session ${record.sessionId} from registry PID ${record.pid}`);
      }
    };

    const getCurrentChildren = async () => {
      await reconcilePersistedSessions();
      discardTrackedSessionsWithInvalidProcessIdentity();
      return Array.from(pidToTrackedSession.values());
    };

    await reconcilePersistedSessions();

    const beginTrackedSpawn = () => {
      spawnInFlight += 1;
      return () => {
        spawnInFlight = Math.max(0, spawnInFlight - 1);
      };
    };

    const providerReadiness = async (
      request: ProviderReadinessRequest,
    ): Promise<ProviderReadinessResponse> => {
      const explicitAuthEnv: Record<string, string> = {};
      if (request.token) {
        explicitAuthEnv.CLAUDE_CODE_OAUTH_TOKEN = request.token;
      }
      // This is the same builder used immediately below for child processes,
      // so the probe cannot accidentally inspect a different credential set.
      const builtEnvironment = await buildAgentEnvironment({
        agent: 'claude',
        environmentVariables: request.environmentVariables,
        environmentVariablesMode: request.environmentVariablesMode,
        authenticationEnvironmentVariables: explicitAuthEnv,
        loadLocalProfileEnvironment: getActiveProfileEnvironmentVariablesForAgent,
        logExpansion: false,
      });
      return probeClaudeAuthReadiness({
        env: builtEnvironment.effectiveEnvironment,
      });
    };

    // Handle webhook from happy session reporting itself
    const onHappySessionWebhook = (sessionId: string, sessionMetadata: Metadata) => {
      logger.debugLargeJson(`[DAEMON RUN] Session reported`, sessionMetadata);

      const pid = sessionMetadata.hostPid;
      if (!pid) {
        logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
        return;
      }

      logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}`);
      logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

      // Check if we already have this PID (daemon-spawned)
      const existingSession = pidToTrackedSession.get(pid);
      const observedProcessBirthFingerprint = readProcessBirthFingerprint(pid);

      if (existingSession && existingSession.startedBy === 'daemon') {
        if (!processBirthFingerprintMatches(
          existingSession.processBirthFingerprint,
          observedProcessBirthFingerprint,
        )) {
          logger.debug(`[DAEMON RUN] Ignored session webhook with mismatched process-birth identity for PID ${pid}`);
          return;
        }
        // Update daemon-spawned session with reported data
        existingSession.happySessionId = sessionId;
        existingSession.happySessionMetadataFromLocalWebhook = sessionMetadata;
        existingSession.terminalProtocol = sessionMetadata.terminalProtocol === 1 ? 1 : undefined;
        existingSession.sessionEncryption = isAgentPlaneSessionEncryptionAttestation(
          sessionMetadata.sessionEncryption,
        ) ? sessionMetadata.sessionEncryption : undefined;
        existingSession.trackingSource = existingSession.trackingSource ?? 'memory';
        const persisted = upsertDaemonSessionRecord({
          sessionId,
          pid,
          startedBy: existingSession.startedBy,
          metadata: sessionMetadata,
          processBirthFingerprint: existingSession.processBirthFingerprint,
        });
        existingSession.lastActivityAt = persisted.lastActivityAt;
        existingSession.thinking = persisted.thinking;
        existingSession.pendingOutbox = persisted.pendingOutbox;
        existingSession.activityReportedAt = persisted.activityReportedAt;
        logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);

        // Resolve any awaiter for this PID
        const awaiter = pidToAwaiter.get(pid);
        if (awaiter) {
          pidToAwaiter.delete(pid);
          awaiter(existingSession);
          logger.debug(`[DAEMON RUN] Resolved session awaiter for PID ${pid}`);
        }
      } else if (!existingSession) {
        if (!observedProcessBirthFingerprint) {
          logger.debug(`[DAEMON RUN] Ignored external session webhook without verifiable process-birth identity for PID ${pid}`);
          return;
        }
        // New session started externally
        const trackedSession: TrackedSession = {
          startedBy: `${configuration.cliName} directly - likely by user from terminal`,
          happySessionId: sessionId,
          happySessionMetadataFromLocalWebhook: sessionMetadata,
          pid,
          trackingSource: 'memory',
          lastActivityAt: Date.now(),
          thinking: false,
          pendingOutbox: 0,
          terminalProtocol: sessionMetadata.terminalProtocol === 1 ? 1 : undefined,
          sessionEncryption: isAgentPlaneSessionEncryptionAttestation(
            sessionMetadata.sessionEncryption,
          ) ? sessionMetadata.sessionEncryption : undefined,
          processBirthFingerprint: observedProcessBirthFingerprint,
        };
        pidToTrackedSession.set(pid, trackedSession);
        upsertDaemonSessionRecord({
          sessionId,
          pid,
          startedBy: trackedSession.startedBy,
          metadata: sessionMetadata,
          processBirthFingerprint: observedProcessBirthFingerprint,
        });
        logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
      }
    };

    const onHappySessionActivity = (activity: {
      sessionId: string;
      lastActivityAt: number;
      thinking: boolean;
      pendingOutbox: number;
    }) => {
      for (const session of pidToTrackedSession.values()) {
        if (session.happySessionId !== activity.sessionId) continue;
        const activityReportedAt = Date.now();
        const lastActivityAt = Math.min(Date.now(), Math.max(0, activity.lastActivityAt));
        session.lastActivityAt = Math.max(session.lastActivityAt ?? 0, lastActivityAt);
        session.thinking = activity.thinking;
        session.pendingOutbox = activity.pendingOutbox;
        session.activityReportedAt = activityReportedAt;
        updateDaemonSessionActivity({
          sessionId: activity.sessionId,
          lastActivityAt: session.lastActivityAt,
          thinking: activity.thinking,
          pendingOutbox: activity.pendingOutbox,
          reportedAt: activityReportedAt,
        });
        return;
      }
      logger.debug(`[DAEMON RUN] Ignoring activity for untracked session ${activity.sessionId}`);
    };

    // Spawn a new session (sessionId reserved for future --resume functionality)
    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      logger.debug('[DAEMON RUN] Spawning session', {
        directory: options.directory,
        sessionId: options.sessionId,
        machineId: options.machineId,
        approvedNewDirectoryCreation: options.approvedNewDirectoryCreation,
        agent: options.agent,
        hasToken: typeof options.token === 'string' && options.token.length > 0,
        environmentVariableKeys: Object.keys(options.environmentVariables ?? {}),
        environmentVariablesMode: options.environmentVariablesMode ?? 'replace',
        codexMcpServerNames: Object.keys(options.codexMcpServers ?? {}),
        codexUseBuiltInHappyMcp: options.codexUseBuiltInHappyMcp,
        requiredTerminalProtocol: options.requiredTerminalProtocol,
      });

      const protocolValidationError = validateRequiredTerminalProtocol(options);
      if (protocolValidationError) {
        return { type: 'error', errorMessage: protocolValidationError };
      }

      const { directory, sessionId, machineId, approvedNewDirectoryCreation = true } = options;
      let directoryCreated = false;

      const finishSpawn = beginTrackedSpawn();
      try {
        try {
          await fs.access(directory);
          logger.debug(`[DAEMON RUN] Directory exists: ${directory}`);
        } catch (error) {
          logger.debug(`[DAEMON RUN] Directory doesn't exist, creating: ${directory}`);

          // Check if directory creation is approved
          if (!approvedNewDirectoryCreation) {
            logger.debug(`[DAEMON RUN] Directory creation not approved for: ${directory}`);
            return {
              type: 'requestToApproveDirectoryCreation',
              directory
            };
          }

          try {
            await fs.mkdir(directory, { recursive: true });
            logger.debug(`[DAEMON RUN] Successfully created directory: ${directory}`);
            directoryCreated = true;
          } catch (mkdirError: any) {
            let errorMessage = `Unable to create directory at '${directory}'. `;

            // Provide more helpful error messages based on the error code
            if (mkdirError.code === 'EACCES') {
              errorMessage += `Permission denied. You don't have write access to create a folder at this location. Try using a different path or check your permissions.`;
            } else if (mkdirError.code === 'ENOTDIR') {
              errorMessage += `A file already exists at this path or in the parent path. Cannot create a directory here. Please choose a different location.`;
            } else if (mkdirError.code === 'ENOSPC') {
              errorMessage += `No space left on device. Your disk is full. Please free up some space and try again.`;
            } else if (mkdirError.code === 'EROFS') {
              errorMessage += `The file system is read-only. Cannot create directories here. Please choose a writable location.`;
            } else {
              errorMessage += `System error: ${mkdirError.message || mkdirError}. Please verify the path is valid and you have the necessary permissions.`;
            }

            logger.debug(`[DAEMON RUN] Directory creation failed: ${errorMessage}`);
            return {
              type: 'error',
              errorMessage
            };
          }
        }

        // Resolve explicit authentication first; the shared environment
        // builder applies it after local/request profile and runtime settings.
        const authEnv: Record<string, string> = {};
        if (options.token) {
          if (options.agent === 'codex') {

            // Create a temporary directory for Codex
            const codexHomeDir = tmp.dirSync();

            // Write the token to the temporary directory
            fs.writeFile(join(codexHomeDir.name, 'auth.json'), options.token);

            // Set the environment variable for Codex
            authEnv.CODEX_HOME = codexHomeDir.name;
          } else { // Assuming claude
            authEnv.CLAUDE_CODE_OAUTH_TOKEN = options.token;
          }
        }

        const runtimeEnv: Record<string, string> = {};
        if (options.agent === 'codex' && options.codexMcpServers && Object.keys(options.codexMcpServers).length > 0) {
          runtimeEnv[CODEX_EXTERNAL_MCP_SERVERS_ENV] = JSON.stringify(options.codexMcpServers);
        }
        if (options.agent === 'codex' && options.codexUseBuiltInHappyMcp === false) {
          runtimeEnv[CODEX_USE_BUILTIN_HAPPY_MCP_ENV] = '0';
        } else if (options.agent === 'codex' && options.codexUseBuiltInHappyMcp === true) {
          runtimeEnv[CODEX_USE_BUILTIN_HAPPY_MCP_ENV] = '1';
        }

        const agent = options.agent ?? 'claude';
        const builtEnvironment = await buildAgentEnvironment({
          agent,
          environmentVariables: options.environmentVariables,
          environmentVariablesMode: options.environmentVariablesMode,
          runtimeEnvironmentVariables: runtimeEnv,
          authenticationEnvironmentVariables: authEnv,
          loadLocalProfileEnvironment: getActiveProfileEnvironmentVariablesForAgent,
        });
        const extraEnv = builtEnvironment.extraEnvironmentVariables;
        logger.debug(`[DAEMON RUN] Effective profile source: ${builtEnvironment.profileSource}`);
        logger.debug(`[DAEMON RUN] Final environment variable keys (${Object.keys(extraEnv).length}): ${Object.keys(extraEnv).join(', ')}`);

        if (options.agent === 'codex') {
          await prepareIsolatedCodexHome(extraEnv);
        }

        // Fail-fast validation: Check that any auth variables present are fully expanded
        // Only validate variables that are actually set (different agents need different auth)
        const potentialAuthVars = ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_HOME', 'AZURE_OPENAI_API_KEY', 'TOGETHER_API_KEY'];
        const unexpandedAuthVars = potentialAuthVars.filter(varName => {
          const value = extraEnv[varName];
          // Only fail if variable IS SET and contains unexpanded ${VAR} references
          return value && typeof value === 'string' && value.includes('${');
        });

        if (unexpandedAuthVars.length > 0) {
          // Extract the specific missing variable names from unexpanded references
          const missingVarDetails = unexpandedAuthVars.map(authVar => {
            const value = extraEnv[authVar];
            const unresolvedMatch = value?.match(/\$\{([A-Z_][A-Z0-9_]*)(:-[^}]*)?\}/);
            const missingVar = unresolvedMatch ? unresolvedMatch[1] : 'unknown';
            return `${authVar} references \${${missingVar}} which is not defined`;
          });

          const errorMessage = `Authentication will fail - environment variables not found in daemon: ${missingVarDetails.join('; ')}. ` +
            `Ensure these variables are set in the daemon's environment (not just your shell) before starting sessions.`;
          logger.warn(`[DAEMON RUN] ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }

        // Check if tmux is available and should be used
        const tmuxAvailable = await isTmuxAvailable();
        let useTmux = tmuxAvailable;

        // Get tmux session name from environment variables (now set by profile system)
        // Empty string means "use current/most recent session" (tmux default behavior)
        let tmuxSessionName: string | undefined = extraEnv.TMUX_SESSION_NAME;

        // If tmux is not available or session name is explicitly undefined, fall back to regular spawning
        // Note: Empty string is valid (means use current/most recent tmux session)
        if (!tmuxAvailable || tmuxSessionName === undefined) {
          useTmux = false;
          if (tmuxSessionName !== undefined) {
            logger.debug(`[DAEMON RUN] tmux session name specified but tmux not available, falling back to regular spawning`);
          }
        }

        if (useTmux && tmuxSessionName !== undefined) {
          // Try to spawn in tmux session
          const sessionDesc = tmuxSessionName || 'current/most recent session';
          logger.debug(`[DAEMON RUN] Attempting to spawn session in tmux: ${sessionDesc}`);

          const tmux = getTmuxUtilities(tmuxSessionName);

          // Construct command for the CLI
          const cliPath = join(projectPath(), 'dist', 'index.mjs');
          // Determine agent command - support claude, codex, and gemini
          const agent = options.agent === 'gemini' ? 'gemini' : (options.agent === 'codex' ? 'codex' : 'claude');
          const fullCommand = `node --no-warnings --no-deprecation ${cliPath} ${agent} --happy-starting-mode remote --started-by daemon`;

          // Spawn in tmux with environment variables
          // IMPORTANT: Pass complete environment (process.env + extraEnv) because:
          // 1. tmux sessions need daemon's expanded auth variables (e.g., ANTHROPIC_AUTH_TOKEN)
          // 2. Regular spawn uses env: { ...process.env, ...extraEnv }
          // 3. tmux needs explicit environment via -e flags to ensure all variables are available
          const windowName = `happy-${Date.now()}-${agent}`;
          const tmuxEnv: Record<string, string> = {};

          // Add all daemon environment variables (filtering out undefined)
          for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
              tmuxEnv[key] = value;
            }
          }

          // Add extra environment variables (these should already be filtered)
          Object.assign(tmuxEnv, extraEnv);

          const tmuxResult = await tmux.spawnInTmux([fullCommand], {
            sessionName: tmuxSessionName,
            windowName: windowName,
            cwd: directory
          }, tmuxEnv);  // Pass complete environment for tmux session

          if (tmuxResult.success) {
            logger.debug(`[DAEMON RUN] Successfully spawned in tmux session: ${tmuxResult.sessionId}, PID: ${tmuxResult.pid}`);

            // Validate we got a PID from tmux
            if (!tmuxResult.pid) {
              throw new Error('Tmux window created but no PID returned');
            }

            const processBirthFingerprint = readProcessBirthFingerprint(tmuxResult.pid);
            if (!processBirthFingerprint) {
              try {
                process.kill(tmuxResult.pid, 'SIGTERM');
              } catch {}
              return {
                type: 'error',
                errorMessage: `Could not verify spawned process identity for PID ${tmuxResult.pid} (tmux)`,
              };
            }

            // Create a tracked session for tmux windows - now we have the real PID!
            const trackedSession: TrackedSession = {
              startedBy: 'daemon',
              pid: tmuxResult.pid, // Real PID from tmux -P flag
              trackingSource: 'memory',
              processBirthFingerprint,
              tmuxSessionId: tmuxResult.sessionId,
              directoryCreated,
              message: directoryCreated
                ? `The path '${directory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
                : `Spawned new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
            };

            // Add to tracking map so webhook can find it later
            pidToTrackedSession.set(tmuxResult.pid, trackedSession);

            // Wait for webhook to populate session with happySessionId (exact same as regular flow)
            logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxResult.pid} (tmux)`);

            const webhookResult = await waitForSessionWebhook({
              pid: tmuxResult.pid,
              timeoutMs: SESSION_WEBHOOK_TIMEOUT_MS,
              awaiters: pidToAwaiter,
              onTimeout: (pid) => {
                logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${pid} (tmux); terminating timed-out child`);
                stopSession(`PID-${pid}`);
              },
            });
            if (webhookResult.type === 'timeout') {
              return {
                type: 'error',
                errorMessage: `Session webhook timeout for PID ${tmuxResult.pid} (tmux)`
              };
            }
            logger.debug(`[DAEMON RUN] Session ${webhookResult.session.happySessionId} fully spawned with webhook (tmux)`);
            const attested = attestedSpawnResult(
              webhookResult.session,
              options.requiredTerminalProtocol,
            );
            if (attested.type === 'error') stopSession(`PID-${tmuxResult.pid}`);
            return attested;
          } else {
            logger.debug(`[DAEMON RUN] Failed to spawn in tmux: ${tmuxResult.error}, falling back to regular spawning`);
            useTmux = false;
          }
        }

        // Regular process spawning (fallback or if tmux not available)
        if (!useTmux) {
          logger.debug(`[DAEMON RUN] Using regular process spawning`);

          // Construct arguments for the CLI - support claude, codex, and gemini
          let agentCommand: string;
          switch (options.agent) {
            case 'claude':
            case undefined:
              agentCommand = 'claude';
              break;
            case 'codex':
              agentCommand = 'codex';
              break;
            case 'gemini':
              agentCommand = 'gemini';
              break;
            default:
              return {
                type: 'error',
                errorMessage: `Unsupported agent type: '${options.agent}'. Please update your CLI to the latest version.`
              };
          }
          const args = [
            agentCommand,
            '--happy-starting-mode', 'remote',
            '--started-by', 'daemon'
          ];

          // TODO: In future, sessionId could be used with --resume to continue existing sessions
          // For now, we ignore it - each spawn creates a new session
          const happyProcess = spawnHappyCLI(args, {
            cwd: directory,
            detached: true,  // Sessions stay alive when daemon stops
            stdio: ['ignore', 'pipe', 'pipe'],  // Capture stdout/stderr for debugging
            env: {
              ...process.env,
              ...extraEnv
            }
          });

          // Log output for debugging
          if (process.env.DEBUG) {
            happyProcess.stdout?.on('data', (data) => {
              logger.debug(`[DAEMON RUN] Child stdout: ${data.toString()}`);
            });
            happyProcess.stderr?.on('data', (data) => {
              logger.debug(`[DAEMON RUN] Child stderr: ${data.toString()}`);
            });
          }

          if (!happyProcess.pid) {
            logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
            return {
              type: 'error',
              errorMessage: 'Failed to spawn Happy process - no PID returned'
            };
          }

          const processBirthFingerprint = readProcessBirthFingerprint(happyProcess.pid);
          if (!processBirthFingerprint) {
            try {
              happyProcess.kill('SIGTERM');
            } catch {}
            return {
              type: 'error',
              errorMessage: `Could not verify spawned process identity for PID ${happyProcess.pid}`,
            };
          }

          logger.debug(`[DAEMON RUN] Spawned process with PID ${happyProcess.pid}`);

          const trackedSession: TrackedSession = {
            startedBy: 'daemon',
            pid: happyProcess.pid,
            trackingSource: 'memory',
            processBirthFingerprint,
            childProcess: happyProcess,
            directoryCreated,
            message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined
          };

          pidToTrackedSession.set(happyProcess.pid, trackedSession);

          happyProcess.on('exit', (code, signal) => {
            logger.debug(`[DAEMON RUN] Child PID ${happyProcess.pid} exited with code ${code}, signal ${signal}`);
            if (happyProcess.pid) {
              onChildExited(happyProcess.pid);
            }
          });

          happyProcess.on('error', (error) => {
            logger.debug(`[DAEMON RUN] Child process error:`, error);
            if (happyProcess.pid) {
              onChildExited(happyProcess.pid);
            }
          });

          // Wait for webhook to populate session with happySessionId
          logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${happyProcess.pid}`);

          const webhookResult = await waitForSessionWebhook({
            pid: happyProcess.pid,
            timeoutMs: SESSION_WEBHOOK_TIMEOUT_MS,
            awaiters: pidToAwaiter,
            onTimeout: (pid) => {
              logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${pid}; terminating timed-out child`);
              stopSession(`PID-${pid}`);
            },
          });
          if (webhookResult.type === 'timeout') {
            return {
              type: 'error',
              errorMessage: `Session webhook timeout for PID ${happyProcess.pid}`
            };
          }
          logger.debug(`[DAEMON RUN] Session ${webhookResult.session.happySessionId} fully spawned with webhook`);
          const attested = attestedSpawnResult(
            webhookResult.session,
            options.requiredTerminalProtocol,
          );
          if (attested.type === 'error') stopSession(`PID-${happyProcess.pid}`);
          return attested;
        }

        // This should never be reached, but TypeScript requires a return statement
        return {
          type: 'error',
          errorMessage: 'Unexpected error in session spawning'
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug('[DAEMON RUN] Failed to spawn session:', error);
        return {
          type: 'error',
          errorMessage: `Failed to spawn session: ${errorMessage}`
        };
      } finally {
        finishSpawn();
      }
    };

    // Stop a session by sessionId or PID fallback
    const stopSession = (sessionId: string): boolean => {
      logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

      // Try to find by sessionId first
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.happySessionId === sessionId ||
          (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {

          if (!trackedProcessIdentityMatches(pid, session)) {
            pidToTrackedSession.delete(pid);
            removeDaemonSessionRecord({ sessionId: session.happySessionId, pid });
            logger.debug(`[DAEMON RUN] Refused to stop PID ${pid} because its process-birth identity no longer matches`);
            return false;
          }

          let stopRequestAccepted = false;
          if (session.startedBy === 'daemon' && session.childProcess) {
            try {
              stopRequestAccepted = session.childProcess.kill('SIGTERM')
                || session.childProcess.exitCode !== null;
              logger.debug(`[DAEMON RUN] SIGTERM request for daemon-spawned session ${sessionId}: ${stopRequestAccepted ? 'accepted' : 'rejected'}`);
            } catch (error) {
              stopRequestAccepted = typeof error === 'object'
                && error !== null
                && 'code' in error
                && error.code === 'ESRCH';
              logger.debug(`[DAEMON RUN] Failed to kill session ${sessionId}:`, error);
            }
          } else {
            // For externally started sessions, try to kill by PID
            try {
              process.kill(pid, 'SIGTERM');
              stopRequestAccepted = true;
              logger.debug(`[DAEMON RUN] Sent SIGTERM to external session PID ${pid}`);
            } catch (error) {
              stopRequestAccepted = typeof error === 'object'
                && error !== null
                && 'code' in error
                && error.code === 'ESRCH';
              logger.debug(`[DAEMON RUN] Failed to kill external session PID ${pid}:`, error);
            }
          }

          if (!stopRequestAccepted) {
            logger.debug(`[DAEMON RUN] Keeping session ${sessionId} tracked because its stop request was not accepted`);
            return false;
          }

          pidToTrackedSession.delete(pid);
          removeDaemonSessionRecord({ sessionId, pid });
          logger.debug(`[DAEMON RUN] Removed session ${sessionId} from tracking`);
          return true;
        }
      }

      logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
      return false;
    };

    const sessionStatusForTracked = (
      sessionId: string,
      pid: number,
      session: TrackedSession,
    ): {
      sessionId: string;
      status: DaemonSessionStatus;
      pid?: number;
      startedBy?: string;
      trackingSource?: 'memory' | 'registry';
      terminalProtocol?: 1;
      sessionEncryption?: AgentPlaneSessionEncryptionAttestation;
    } => {
      if (!trackedProcessIdentityMatches(pid, session)) {
        pidToTrackedSession.delete(pid);
        removeDaemonSessionRecord({ sessionId: session.happySessionId, pid });
        logger.debug(`[DAEMON RUN] Withheld session status because process-birth identity no longer matches for PID ${pid}`);
        return { sessionId, status: 'unknown' };
      }
      const trackingSource = session.trackingSource ?? 'memory';
      return {
        sessionId,
        status: trackingSource === 'registry' ? 'recovered_alive' : 'tracked_alive',
        pid,
        startedBy: session.startedBy,
        trackingSource,
        terminalProtocol: session.terminalProtocol,
        sessionEncryption: session.sessionEncryption,
      };
    };

    const sessionStatusList = async (sessionIds: string[]) => {
      await reconcilePersistedSessions();
      return sessionIds.map((sessionId) => {
        for (const [pid, session] of pidToTrackedSession.entries()) {
          if (session.happySessionId === sessionId ||
            (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {
            return sessionStatusForTracked(sessionId, pid, session);
          }
        }
        return { sessionId, status: 'unknown' as const };
      });
    };

    // Handle child process exit
    const onChildExited = (pid: number) => {
      logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
      pidToTrackedSession.delete(pid);
      removeDaemonSessionRecord({ pid });
    };

    const buildPruneCandidates = (): DaemonSessionPruneCandidate[] => {
      const persistedBySessionId = new Map(
        readDaemonSessionRegistry().map((record) => [record.sessionId, record]),
      );
      const candidates: DaemonSessionPruneCandidate[] = [];
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (!session.happySessionId) continue;
        const persisted = persistedBySessionId.get(session.happySessionId);
        candidates.push({
          sessionId: session.happySessionId,
          pid,
          startedBy: session.startedBy,
          startedAt: persisted?.startedAt ?? Date.now(),
          lastActivityAt: session.lastActivityAt ?? persisted?.lastActivityAt,
          activityReportedAt: session.activityReportedAt ?? persisted?.activityReportedAt,
          thinking: session.thinking ?? persisted?.thinking,
          pendingOutbox: session.pendingOutbox ?? persisted?.pendingOutbox,
          processAlive: trackedProcessIdentityMatches(pid, session),
        });
      }
      return candidates;
    };

    const pruneSessions = async (
      request: DaemonSessionPruneRequest,
    ): Promise<DaemonSessionPruneExecutionResult> => {
      await reconcilePersistedSessions();
      const result = await executeDaemonSessionPrune(request, {
        getCandidates: buildPruneCandidates,
        inspectOutbox: inspectSessionMessageOutboxOnDisk,
        isProcessAlive: pidIsAlive,
        signal: (decision) => {
          const tracked = pidToTrackedSession.get(decision.pid);
          if (!tracked || tracked.happySessionId !== decision.sessionId) {
            throw new Error('Session is no longer tracked by this daemon');
          }
          if (!trackedProcessIdentityMatches(decision.pid, tracked)) {
            pidToTrackedSession.delete(decision.pid);
            removeDaemonSessionRecord({ sessionId: decision.sessionId, pid: decision.pid });
            throw new Error('Session process identity changed before termination');
          }
          try {
            const accepted = tracked.childProcess
              ? tracked.childProcess.kill('SIGTERM') || tracked.childProcess.exitCode !== null
              : (process.kill(decision.pid, 'SIGTERM'), true);
            if (!accepted) throw new Error('SIGTERM was rejected');
          } catch (error) {
            const alreadyExited = typeof error === 'object'
              && error !== null
              && 'code' in error
              && error.code === 'ESRCH';
            if (!alreadyExited) throw error;
          }
        },
        onTerminated: (decision) => {
          pidToTrackedSession.delete(decision.pid);
          removeDaemonSessionRecord({ sessionId: decision.sessionId, pid: decision.pid });
        },
      });
      logger.debugLargeJson('[DAEMON RUN] Session prune audit', result);
      return result;
    };

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown('happy-cli'),
      onHappySessionWebhook,
      onHappySessionActivity,
      pruneSessions,
    });

    // Write initial daemon state (no lock needed for state file)
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      daemonLogPath: logger.logFilePath
    };
    writeDaemonState(fileState);
    logger.debug('[DAEMON RUN] Daemon state written');

    // Prepare initial daemon state
    const initialDaemonState: DaemonState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now()
    };

    // Create API client
    const api = await ApiClient.create(credentials);

    // Get or create machine
    const machine = await api.getOrCreateMachine({
      machineId,
      metadata: initialMachineMetadata,
      daemonState: initialDaemonState
    });
    logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine, initialMachineMetadata);

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession,
      stopSession,
      sessionStatusList,
      providerReadiness,
      requestShutdown: () => requestShutdown('happy-app')
    });

    // Connect to server
    apiMachine.connect();

    let outboxReplayRunning = false;
    const replayOrphanedSessionOutboxes = async () => {
      if (outboxReplayRunning) return;
      outboxReplayRunning = true;
      try {
        discardTrackedSessionsWithInvalidProcessIdentity();
        const activeSessionIds = new Set(
          Array.from(pidToTrackedSession.values())
            .map((session) => session.happySessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
        );
        const result = await replayPendingSessionOutboxes(credentials.token, {
          excludeSessionIds: activeSessionIds,
          limit: 2,
        });
        if (result.attemptedSessions > 0) {
          logger.debug('[DAEMON RUN] Orphaned outbox replay pass completed', result);
        }
      } catch (error) {
        logger.debug('[DAEMON RUN] Orphaned outbox replay pass failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        outboxReplayRunning = false;
      }
    };
    const initialOutboxReplay = setTimeout(
      () => void replayOrphanedSessionOutboxes(),
      Math.floor(Math.random() * 5_001),
    );
    initialOutboxReplay.unref?.();

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const heartbeatIntervalMs = parseInt(process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL || '60000');
    let heartbeatRunning = false
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      // Prune stale sessions
      discardTrackedSessionsWithInvalidProcessIdentity();

      const expiryDecisions = selectDaemonSessionsForExpiry(
        Array.from(pidToTrackedSession.values()),
        Date.now(),
        sessionLifecyclePolicy,
      );
      for (const decision of expiryDecisions) {
        logger.debug(`[DAEMON RUN] Expiring safe idle daemon session PID ${decision.pid} (${decision.reason})`);
        stopSession(`PID-${decision.pid}`);
      }
      void replayOrphanedSessionOutboxes();

      // Check if daemon needs update
      // If version on disk is different from the one in package.json - we need to restart
      // BIG if - does this get updated from underneath us on npm upgrade?
      const projectVersion = JSON.parse(readFileSync(join(projectPath(), 'package.json'), 'utf-8')).version;
      if (projectVersion !== configuration.currentCliVersion) {
        const activeSessionCount = pidToTrackedSession.size;
        if (spawnInFlight > 0 || activeSessionCount > 0) {
          logger.debug(`[DAEMON RUN] Daemon is outdated, but restart is postponed because spawnInFlight=${spawnInFlight}, activeSessions=${activeSessionCount}`);
          heartbeatRunning = false;
          return;
        }

        logger.debug('[DAEMON RUN] Daemon is outdated, triggering self-restart with latest version, clearing heartbeat interval');

        clearInterval(restartOnStaleVersionAndHeartbeat);

        // Spawn new daemon through the CLI
        // We do not need to clean ourselves up - we will be killed by
        // the CLI start command.
        // 1. It will first check if daemon is running (yes in this case)
        // 2. If the version is stale (it will read daemon.state.json file and check startedWithCliVersion) & compare it to its own version
        // 3. Next it will start a new daemon with the latest version with daemon-sync :D
        // Done!
        try {
          spawnHappyCLI(['daemon', 'start'], {
            detached: true,
            stdio: 'ignore'
          });
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to spawn new daemon, this is quite likely to happen during integration tests as we are cleaning out dist/ directory', error);
        }

        // So we can just hang forever
        logger.debug('[DAEMON RUN] Hanging for a bit - waiting for CLI to kill us because we are running outdated version of the code');
        await new Promise(resolve => setTimeout(resolve, 10_000));
        process.exit(0);
      }

      // Before wrecklessly overriting the daemon state file, we should check if we are the ones who own it
      // Race condition is possible, but thats okay for the time being :D
      const daemonState = await readDaemonState();
      if (daemonState && daemonState.pid !== process.pid) {
        logger.debug('[DAEMON RUN] Somehow a different daemon was started without killing us. We should kill ourselves.')
        requestShutdown('exception', 'A different daemon was started without killing us. We should kill ourselves.')
      }

      // Heartbeat
      try {
        const updatedState: DaemonLocallyPersistedState = {
          pid: process.pid,
          httpPort: controlPort,
          startTime: fileState.startTime,
          startedWithCliVersion: packageJson.version,
          lastHeartbeat: new Date().toLocaleString(),
          daemonLogPath: fileState.daemonLogPath
        };
        writeDaemonState(updatedState);
        if (process.env.DEBUG) {
          logger.debug(`[DAEMON RUN] Health check completed at ${updatedState.lastHeartbeat}`);
        }
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to write heartbeat', error);
      }

      heartbeatRunning = false;
    }, heartbeatIntervalMs); // Every 60 seconds in production

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      // Clear health check interval
      if (restartOnStaleVersionAndHeartbeat) {
        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }
      clearTimeout(initialOutboxReplay);

      // Update daemon state before shutting down
      await apiMachine.updateDaemonState((state: DaemonState | null) => ({
        ...state,
        status: 'shutting-down',
        shutdownRequestedAt: Date.now(),
        shutdownSource: source
      }));

      // Give time for metadata update to send
      await new Promise(resolve => setTimeout(resolve, 100));

      apiMachine.shutdown();
      await stopControlServer();
      await cleanupDaemonState();
      await stopCaffeinate();
      await releaseDaemonLock(daemonLockHandle);

      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
      process.exit(0);
    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Non-blocking Claude Code version check
    checkClaudeVersion().then(result => {
      if (result?.isOutdated) {
        logger.info(`[DAEMON RUN] Claude Code outdated: ${result.installedVersion} -> ${result.latestVersion}`);
        logger.info(`[DAEMON RUN] Update: ${result.updateCommand}`);
        apiMachine.updateMachineMetadata((metadata) => ({
          ...(metadata ?? {}),
          ...initialMachineMetadata,
          claudeCodeVersion: result.installedVersion,
          claudeCodeLatestVersion: result.latestVersion,
          claudeCodeUpdateCommand: result.updateCommand,
        }));
      } else if (result) {
        logger.debug(`[DAEMON RUN] Claude Code ${result.installedVersion} is up to date`);
      }
    }).catch(() => {});

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    process.exit(1);
  }
}
