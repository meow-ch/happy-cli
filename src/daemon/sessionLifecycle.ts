/**
 * Conservative daemon-session expiry policy.
 *
 * User-owned sessions are never eligible. Daemon-owned sessions must report
 * both non-thinking state and an empty durable outbox before TTL/cap cleanup
 * may terminate them.
 */

export interface SessionLifecycleCandidate {
  pid: number;
  startedBy: string;
  lastActivityAt?: number;
  thinking?: boolean;
  pendingOutbox?: number;
  activityReportedAt?: number;
}

export interface SessionLifecyclePolicy {
  idleTtlMs: number;
  maxDaemonSessions: number;
  capIdleGraceMs: number;
  safeReportMaxAgeMs: number;
}

export interface SessionExpiryDecision {
  pid: number;
  reason: 'idle-ttl' | 'capacity';
}

export const DEFAULT_DAEMON_SESSION_IDLE_TTL_MS = 6 * 60 * 60 * 1_000;
export const DEFAULT_MAX_DAEMON_SESSIONS = 32;
export const DEFAULT_DAEMON_SESSION_CAP_IDLE_GRACE_MS = 15 * 60 * 1_000;
export const DEFAULT_DAEMON_SESSION_SAFE_REPORT_MAX_AGE_MS = 2 * 60 * 1_000;

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function daemonSessionLifecyclePolicyFromEnvironment(): SessionLifecyclePolicy {
  return {
    idleTtlMs: nonNegativeInteger(
      process.env.HAPPY_DAEMON_SESSION_IDLE_TTL_MS,
      DEFAULT_DAEMON_SESSION_IDLE_TTL_MS,
    ),
    maxDaemonSessions: nonNegativeInteger(
      process.env.HAPPY_DAEMON_SESSION_MAX,
      DEFAULT_MAX_DAEMON_SESSIONS,
    ),
    capIdleGraceMs: nonNegativeInteger(
      process.env.HAPPY_DAEMON_SESSION_CAP_IDLE_GRACE_MS,
      DEFAULT_DAEMON_SESSION_CAP_IDLE_GRACE_MS,
    ),
    safeReportMaxAgeMs: nonNegativeInteger(
      process.env.HAPPY_DAEMON_SESSION_SAFE_REPORT_MAX_AGE_MS,
      DEFAULT_DAEMON_SESSION_SAFE_REPORT_MAX_AGE_MS,
    ),
  };
}

export function selectDaemonSessionsForExpiry(
  candidates: SessionLifecycleCandidate[],
  now: number,
  policy: SessionLifecyclePolicy,
): SessionExpiryDecision[] {
  const daemonOwned = candidates.filter((candidate) => candidate.startedBy === 'daemon');
  const safeIdle = daemonOwned
    .filter((candidate) => candidate.thinking === false
      && candidate.pendingOutbox === 0
      && typeof candidate.lastActivityAt === 'number'
      && Number.isFinite(candidate.lastActivityAt)
      && typeof candidate.activityReportedAt === 'number'
      && Number.isFinite(candidate.activityReportedAt)
      && candidate.activityReportedAt <= now
      && now - candidate.activityReportedAt <= policy.safeReportMaxAgeMs)
    .sort((left, right) => left.lastActivityAt! - right.lastActivityAt!);

  const decisions = new Map<number, SessionExpiryDecision>();
  for (const candidate of safeIdle) {
    if (now - candidate.lastActivityAt! >= policy.idleTtlMs) {
      decisions.set(candidate.pid, { pid: candidate.pid, reason: 'idle-ttl' });
    }
  }

  let survivors = daemonOwned.length - decisions.size;
  if (survivors > policy.maxDaemonSessions) {
    for (const candidate of safeIdle) {
      if (survivors <= policy.maxDaemonSessions) break;
      if (decisions.has(candidate.pid)) continue;
      if (now - candidate.lastActivityAt! < policy.capIdleGraceMs) continue;
      decisions.set(candidate.pid, { pid: candidate.pid, reason: 'capacity' });
      survivors -= 1;
    }
  }

  return Array.from(decisions.values());
}
