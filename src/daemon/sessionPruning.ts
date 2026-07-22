/**
 * Auditable manual pruning for daemon-owned sessions.
 *
 * Normal lifecycle expiry still requires a fresh child safety report. Legacy
 * children cannot produce that report, so they are eligible only after an
 * operator explicitly attests that every active session was protected. Both
 * reported and legacy candidates remain fail-closed on durable outbox state.
 */

import type { SessionMessageOutboxDiskInspection } from '@/api/sessionMessageOutbox';
import {
  DEFAULT_DAEMON_SESSION_CAP_IDLE_GRACE_MS,
  DEFAULT_DAEMON_SESSION_IDLE_TTL_MS,
  DEFAULT_DAEMON_SESSION_SAFE_REPORT_MAX_AGE_MS,
} from './sessionLifecycle';

export const LEGACY_PRUNE_SAFETY_ATTESTATION = 'all-active-sessions-protected' as const;
export const DEFAULT_DAEMON_PRUNE_BATCH_SIZE = 16;
export const MAX_DAEMON_PRUNE_BATCH_SIZE = 64;
export const MIN_DAEMON_PRUNE_AGE_MS = DEFAULT_DAEMON_SESSION_CAP_IDLE_GRACE_MS;
/**
 * Claude's graceful shutdown can spend up to ten seconds flushing each of its
 * durable/socket stages. Prune waits for both stages, but does so in parallel
 * for the whole bounded batch.
 */
export const DEFAULT_DAEMON_PRUNE_TERMINATION_TIMEOUT_MS = 25_000;
export const DEFAULT_DAEMON_PRUNE_TERMINATION_POLL_MS = 50;

export interface DaemonSessionPruneCandidate {
  sessionId: string;
  pid: number;
  startedBy: string;
  startedAt: number;
  lastActivityAt?: number;
  activityReportedAt?: number;
  thinking?: boolean;
  pendingOutbox?: number;
  processAlive: boolean;
}

export interface DaemonSessionPruneRequest {
  apply?: boolean;
  includeLegacy?: boolean;
  legacySafetyAttestation?: typeof LEGACY_PRUNE_SAFETY_ATTESTATION;
  confirmedNoActiveSessions?: boolean;
  protectedSessionIds?: string[];
  minAgeMs?: number;
  safeReportMaxAgeMs?: number;
  batchSize?: number;
}

export type DaemonSessionPruneReason =
  | 'protected'
  | 'not-daemon-owned'
  | 'process-not-alive'
  | 'process-identity-changed'
  | 'too-young'
  | 'thinking'
  | 'reported-pending-outbox'
  | 'disk-outbox-not-empty'
  | 'safe-report-stale-or-missing'
  | 'legacy-attestation-required'
  | 'safe-idle-report'
  | 'operator-attested-legacy-idle'
  | 'batch-limit';

export interface DaemonSessionPruneDecision {
  sessionId: string;
  pid: number;
  outcome: 'eligible' | 'rejected';
  reason: DaemonSessionPruneReason;
  legacy: boolean;
  ageMs: number;
  diskOutbox: SessionMessageOutboxDiskInspection;
}

export interface DaemonSessionPrunePlan {
  generatedAt: number;
  apply: boolean;
  batchSize: number;
  decisions: DaemonSessionPruneDecision[];
}

export interface DaemonSessionPruneExecutionResult extends DaemonSessionPrunePlan {
  terminatedCount: number;
  terminationFailureCount: number;
  decisions: Array<DaemonSessionPruneDecision & {
    termination?: 'terminated' | 'failed';
  }>;
}

export interface DaemonSessionPruneExecutionDependencies {
  /** Must return a synchronous snapshot so safety can be rechecked immediately before SIGTERM. */
  getCandidates: () => DaemonSessionPruneCandidate[];
  inspectOutbox: (sessionId: string) => SessionMessageOutboxDiskInspection;
  signal: (decision: DaemonSessionPruneDecision) => void;
  isProcessAlive: (pid: number) => boolean;
  onTerminated: (decision: DaemonSessionPruneDecision) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  terminationTimeoutMs?: number;
  terminationPollMs?: number;
}

function boundedBatchSize(value: number | undefined): number {
  if (!Number.isInteger(value) || value! <= 0) return DEFAULT_DAEMON_PRUNE_BATCH_SIZE;
  return Math.min(MAX_DAEMON_PRUNE_BATCH_SIZE, value!);
}

function nonNegative(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! >= 0 ? Math.floor(value!) : fallback;
}

export function planDaemonSessionPrune(
  candidates: DaemonSessionPruneCandidate[],
  request: DaemonSessionPruneRequest,
  inspectOutbox: (sessionId: string) => SessionMessageOutboxDiskInspection,
  now = Date.now(),
): DaemonSessionPrunePlan {
  const protectedIds = new Set(request.protectedSessionIds ?? []);
  const legacySafetyAccountingIsValid = request.legacySafetyAttestation
    === LEGACY_PRUNE_SAFETY_ATTESTATION
    && (
      (request.confirmedNoActiveSessions === true && protectedIds.size === 0)
      || (request.confirmedNoActiveSessions !== true && protectedIds.size > 0)
    );
  const minAgeMs = Math.max(
    MIN_DAEMON_PRUNE_AGE_MS,
    nonNegative(request.minAgeMs, DEFAULT_DAEMON_SESSION_IDLE_TTL_MS),
  );
  const safeReportMaxAgeMs = nonNegative(
    request.safeReportMaxAgeMs,
    DEFAULT_DAEMON_SESSION_SAFE_REPORT_MAX_AGE_MS,
  );
  const batchSize = boundedBatchSize(request.batchSize);
  let eligibleCount = 0;

  const ordered = [...candidates].sort((left, right) => {
    const leftActivity = left.lastActivityAt ?? left.startedAt;
    const rightActivity = right.lastActivityAt ?? right.startedAt;
    return leftActivity - rightActivity || left.sessionId.localeCompare(right.sessionId);
  });

  const decisions = ordered.map((candidate): DaemonSessionPruneDecision => {
    const diskOutbox = inspectOutbox(candidate.sessionId);
    const lastKnownActivity = candidate.lastActivityAt ?? candidate.startedAt;
    const ageMs = Math.max(0, now - lastKnownActivity);
    const legacy = candidate.thinking === undefined
      || candidate.pendingOutbox === undefined
      || candidate.activityReportedAt === undefined;
    const rejected = (reason: DaemonSessionPruneReason): DaemonSessionPruneDecision => ({
      sessionId: candidate.sessionId,
      pid: candidate.pid,
      outcome: 'rejected',
      reason,
      legacy,
      ageMs,
      diskOutbox,
    });

    if (protectedIds.has(candidate.sessionId)) return rejected('protected');
    if (candidate.startedBy !== 'daemon') return rejected('not-daemon-owned');
    if (!candidate.processAlive) return rejected('process-not-alive');
    if (ageMs < minAgeMs) return rejected('too-young');
    if (candidate.thinking === true) return rejected('thinking');
    if ((candidate.pendingOutbox ?? 0) > 0) return rejected('reported-pending-outbox');
    if (!diskOutbox.safeToTerminate) return rejected('disk-outbox-not-empty');

    let eligibleReason: DaemonSessionPruneReason;
    if (!legacy) {
      const reportAge = now - candidate.activityReportedAt!;
      if (reportAge < 0 || reportAge > safeReportMaxAgeMs) {
        return rejected('safe-report-stale-or-missing');
      }
      eligibleReason = 'safe-idle-report';
    } else {
      if (!request.includeLegacy
        || !legacySafetyAccountingIsValid) {
        return rejected('legacy-attestation-required');
      }
      eligibleReason = 'operator-attested-legacy-idle';
    }

    if (eligibleCount >= batchSize) return rejected('batch-limit');
    eligibleCount += 1;
    return {
      sessionId: candidate.sessionId,
      pid: candidate.pid,
      outcome: 'eligible',
      reason: eligibleReason,
      legacy,
      ageMs,
      diskOutbox,
    };
  });

  return {
    generatedAt: now,
    apply: request.apply === true,
    batchSize,
    decisions,
  };
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

/**
 * Executes the auditable plan while keeping the final safety gate adjacent to
 * the signal. A timed-out process remains tracked and is never reported as
 * terminated; a later operator run may inspect it again explicitly.
 */
export async function executeDaemonSessionPrune(
  request: DaemonSessionPruneRequest,
  dependencies: DaemonSessionPruneExecutionDependencies,
): Promise<DaemonSessionPruneExecutionResult> {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep
    ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const terminationTimeoutMs = positiveDuration(
    dependencies.terminationTimeoutMs,
    DEFAULT_DAEMON_PRUNE_TERMINATION_TIMEOUT_MS,
  );
  const terminationPollMs = positiveDuration(
    dependencies.terminationPollMs,
    DEFAULT_DAEMON_PRUNE_TERMINATION_POLL_MS,
  );
  const plan = planDaemonSessionPrune(
    dependencies.getCandidates(),
    request,
    dependencies.inspectOutbox,
    now(),
  );
  const decisions: DaemonSessionPruneExecutionResult['decisions'] = plan.decisions
    .map((decision) => ({ ...decision }));
  let terminatedCount = 0;
  let terminationFailureCount = 0;
  const signaled: Array<{
    decision: DaemonSessionPruneExecutionResult['decisions'][number];
    pid: number;
  }> = [];

  if (request.apply === true) {
    for (const decision of decisions) {
      if (decision.outcome !== 'eligible') continue;

      const current = dependencies.getCandidates()
        .find((candidate) => candidate.sessionId === decision.sessionId);
      if (current && current.pid !== decision.pid) {
        decision.outcome = 'rejected';
        decision.reason = 'process-identity-changed';
        continue;
      }
      const fresh = current
        ? planDaemonSessionPrune(
          [current],
          { ...request, apply: true, batchSize: 1 },
          dependencies.inspectOutbox,
          now(),
        ).decisions[0]
        : undefined;
      if (!fresh || fresh.outcome !== 'eligible') {
        decision.outcome = 'rejected';
        decision.reason = fresh?.reason ?? 'process-not-alive';
        continue;
      }

      try {
        dependencies.signal(fresh);
        signaled.push({ decision, pid: decision.pid });
      } catch {
        decision.termination = 'failed';
        terminationFailureCount += 1;
      }
    }

    // Confirmation is parallel, making the worst-case duration one bounded
    // graceful-shutdown window rather than batchSize × timeout.
    await Promise.all(signaled.map(async ({ decision, pid }) => {
      const deadline = now() + terminationTimeoutMs;
      while (dependencies.isProcessAlive(pid) && now() < deadline) {
        await sleep(Math.min(terminationPollMs, Math.max(1, deadline - now())));
      }
      if (dependencies.isProcessAlive(pid)) {
        decision.termination = 'failed';
        terminationFailureCount += 1;
        return;
      }
      dependencies.onTerminated(decision);
      decision.termination = 'terminated';
      terminatedCount += 1;
    }));
  }

  return {
    ...plan,
    decisions,
    terminatedCount,
    terminationFailureCount,
  };
}
