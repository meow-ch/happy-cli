import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SessionMessageOutbox } from './sessionMessageOutbox';
import { replayPendingSessionOutboxes } from './sessionMessageOutboxReplay';

const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));

vi.mock('socket.io-client', () => ({ io: mockIo }));

describe('daemon orphaned session outbox replay', () => {
  let rootDirectory: string;
  let socket: any;

  beforeEach(() => {
    rootDirectory = mkdtempSync(join(tmpdir(), 'boujot-outbox-replay-test-'));
    const handlers = new Map<string, (...args: any[]) => void>();
    socket = {
      once: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler);
        return socket;
      }),
      connect: vi.fn(() => queueMicrotask(() => handlers.get('connect')?.())),
      timeout: vi.fn(() => socket),
      emitWithAck: vi.fn(async (_event: string, data: any) => ({
        result: 'success',
        duplicate: true,
        message: {
          id: 'server-id',
          seq: 7,
          localId: data.localId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      })),
      close: vi.fn(),
    };
    mockIo.mockReturnValue(socket);
  });

  afterEach(() => {
    rmSync(rootDirectory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('replays ciphertext with the original localId after process restart', async () => {
    const outbox = new SessionMessageOutbox('orphan-session', { rootDirectory });
    const record = outbox.enqueue('encrypted-terminal-result', 'stable-terminal-local-id');

    const result = await replayPendingSessionOutboxes('account-token', {
      rootDirectory,
      connectTimeoutMs: 100,
      ackTimeoutMs: 100,
    });

    expect(result).toEqual({ attemptedSessions: 1, drainedSessions: 1, remainingMessages: 0 });
    expect(socket.emitWithAck).toHaveBeenCalledWith('message', {
      sid: 'orphan-session',
      message: record.message,
      localId: record.localId,
    });
    expect(new SessionMessageOutbox('orphan-session', { rootDirectory }).pendingCount).toBe(0);
  });

  it('does not open a replay socket for an active session', async () => {
    new SessionMessageOutbox('active-session', { rootDirectory })
      .enqueue('encrypted-active', 'active-id');

    const result = await replayPendingSessionOutboxes('account-token', {
      rootDirectory,
      excludeSessionIds: new Set(['active-session']),
    });

    expect(result).toEqual({ attemptedSessions: 0, drainedSessions: 0, remainingMessages: 0 });
    expect(mockIo).not.toHaveBeenCalled();
  });

  it('delivers durable session-end only after every message is acknowledged', async () => {
    const outbox = new SessionMessageOutbox('ended-session', { rootDirectory });
    outbox.enqueue('encrypted-terminal', 'db758634-ff2d-4240-ac7a-233ab1522a19');
    const marker = outbox.enqueueSessionEnd(
      '8ab6927f-632c-432a-82df-26fdac0001c8',
      '6a874404-e2f8-44f2-b88c-73a590db836f',
    );
    socket.emitWithAck.mockImplementation(async (event: string, data: any) => {
      if (event === 'session-end') return { result: 'success', localId: data.localId };
      return {
        result: 'success',
        duplicate: false,
        message: {
          id: 'server-id',
          seq: 7,
          localId: data.localId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
    });

    const result = await replayPendingSessionOutboxes('account-token', { rootDirectory });

    expect(socket.emitWithAck.mock.calls.map((call: any[]) => call[0]))
      .toEqual(['message', 'session-end']);
    expect(mockIo.mock.calls[0][1].auth).toEqual(expect.objectContaining({
      sessionInstanceId: marker.sessionInstanceId,
      replayOnly: true,
    }));
    expect(socket.emitWithAck).toHaveBeenLastCalledWith('session-end', {
      sid: 'ended-session',
      time: expect.any(Number),
      localId: marker.localId,
      sessionInstanceId: marker.sessionInstanceId,
    });
    expect(result).toEqual({ attemptedSessions: 1, drainedSessions: 1, remainingMessages: 0 });
  });

  it('drains every ordered runtime end marker in one replay pass', async () => {
    const outbox = new SessionMessageOutbox('resumed-ended-session', { rootDirectory });
    const first = outbox.enqueueSessionEnd(
      'e9499552-248e-4b7a-987e-d0bd1e8525bd',
      '76233d47-877c-4ec6-894e-f2a8f1842286',
    );
    const second = outbox.enqueueSessionEnd(
      '77d18584-fb02-4200-803f-18d2769ee610',
      '2e804f15-8793-4f5f-8ed6-ca89262f2228',
    );
    socket.emitWithAck.mockImplementation(async (_event: string, data: any) => ({
      result: 'success',
      localId: data.localId,
    }));

    const result = await replayPendingSessionOutboxes('account-token', { rootDirectory });

    expect(socket.emitWithAck.mock.calls.map((call: any[]) => call[1].localId))
      .toEqual([first.localId, second.localId]);
    expect(result).toEqual({ attemptedSessions: 1, drainedSessions: 1, remainingMessages: 0 });
  });

  it('does not leapfrog a malformed outbox record', async () => {
    const sessionId = 'barrier-session';
    const outbox = new SessionMessageOutbox(sessionId, { rootDirectory });
    outbox.enqueue('encrypted-later', 'c933fa42-6e83-4f3d-a4c1-c16d8896ba37');
    const sessionDirectory = join(rootDirectory, createHash('sha256').update(sessionId).digest('hex'));
    writeFileSync(join(sessionDirectory, 'broken.pending'), '{partial', { mode: 0o600 });

    const result = await replayPendingSessionOutboxes('account-token', { rootDirectory });

    expect(result).toEqual({ attemptedSessions: 1, drainedSessions: 0, remainingMessages: 2 });
    expect(mockIo).not.toHaveBeenCalled();
  });

  it('rotates the bounded replay batch so blocked outboxes cannot starve later sessions', async () => {
    for (const sessionId of ['a-blocked', 'b-blocked', 'c-ready', 'd-ready']) {
      const outbox = new SessionMessageOutbox(sessionId, { rootDirectory });
      outbox.enqueue(`encrypted-${sessionId}`, `local-${sessionId}`);
      if (sessionId.endsWith('blocked')) {
        const sessionDirectory = join(
          rootDirectory,
          createHash('sha256').update(sessionId).digest('hex'),
        );
        writeFileSync(join(sessionDirectory, 'broken.pending'), '{partial', { mode: 0o600 });
      }
    }

    const first = await replayPendingSessionOutboxes('account-token', {
      rootDirectory,
      limit: 2,
    });
    expect(first.attemptedSessions).toBe(2);
    expect(mockIo).not.toHaveBeenCalled();

    const second = await replayPendingSessionOutboxes('account-token', {
      rootDirectory,
      limit: 2,
    });
    expect(second).toEqual({ attemptedSessions: 2, drainedSessions: 2, remainingMessages: 0 });
    expect(mockIo).toHaveBeenCalledTimes(2);
    expect(new SessionMessageOutbox('c-ready', { rootDirectory }).pendingCount).toBe(0);
    expect(new SessionMessageOutbox('d-ready', { rootDirectory }).pendingCount).toBe(0);
  });

  it('caps records per orphan replay pass without discarding durable work', async () => {
    const outbox = new SessionMessageOutbox('large-orphan', { rootDirectory });
    outbox.enqueue('encrypted-1', 'local-1');
    outbox.enqueue('encrypted-2', 'local-2');
    outbox.enqueue('encrypted-3', 'local-3');

    const first = await replayPendingSessionOutboxes('account-token', {
      rootDirectory,
      maxRecordsPerSession: 2,
    });
    expect(first).toEqual({ attemptedSessions: 1, drainedSessions: 0, remainingMessages: 1 });
    expect(socket.emitWithAck).toHaveBeenCalledTimes(2);
    expect(new SessionMessageOutbox('large-orphan', { rootDirectory }).pendingCount).toBe(1);

    socket.emitWithAck.mockClear();
    const second = await replayPendingSessionOutboxes('account-token', {
      rootDirectory,
      maxRecordsPerSession: 2,
    });
    expect(second).toEqual({ attemptedSessions: 1, drainedSessions: 1, remainingMessages: 0 });
    expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
  });
});
