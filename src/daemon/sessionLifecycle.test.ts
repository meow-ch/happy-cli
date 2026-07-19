import { describe, expect, it } from 'vitest';
import { selectDaemonSessionsForExpiry } from './sessionLifecycle';

describe('daemon session lifecycle policy', () => {
  const now = 10_000;
  const policy = {
    idleTtlMs: 1_000,
    maxDaemonSessions: 2,
    capIdleGraceMs: 100,
    safeReportMaxAgeMs: 500,
  };

  it('expires only daemon-owned sessions with explicit safe idle evidence', () => {
    const decisions = selectDaemonSessionsForExpiry([
      { pid: 1, startedBy: 'daemon', lastActivityAt: 1, thinking: false, pendingOutbox: 0, activityReportedAt: now },
      { pid: 2, startedBy: 'terminal', lastActivityAt: 1, thinking: false, pendingOutbox: 0, activityReportedAt: now },
      { pid: 3, startedBy: 'daemon', lastActivityAt: 1, thinking: true, pendingOutbox: 0, activityReportedAt: now },
      { pid: 4, startedBy: 'daemon', lastActivityAt: 1, thinking: false, pendingOutbox: 1, activityReportedAt: now },
      { pid: 5, startedBy: 'daemon', lastActivityAt: 1, thinking: false },
      { pid: 6, startedBy: 'daemon', lastActivityAt: 1, thinking: false, pendingOutbox: 0, activityReportedAt: now - 501 },
    ], now, { ...policy, maxDaemonSessions: 10 });

    expect(decisions).toEqual([{ pid: 1, reason: 'idle-ttl' }]);
  });

  it('uses oldest safe-idle sessions to enforce the cap', () => {
    const decisions = selectDaemonSessionsForExpiry([
      { pid: 1, startedBy: 'daemon', lastActivityAt: 9_100, thinking: false, pendingOutbox: 0, activityReportedAt: now },
      { pid: 2, startedBy: 'daemon', lastActivityAt: 9_200, thinking: false, pendingOutbox: 0, activityReportedAt: now },
      { pid: 3, startedBy: 'daemon', lastActivityAt: 9_300, thinking: false, pendingOutbox: 0, activityReportedAt: now },
      { pid: 4, startedBy: 'daemon', lastActivityAt: 9_950, thinking: false, pendingOutbox: 0, activityReportedAt: now },
    ], now, policy);

    expect(decisions).toEqual([
      { pid: 1, reason: 'capacity' },
      { pid: 2, reason: 'capacity' },
    ]);
  });

  it('preserves active sessions even when the cap cannot safely be reached', () => {
    const decisions = selectDaemonSessionsForExpiry([
      { pid: 1, startedBy: 'daemon', lastActivityAt: now, thinking: true, pendingOutbox: 0, activityReportedAt: now },
      { pid: 2, startedBy: 'daemon', lastActivityAt: now, thinking: false, pendingOutbox: 2, activityReportedAt: now },
      { pid: 3, startedBy: 'daemon', lastActivityAt: now - 50, thinking: false, pendingOutbox: 0, activityReportedAt: now },
    ], now, { ...policy, maxDaemonSessions: 0 });

    expect(decisions).toEqual([]);
  });

  it('requires a fresh explicit safe-state report', () => {
    const decisions = selectDaemonSessionsForExpiry([
      { pid: 1, startedBy: 'daemon' },
      { pid: 2, startedBy: 'daemon', lastActivityAt: 1, thinking: false, pendingOutbox: 0 },
      { pid: 3, startedBy: 'daemon', lastActivityAt: 1, thinking: false, pendingOutbox: 0, activityReportedAt: now - 501 },
      { pid: 4, startedBy: 'daemon', lastActivityAt: 1, thinking: false, pendingOutbox: 0, activityReportedAt: now },
    ], now, { ...policy, maxDaemonSessions: 10 });

    expect(decisions).toEqual([{ pid: 4, reason: 'idle-ttl' }]);
  });
});
