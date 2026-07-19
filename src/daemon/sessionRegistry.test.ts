import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readDaemonSessionRegistry,
  removeDaemonSessionRecord,
  updateDaemonSessionActivity,
  upsertDaemonSessionRecord,
  writeDaemonSessionRegistry,
} from './sessionRegistry';

let testDirs: string[] = [];

function registryPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'happy-daemon-session-registry-'));
  testDirs.push(dir);
  return join(dir, 'daemon.sessions.json');
}

afterEach(() => {
  for (const dir of testDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  testDirs = [];
});

describe('daemon session registry', () => {
  it('persists and reads session records', () => {
    const path = registryPath();
    writeDaemonSessionRegistry([
      {
        sessionId: 'sid_1',
        pid: 123,
        startedBy: 'daemon',
        path: '/tmp/work',
        flavor: 'codex',
        terminalProtocol: 1,
        startedAt: 100,
        updatedAt: 100,
      },
    ], path);

    expect(readDaemonSessionRegistry(path)).toEqual([
      {
        sessionId: 'sid_1',
        pid: 123,
        startedBy: 'daemon',
        path: '/tmp/work',
        flavor: 'codex',
        terminalProtocol: 1,
        startedAt: 100,
        updatedAt: 100,
      },
    ]);
  });

  it('persists protocol proof only when reported by the exact session process', () => {
    const path = registryPath();
    const attested = upsertDaemonSessionRecord({
      sessionId: 'sid_v1',
      pid: 333,
      startedBy: 'daemon',
      metadata: {
        hostPid: 333,
        path: '/tmp/v1',
        flavor: 'claude',
        terminalProtocol: 1,
      } as any,
    }, path);
    expect(attested.terminalProtocol).toBe(1);
    expect(readDaemonSessionRegistry(path)[0]?.terminalProtocol).toBe(1);

    const legacyReplacement = upsertDaemonSessionRecord({
      sessionId: 'sid_v1',
      pid: 444,
      startedBy: 'daemon',
      metadata: {
        hostPid: 444,
        path: '/tmp/legacy',
        flavor: 'claude',
      } as any,
    }, path);
    expect(legacyReplacement).not.toHaveProperty('terminalProtocol');
  });

  it('upserts by session id and pid', () => {
    const path = registryPath();
    upsertDaemonSessionRecord({
      sessionId: 'sid_1',
      pid: 123,
      startedBy: 'daemon',
      metadata: { hostPid: 123, path: '/tmp/one', flavor: 'codex' } as any,
    }, path);
    const first = readDaemonSessionRegistry(path)[0];

    upsertDaemonSessionRecord({
      sessionId: 'sid_1',
      pid: 456,
      startedBy: 'daemon',
      metadata: { hostPid: 456, path: '/tmp/two', flavor: 'claude' } as any,
    }, path);

    expect(readDaemonSessionRegistry(path)).toEqual([
      expect.objectContaining({
        sessionId: 'sid_1',
        pid: 456,
        startedBy: 'daemon',
        path: '/tmp/two',
        flavor: 'claude',
        startedAt: first?.startedAt,
      }),
    ]);
  });

  it('removes records by session id or pid', () => {
    const path = registryPath();
    writeDaemonSessionRegistry([
      { sessionId: 'sid_1', pid: 123, startedBy: 'daemon', startedAt: 100, updatedAt: 100 },
      { sessionId: 'sid_2', pid: 456, startedBy: 'daemon', startedAt: 200, updatedAt: 200 },
    ], path);

    removeDaemonSessionRecord({ sessionId: 'sid_1' }, path);
    expect(readDaemonSessionRegistry(path)).toHaveLength(1);
    expect(readDaemonSessionRegistry(path)[0]?.sessionId).toBe('sid_2');

    removeDaemonSessionRecord({ pid: 456 }, path);
    expect(readDaemonSessionRegistry(path)).toEqual([]);
  });

  it('persists thinking, activity, and durable outbox depth', () => {
    const path = registryPath();
    upsertDaemonSessionRecord({
      sessionId: 'sid_activity',
      pid: 789,
      startedBy: 'daemon',
    }, path);

    const updated = updateDaemonSessionActivity({
      sessionId: 'sid_activity',
      lastActivityAt: 1234,
      thinking: true,
      pendingOutbox: 3,
      reportedAt: 5678,
    }, path);

    expect(updated).toEqual(expect.objectContaining({
      lastActivityAt: expect.any(Number),
      thinking: true,
      pendingOutbox: 3,
      activityReportedAt: 5678,
    }));
    expect(readDaemonSessionRegistry(path)[0]).toEqual(expect.objectContaining({
      thinking: true,
      pendingOutbox: 3,
      activityReportedAt: 5678,
    }));
  });

  it('keeps safety state unknown until an explicit report and resets it for a new pid', () => {
    const path = registryPath();
    const initial = upsertDaemonSessionRecord({
      sessionId: 'sid_unknown',
      pid: 101,
      startedBy: 'daemon',
    }, path);
    expect(initial).not.toHaveProperty('lastActivityAt');
    expect(initial).not.toHaveProperty('thinking');
    expect(initial).not.toHaveProperty('pendingOutbox');
    expect(initial).not.toHaveProperty('activityReportedAt');

    updateDaemonSessionActivity({
      sessionId: 'sid_unknown',
      lastActivityAt: 100,
      thinking: false,
      pendingOutbox: 0,
      reportedAt: 200,
    }, path);
    const replacement = upsertDaemonSessionRecord({
      sessionId: 'sid_unknown',
      pid: 202,
      startedBy: 'daemon',
    }, path);
    expect(replacement).not.toHaveProperty('thinking');
    expect(replacement).not.toHaveProperty('pendingOutbox');
    expect(replacement).not.toHaveProperty('activityReportedAt');
  });
});
