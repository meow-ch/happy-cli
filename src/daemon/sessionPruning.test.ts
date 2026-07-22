import { describe, expect, it, vi } from 'vitest';
import type { SessionMessageOutboxDiskInspection } from '@/api/sessionMessageOutbox';
import {
  DEFAULT_DAEMON_PRUNE_TERMINATION_TIMEOUT_MS,
  executeDaemonSessionPrune,
  LEGACY_PRUNE_SAFETY_ATTESTATION,
  planDaemonSessionPrune,
  type DaemonSessionPruneCandidate,
} from './sessionPruning';

const now = 10_000_000;
const emptyOutbox = (sessionId: string): SessionMessageOutboxDiskInspection => ({
  sessionId,
  directoryExists: false,
  safeToTerminate: true,
  managedFileCount: 0,
  reason: 'empty',
});

function candidate(
  overrides: Partial<DaemonSessionPruneCandidate> = {},
): DaemonSessionPruneCandidate {
  return {
    sessionId: 'legacy-1',
    pid: 101,
    startedBy: 'daemon',
    startedAt: 1,
    processAlive: true,
    ...overrides,
  };
}

describe('manual daemon session pruning', () => {
  it('keeps legacy records fail-closed without the explicit safety attestation', () => {
    const plan = planDaemonSessionPrune(
      [candidate()],
      { includeLegacy: true, minAgeMs: 1 },
      emptyOutbox,
      now,
    );
    expect(plan.decisions[0]).toEqual(expect.objectContaining({
      outcome: 'rejected',
      reason: 'legacy-attestation-required',
    }));
  });

  it('enforces legacy active-session accounting in the daemon core', () => {
    const unaccounted = planDaemonSessionPrune(
      [candidate()],
      {
        includeLegacy: true,
        legacySafetyAttestation: LEGACY_PRUNE_SAFETY_ATTESTATION,
        minAgeMs: 1,
      },
      emptyOutbox,
      now,
    );
    expect(unaccounted.decisions[0]).toEqual(expect.objectContaining({
      outcome: 'rejected',
      reason: 'legacy-attestation-required',
    }));

    const confirmedEmpty = planDaemonSessionPrune(
      [candidate()],
      {
        includeLegacy: true,
        legacySafetyAttestation: LEGACY_PRUNE_SAFETY_ATTESTATION,
        confirmedNoActiveSessions: true,
        minAgeMs: 1,
      },
      emptyOutbox,
      now,
    );
    expect(confirmedEmpty.decisions[0]).toEqual(expect.objectContaining({
      outcome: 'eligible',
      reason: 'operator-attested-legacy-idle',
    }));
  });

  it('makes old attested legacy records finite while protecting named active sessions', () => {
    const plan = planDaemonSessionPrune(
      [
        candidate({ sessionId: 'active', pid: 1 }),
        candidate({ sessionId: 'old-idle', pid: 2 }),
      ],
      {
        includeLegacy: true,
        legacySafetyAttestation: LEGACY_PRUNE_SAFETY_ATTESTATION,
        protectedSessionIds: ['active'],
        minAgeMs: 1,
      },
      emptyOutbox,
      now,
    );
    expect(plan.decisions).toEqual([
      expect.objectContaining({ sessionId: 'active', outcome: 'rejected', reason: 'protected' }),
      expect.objectContaining({
        sessionId: 'old-idle',
        outcome: 'eligible',
        reason: 'operator-attested-legacy-idle',
      }),
    ]);
  });

  it('never selects thinking, reported-pending, or on-disk-pending sessions', () => {
    const inspect = (sessionId: string): SessionMessageOutboxDiskInspection => (
      sessionId === 'disk-pending'
        ? {
          sessionId,
          directoryExists: true,
          safeToTerminate: false,
          managedFileCount: 1,
          reason: 'managed-records-present',
        }
        : emptyOutbox(sessionId)
    );
    const plan = planDaemonSessionPrune([
      candidate({ sessionId: 'thinking', thinking: true, pendingOutbox: 0, activityReportedAt: now }),
      candidate({ sessionId: 'reported-pending', thinking: false, pendingOutbox: 2, activityReportedAt: now }),
      candidate({ sessionId: 'disk-pending', thinking: false, pendingOutbox: 0, activityReportedAt: now }),
    ], { minAgeMs: 1 }, inspect, now);

    expect(plan.decisions.map(({ reason }) => reason)).toEqual([
      'disk-outbox-not-empty',
      'reported-pending-outbox',
      'thinking',
    ]);
    expect(plan.decisions.every(({ outcome }) => outcome === 'rejected')).toBe(true);
  });

  it('enforces age, report freshness, and a bounded oldest-first batch', () => {
    const plan = planDaemonSessionPrune([
      candidate({ sessionId: 'oldest', pid: 1, lastActivityAt: 1, thinking: false, pendingOutbox: 0, activityReportedAt: now }),
      candidate({ sessionId: 'second', pid: 2, lastActivityAt: 2, thinking: false, pendingOutbox: 0, activityReportedAt: now }),
      candidate({ sessionId: 'stale', pid: 3, lastActivityAt: 3, thinking: false, pendingOutbox: 0, activityReportedAt: now - 1_001 }),
      candidate({ sessionId: 'young', pid: 4, lastActivityAt: now - 5, thinking: false, pendingOutbox: 0, activityReportedAt: now }),
    ], {
      minAgeMs: 10,
      safeReportMaxAgeMs: 1_000,
      batchSize: 1,
    }, emptyOutbox, now);

    expect(plan.decisions.map(({ sessionId, reason }) => [sessionId, reason])).toEqual([
      ['oldest', 'safe-idle-report'],
      ['second', 'batch-limit'],
      ['stale', 'safe-report-stale-or-missing'],
      ['young', 'too-young'],
    ]);
  });

  it('keeps dry-run side-effect free', async () => {
    const signal = vi.fn();
    const onTerminated = vi.fn();
    const safe = candidate({
      sessionId: 'safe',
      lastActivityAt: 1,
      thinking: false,
      pendingOutbox: 0,
      activityReportedAt: now,
    });

    const result = await executeDaemonSessionPrune({ minAgeMs: 1 }, {
      getCandidates: () => [safe],
      inspectOutbox: emptyOutbox,
      signal,
      isProcessAlive: () => true,
      onTerminated,
      now: () => now,
    });

    expect(result.decisions[0]).toEqual(expect.objectContaining({ outcome: 'eligible' }));
    expect(result.decisions[0]).not.toHaveProperty('termination');
    expect(signal).not.toHaveBeenCalled();
    expect(onTerminated).not.toHaveBeenCalled();
  });

  it('synchronously revalidates safety before signaling an apply plan', async () => {
    const signal = vi.fn();
    let snapshots = 0;
    const base = candidate({
      sessionId: 'changed',
      lastActivityAt: 1,
      thinking: false,
      pendingOutbox: 0,
      activityReportedAt: now,
    });

    const result = await executeDaemonSessionPrune({ apply: true, minAgeMs: 1 }, {
      getCandidates: () => {
        snapshots += 1;
        return [{ ...base, thinking: snapshots === 1 ? false : true }];
      },
      inspectOutbox: emptyOutbox,
      signal,
      isProcessAlive: () => true,
      onTerminated: vi.fn(),
      now: () => now,
    });

    expect(snapshots).toBeGreaterThanOrEqual(2);
    expect(signal).not.toHaveBeenCalled();
    expect(result.decisions[0]).toEqual(expect.objectContaining({
      outcome: 'rejected',
      reason: 'thinking',
    }));
  });

  it('rejects a session ID rebound to a replacement PID before signaling', async () => {
    const signal = vi.fn();
    let snapshots = 0;
    const base = candidate({
      sessionId: 'replaced',
      lastActivityAt: 1,
      thinking: false,
      pendingOutbox: 0,
      activityReportedAt: now,
    });

    const result = await executeDaemonSessionPrune({ apply: true, minAgeMs: 1 }, {
      getCandidates: () => {
        snapshots += 1;
        return [{ ...base, pid: snapshots === 1 ? 101 : 202 }];
      },
      inspectOutbox: emptyOutbox,
      signal,
      isProcessAlive: () => true,
      onTerminated: vi.fn(),
      now: () => now,
    });

    expect(signal).not.toHaveBeenCalled();
    expect(result.decisions[0]).toEqual(expect.objectContaining({
      pid: 101,
      outcome: 'rejected',
      reason: 'process-identity-changed',
    }));
  });

  it('signals once, waits for graceful exit, and only then removes tracking', async () => {
    let clock = now;
    let alive = true;
    const signal = vi.fn();
    const onTerminated = vi.fn();
    const safe = candidate({
      sessionId: 'graceful',
      lastActivityAt: 1,
      thinking: false,
      pendingOutbox: 0,
      activityReportedAt: now,
    });

    const result = await executeDaemonSessionPrune({ apply: true, minAgeMs: 1 }, {
      getCandidates: () => [safe],
      inspectOutbox: emptyOutbox,
      signal,
      isProcessAlive: () => alive,
      onTerminated,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
        if (clock >= now + 100) alive = false;
      },
      terminationTimeoutMs: 200,
      terminationPollMs: 25,
    });

    expect(signal).toHaveBeenCalledTimes(1);
    expect(onTerminated).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({
      terminatedCount: 1,
      terminationFailureCount: 0,
    }));
    expect(result.decisions[0].termination).toBe('terminated');
  });

  it('bounds exit confirmation without removing or repeatedly signaling a live child', async () => {
    let clock = now;
    const signal = vi.fn();
    const onTerminated = vi.fn();
    const safe = candidate({
      sessionId: 'stubborn',
      lastActivityAt: 1,
      thinking: false,
      pendingOutbox: 0,
      activityReportedAt: now,
    });

    const result = await executeDaemonSessionPrune({ apply: true, minAgeMs: 1 }, {
      getCandidates: () => [safe],
      inspectOutbox: emptyOutbox,
      signal,
      isProcessAlive: () => true,
      onTerminated,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      terminationTimeoutMs: 100,
      terminationPollMs: 25,
    });

    expect(signal).toHaveBeenCalledTimes(1);
    expect(onTerminated).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      terminatedCount: 0,
      terminationFailureCount: 1,
    }));
    expect(result.decisions[0].termination).toBe('failed');
    expect(DEFAULT_DAEMON_PRUNE_TERMINATION_TIMEOUT_MS).toBeGreaterThan(10_000);
  });
});
