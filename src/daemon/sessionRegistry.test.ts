import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readDaemonSessionRegistry,
  removeDaemonSessionRecord,
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
        startedAt: 100,
        updatedAt: 100,
      },
    ]);
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
});
