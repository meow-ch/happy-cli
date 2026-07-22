/** Strict CLI parsing for the deliberately fail-closed prune operation. */

import {
  LEGACY_PRUNE_SAFETY_ATTESTATION,
  MAX_DAEMON_PRUNE_BATCH_SIZE,
  MIN_DAEMON_PRUNE_AGE_MS,
  type DaemonSessionPruneRequest,
} from './sessionPruning';

function requiredNonNegativeInteger(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a non-negative integer`);
  }
  return parsed;
}

export function parseDaemonPruneArguments(args: string[]): DaemonSessionPruneRequest {
  const request: DaemonSessionPruneRequest = {
    apply: false,
    includeLegacy: false,
    protectedSessionIds: [],
  };
  let confirmedNoActiveSessions = false;
  let attestedAllActiveSessionsProtected = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--dry-run':
        request.apply = false;
        break;
      case '--apply':
        request.apply = true;
        break;
      case '--include-legacy':
        request.includeLegacy = true;
        break;
      case '--protect-session': {
        const sessionId = args[index + 1];
        if (!sessionId || sessionId.startsWith('--')) {
          throw new Error('--protect-session requires a session ID');
        }
        request.protectedSessionIds!.push(sessionId);
        index += 1;
        break;
      }
      case '--confirm-no-active-sessions':
        confirmedNoActiveSessions = true;
        attestedAllActiveSessionsProtected = true;
        request.confirmedNoActiveSessions = true;
        break;
      case '--attest-all-active-sessions-protected':
        attestedAllActiveSessionsProtected = true;
        break;
      case '--min-age-ms':
        request.minAgeMs = requiredNonNegativeInteger(argument, args[index + 1]);
        if (request.minAgeMs < MIN_DAEMON_PRUNE_AGE_MS) {
          throw new Error(`--min-age-ms must be at least ${MIN_DAEMON_PRUNE_AGE_MS}`);
        }
        index += 1;
        break;
      case '--batch-size':
        request.batchSize = requiredNonNegativeInteger(argument, args[index + 1]);
        if (request.batchSize < 1 || request.batchSize > MAX_DAEMON_PRUNE_BATCH_SIZE) {
          throw new Error(`--batch-size must be between 1 and ${MAX_DAEMON_PRUNE_BATCH_SIZE}`);
        }
        index += 1;
        break;
      default:
        throw new Error(`Unknown prune-sessions argument: ${argument}`);
    }
  }

  const hasProtectedSessions = request.protectedSessionIds!.length > 0;
  if (confirmedNoActiveSessions && hasProtectedSessions) {
    throw new Error('--confirm-no-active-sessions cannot be combined with --protect-session');
  }
  if (request.includeLegacy) {
    if (!attestedAllActiveSessionsProtected) {
      throw new Error(
        '--include-legacy requires --attest-all-active-sessions-protected or --confirm-no-active-sessions',
      );
    }
    if (!confirmedNoActiveSessions && !hasProtectedSessions) {
      throw new Error(
        '--attest-all-active-sessions-protected requires at least one --protect-session; '
        + 'use --confirm-no-active-sessions only after verifying none are active',
      );
    }
    request.legacySafetyAttestation = LEGACY_PRUNE_SAFETY_ATTESTATION;
  }
  return request;
}
