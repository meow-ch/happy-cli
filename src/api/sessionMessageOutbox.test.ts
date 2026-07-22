import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  discoverPendingSessionOutboxSessionIds,
  inspectSessionMessageOutboxOnDisk,
  SessionMessageOutbox,
} from './sessionMessageOutbox';

describe('SessionMessageOutbox', () => {
  const temporaryDirectories: string[] = [];

  function createRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'boujot-outbox-test-'));
    temporaryDirectories.push(root);
    return root;
  }

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists stable encrypted records and restores their original order', () => {
    const rootDirectory = createRoot();
    let now = 1_000;
    const ids = ['local-first', 'local-second'];
    const outbox = new SessionMessageOutbox('session-a', {
      rootDirectory,
      now: () => now++,
      createLocalId: () => ids.shift()!,
    });

    const first = outbox.enqueue('encrypted-first');
    const second = outbox.enqueue('encrypted-second');
    const restored = new SessionMessageOutbox('session-a', { rootDirectory });

    expect(restored.pendingRecords()).toEqual([first, second]);
    expect(restored.pendingRecords().map((record) => record.localId))
      .toEqual(['local-first', 'local-second']);
  });

  it('removes a record only when it is acknowledged', () => {
    const rootDirectory = createRoot();
    const outbox = new SessionMessageOutbox('session-b', { rootDirectory });
    const record = outbox.enqueue('encrypted-terminal-result', 'stable-terminal-id');

    expect(new SessionMessageOutbox('session-b', { rootDirectory }).pendingCount).toBe(1);
    expect(outbox.acknowledge(record.localId)).toBe(true);
    expect(new SessionMessageOutbox('session-b', { rootDirectory }).pendingCount).toBe(0);
  });

  it('does not resurrect an ACKed message from a redundant pre-rename file', () => {
    const rootDirectory = createRoot();
    const outbox = new SessionMessageOutbox('session-c', { rootDirectory });
    const record = outbox.enqueue('encrypted-result', 'stable-id');
    const sessionDirectory = join(
      rootDirectory,
      createHash('sha256').update('session-c').digest('hex'),
    );
    const canonicalName = readdirSync(sessionDirectory)
      .find((name) => name.endsWith('.json') && name !== 'manifest.json')!;
    const canonical = readFileSync(join(sessionDirectory, canonicalName), 'utf8');
    writeFileSync(join(sessionDirectory, `${canonicalName}.crash.pending`), canonical, { mode: 0o600 });

    const recovered = new SessionMessageOutbox('session-c', { rootDirectory });
    expect(recovered.pendingCount).toBe(1);
    expect(readdirSync(sessionDirectory).filter((name) => name.endsWith('.pending'))).toEqual([]);

    expect(recovered.acknowledge(record.localId)).toBe(true);
    expect(new SessionMessageOutbox('session-c', { rootDirectory }).pendingCount).toBe(0);
  });

  it('recovers a fully-written pre-rename record after restart', () => {
    const rootDirectory = createRoot();
    const sessionId = 'session-d';
    const sessionDirectory = join(rootDirectory, createHash('sha256').update(sessionId).digest('hex'));
    mkdirSync(sessionDirectory, { recursive: true });
    const record = {
      version: 1 as const,
      sessionId,
      localId: 'pending-id',
      message: 'encrypted-pending',
      createdAt: 100,
      orderKey: '0000000000000100-0000000001-0000000000-pending-id',
    };
    writeFileSync(join(sessionDirectory, 'crashed.pending'), JSON.stringify(record), { mode: 0o600 });

    const recovered = new SessionMessageOutbox(sessionId, { rootDirectory });
    expect(recovered.pendingRecords()).toEqual([record]);
    expect(readdirSync(sessionDirectory).some((name) => name.endsWith('.json'))).toBe(true);
  });

  it('discovers orphaned session outboxes for daemon startup replay', () => {
    const rootDirectory = createRoot();
    new SessionMessageOutbox('session-orphan-a', { rootDirectory })
      .enqueue('encrypted-a', 'id-a');
    new SessionMessageOutbox('session-orphan-b', { rootDirectory })
      .enqueue('encrypted-b', 'id-b');

    expect(discoverPendingSessionOutboxSessionIds(rootDirectory))
      .toEqual(['session-orphan-a', 'session-orphan-b']);
  });

  it('inspects prune safety without creating or repairing an outbox', () => {
    const rootDirectory = createRoot();
    const absent = inspectSessionMessageOutboxOnDisk('never-created', rootDirectory);
    expect(absent).toEqual(expect.objectContaining({
      directoryExists: false,
      safeToTerminate: true,
      managedFileCount: 0,
    }));
    expect(readdirSync(rootDirectory)).toEqual([]);

    const outbox = new SessionMessageOutbox('pending-prune', { rootDirectory });
    outbox.enqueue('encrypted-result', 'pending-id');
    expect(inspectSessionMessageOutboxOnDisk('pending-prune', rootDirectory))
      .toEqual(expect.objectContaining({
        directoryExists: true,
        safeToTerminate: false,
        managedFileCount: 1,
        reason: 'managed-records-present',
      }));
    outbox.acknowledge('pending-id');
    expect(inspectSessionMessageOutboxOnDisk('pending-prune', rootDirectory))
      .toEqual(expect.objectContaining({
        safeToTerminate: true,
        managedFileCount: 0,
      }));
  });

  it('attributes malformed-only directories and blocks later records from replay', () => {
    const rootDirectory = createRoot();
    const valid = new SessionMessageOutbox('session-valid-later', { rootDirectory });
    valid.enqueue('encrypted-valid', 'valid-id');
    const sessionDirectory = join(
      rootDirectory,
      createHash('sha256').update('session-valid-later').digest('hex'),
    );
    writeFileSync(join(sessionDirectory, '000-malformed.json'), '{not-json', { mode: 0o600 });
    expect(discoverPendingSessionOutboxSessionIds(rootDirectory))
      .toEqual(['session-valid-later']);
    const restarted = new SessionMessageOutbox('session-valid-later', { rootDirectory });
    expect(restarted.hasIntegrityBarrier).toBe(true);
    expect(restarted.pendingRecords().map((record) => record.localId)).toEqual(['valid-id']);
    expect(restarted.undeliveredCount).toBe(2);

    const malformedOnly = new SessionMessageOutbox('session-malformed-only', { rootDirectory });
    const malformedOnlyDirectory = join(
      rootDirectory,
      createHash('sha256').update('session-malformed-only').digest('hex'),
    );
    writeFileSync(join(malformedOnlyDirectory, 'broken.pending'), '{partial', { mode: 0o600 });
    expect(malformedOnly.pendingCount).toBe(0);
    expect(discoverPendingSessionOutboxSessionIds(rootDirectory))
      .toEqual(['session-malformed-only', 'session-valid-later']);
    expect(new SessionMessageOutbox('session-malformed-only', { rootDirectory }).hasIntegrityBarrier)
      .toBe(true);
  });

  it('persists session-end as an ordered, acknowledgeable outbox record', () => {
    const rootDirectory = createRoot();
    const outbox = new SessionMessageOutbox('session-end-durable', { rootDirectory });
    outbox.enqueue('encrypted-terminal', '4de09f61-dc78-4d4f-8a20-6a72c44cb3e3');
    const marker = outbox.enqueueSessionEnd(
      'c50f1408-d46b-49ac-afdc-fc66ba47d183',
      'b83e4bf5-c0fa-44b7-8111-cfbd69f70db0',
    );

    const restarted = new SessionMessageOutbox('session-end-durable', { rootDirectory });
    expect(restarted.pendingRecords()).toHaveLength(1);
    expect(restarted.pendingSessionEnd()).toEqual(marker);
    expect(restarted.pendingCount).toBe(2);

    const resumedMarker = restarted.enqueueSessionEnd(
      '511e22d7-cbea-49c2-b7ea-700a25122e18',
      '576049eb-242c-4bdf-824c-d758bb36d649',
    );
    expect(restarted.pendingCount).toBe(3);

    restarted.acknowledge('4de09f61-dc78-4d4f-8a20-6a72c44cb3e3');
    restarted.acknowledge(marker.localId);
    expect(restarted.pendingSessionEnd()).toEqual(resumedMarker);
    restarted.acknowledge(resumedMarker.localId);
    expect(new SessionMessageOutbox('session-end-durable', { rootDirectory }).pendingCount).toBe(0);
  });

  it('propagates real directory sync failures without forgetting the durable file', () => {
    const rootDirectory = createRoot();
    let syncCalls = 0;
    const outbox = new SessionMessageOutbox('session-sync-error', {
      rootDirectory,
      syncDirectory: () => {
        syncCalls += 1;
        if (syncCalls === 1) return true;
        throw new Error('simulated EIO');
      },
    });

    expect(() => outbox.enqueue('encrypted', 'd086b879-4724-4866-9251-5806c69c88d6'))
      .toThrow('simulated EIO');
    const restarted = new SessionMessageOutbox('session-sync-error', { rootDirectory });
    expect(restarted.pendingRecords().map((record) => record.localId))
      .toEqual(['d086b879-4724-4866-9251-5806c69c88d6']);
  });

  it('keeps the pending copy when quarantine directory sync is unsupported', () => {
    const rootDirectory = createRoot();
    const original = new SessionMessageOutbox('session-unsupported-sync', { rootDirectory });
    original.enqueue('encrypted', '24c63aa6-c64e-4a19-95f5-dcd533e72217');
    const outbox = new SessionMessageOutbox('session-unsupported-sync', {
      rootDirectory,
      syncDirectory: () => false,
    });
    outbox.quarantine('24c63aa6-c64e-4a19-95f5-dcd533e72217', 'rejected');

    const sessionDirectory = join(
      rootDirectory,
      createHash('sha256').update('session-unsupported-sync').digest('hex'),
    );
    expect(readdirSync(sessionDirectory).filter((name) => name !== 'manifest.json')).toHaveLength(2);
    const restarted = new SessionMessageOutbox('session-unsupported-sync', { rootDirectory });
    expect(restarted.pendingCount).toBe(0);
    expect(restarted.quarantinedCount).toBe(1);
  });

  it('durably quarantines permanent rejection without allowing later replay', () => {
    const rootDirectory = createRoot();
    const outbox = new SessionMessageOutbox('session-quarantine', { rootDirectory });
    const rejected = outbox.enqueue('encrypted-rejected', 'rejected-id');
    outbox.enqueue('encrypted-later', 'later-id');

    const quarantine = outbox.quarantine(rejected.localId, 'idempotency_conflict');
    expect(quarantine).toEqual(expect.objectContaining({
      status: 'quarantined',
      record: rejected,
      rejection: { code: 'idempotency_conflict', retryable: false },
    }));
    expect(outbox.pendingRecords().map((record) => record.localId)).toEqual(['later-id']);
    expect(outbox.undeliveredCount).toBe(2);
    expect(discoverPendingSessionOutboxSessionIds(rootDirectory)).toEqual(['session-quarantine']);

    const restarted = new SessionMessageOutbox('session-quarantine', { rootDirectory });
    expect(restarted.quarantinedRecords()[0]).toEqual(quarantine);
    expect(restarted.pendingRecords().map((record) => record.localId)).toEqual(['later-id']);
    expect(discoverPendingSessionOutboxSessionIds(rootDirectory)).toEqual(['session-quarantine']);
  });
});
