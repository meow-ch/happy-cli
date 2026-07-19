import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiSessionClient } from './apiSession';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeBase64, encrypt } from './encryption';

// Use vi.hoisted to ensure mock function is available when vi.mock factory runs
const { mockIo, mockNotifyDaemonSessionActivity } = vi.hoisted(() => ({
    mockIo: vi.fn(),
    mockNotifyDaemonSessionActivity: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

vi.mock('@/daemon/controlClient', () => ({
    notifyDaemonSessionActivity: mockNotifyDaemonSessionActivity,
}));

describe('ApiSessionClient connection handling', () => {
    let mockSocket: any;
    let consoleSpy: any;
    let mockSession: any;
    let outboxDirectory: string;
    let socketHandlers: Map<string, (...args: any[]) => any>;
    let fetchInboxPage: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockNotifyDaemonSessionActivity.mockReset();
        mockNotifyDaemonSessionActivity.mockResolvedValue({});

        // Mock socket.io client
        socketHandlers = new Map();
        mockSocket = {
            connected: false,
            connect: vi.fn(),
            on: vi.fn((event: string, handler: (...args: any[]) => any) => {
                socketHandlers.set(event, handler);
                return mockSocket;
            }),
            off: vi.fn(),
            disconnect: vi.fn()
            ,close: vi.fn(),
            emit: vi.fn(),
            emitWithAck: vi.fn(),
            timeout: vi.fn(() => mockSocket),
            volatile: { emit: vi.fn() },
        };

        mockIo.mockReturnValue(mockSocket);
        fetchInboxPage = vi.fn(async (afterSeq: number) => ({
            messages: [],
            hasMore: false,
            nextAfterSeq: afterSeq,
        }));

        // Create a proper mock session with metadata
        mockSession = {
            id: 'test-session-id',
            seq: 0,
            metadata: {
                path: '/tmp',
                host: 'localhost',
                homeDir: '/home/user',
                happyHomeDir: '/home/user/.happy',
                happyLibDir: '/home/user/.happy/lib',
                happyToolsDir: '/home/user/.happy/tools'
            },
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy' as const
        };
        outboxDirectory = mkdtempSync(join(tmpdir(), 'boujot-api-session-test-'));
    });

    const options = (inbox: Record<string, unknown> = {}) => ({
        outbox: { rootDirectory: outboxDirectory },
        messageAckTimeoutMs: 50,
        outboxRetryBaseMs: 60_000,
        outboxRetryMaxMs: 60_000,
        inbox: {
            fetchPage: fetchInboxPage,
            reconcileIntervalMs: 0,
            retryBaseMs: 10,
            retryMaxMs: 10,
            ...inbox,
        },
    });

    const storedMessage = (seq: number, body: unknown, id = `message-${seq}`) => ({
        id,
        seq,
        content: {
            t: 'encrypted' as const,
            c: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, body)),
        },
        createdAt: seq,
        updatedAt: seq,
    });

    it('should handle socket connection failure gracefully', async () => {
        // Should not throw during client creation
        // Note: socket is created with autoConnect: false, so connection happens later
        expect(() => {
            new ApiSessionClient('fake-token', mockSession, options());
        }).not.toThrow();
    });

    it('should emit correct events on socket connection', () => {
        const client = new ApiSessionClient('fake-token', mockSession, options());

        // Should have set up event listeners
        expect(mockSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('reconciles the DB cursor on reconnect after a disconnected wake-up was missed', async () => {
        mockSession.seq = 4;
        let available: any[] = [];
        fetchInboxPage.mockImplementation(async (afterSeq: number) => ({
            messages: available.filter((message) => message.seq > afterSeq),
            hasMore: false,
            nextAfterSeq: available.reduce((maximum, message) => Math.max(maximum, message.seq), afterSeq),
        }));
        const received: string[] = [];
        const client = new ApiSessionClient('fake-token', mockSession, options());
        client.onUserMessage((message) => {
            if (message.content.type === 'text') received.push(message.content.text);
        });

        mockSocket.connected = true;
        socketHandlers.get('connect')?.();
        await vi.waitFor(() => expect(fetchInboxPage).toHaveBeenCalledWith(4));

        mockSocket.connected = false;
        socketHandlers.get('disconnect')?.('transport close');
        available = [storedMessage(5, { role: 'user', content: { type: 'text', text: 'after reconnect' } })];
        await socketHandlers.get('update')?.({
            body: { t: 'new-message', sid: mockSession.id, message: available[0] },
        });
        expect(fetchInboxPage).toHaveBeenCalledTimes(1);

        mockSocket.connected = true;
        socketHandlers.get('connect')?.();
        await vi.waitFor(() => expect(received).toEqual(['after reconnect']));
        expect(client.inboundAfterSeq).toBe(5);
        await client.close();
    });

    it('delivers out-of-order duplicate DB rows once in strict sequence order', async () => {
        mockSession.seq = 20;
        const first = storedMessage(21, { role: 'user', content: { type: 'text', text: 'first' } });
        const second = storedMessage(22, { role: 'user', content: { type: 'text', text: 'second' } });
        fetchInboxPage.mockImplementation(async (afterSeq: number) => ({
            messages: afterSeq < 22 ? [second, first, first] : [],
            hasMore: false,
            nextAfterSeq: afterSeq < 22 ? 22 : afterSeq,
        }));
        const received: string[] = [];
        const client = new ApiSessionClient('fake-token', mockSession, options());
        client.onUserMessage((message) => {
            if (message.content.type === 'text') received.push(message.content.text);
        });

        mockSocket.connected = true;
        socketHandlers.get('connect')?.();
        await vi.waitFor(() => expect(received).toEqual(['first', 'second']));
        await socketHandlers.get('update')?.({ body: { t: 'new-message', sid: mockSession.id, message: second } });
        await vi.waitFor(() => expect(fetchInboxPage).toHaveBeenCalledTimes(2));

        expect(received).toEqual(['first', 'second']);
        expect(client.inboundAfterSeq).toBe(22);
        await client.close();
    });

    it('periodically heals a missed live notification while connected', async () => {
        let available = false;
        const remote = storedMessage(1, { role: 'user', content: { type: 'text', text: 'periodic recovery' } });
        fetchInboxPage.mockImplementation(async (afterSeq: number) => ({
            messages: available && afterSeq < 1 ? [remote] : [],
            hasMore: false,
            nextAfterSeq: available ? Math.max(afterSeq, 1) : afterSeq,
        }));
        const received: string[] = [];
        const client = new ApiSessionClient('fake-token', mockSession, options({ reconcileIntervalMs: 20 }));
        client.onUserMessage((message) => {
            if (message.content.type === 'text') received.push(message.content.text);
        });

        mockSocket.connected = true;
        socketHandlers.get('connect')?.();
        await vi.waitFor(() => expect(fetchInboxPage).toHaveBeenCalledTimes(1));
        available = true;

        await vi.waitFor(() => expect(received).toEqual(['periodic recovery']));
        expect(client.inboundAfterSeq).toBe(1);
        await client.close();
    });

    it('immediately invalidates safe-idle evidence when inbound work is handed off', async () => {
        mockSession.metadata.startedBy = 'daemon';
        const remote = storedMessage(1, {
            role: 'user',
            content: { type: 'text', text: 'wake the idle runtime' },
        });
        fetchInboxPage.mockImplementation(async (afterSeq: number) => ({
            messages: afterSeq < 1 ? [remote] : [],
            hasMore: false,
            nextAfterSeq: Math.max(afterSeq, 1),
        }));
        let releaseInboundReport!: (value: object) => void;
        const inboundReport = new Promise<object>((resolve) => { releaseInboundReport = resolve; });
        mockNotifyDaemonSessionActivity
            .mockResolvedValueOnce({})
            .mockImplementationOnce(() => inboundReport);
        const callback = vi.fn();
        const client = new ApiSessionClient('fake-token', mockSession, options());
        client.onUserMessage(callback);

        // Establish a recent safe-idle report which would normally activate
        // the 30-second unchanged-state throttle.
        client.keepAlive(false, 'remote');
        await vi.waitFor(() => expect(mockNotifyDaemonSessionActivity).toHaveBeenCalledTimes(1));

        mockSocket.connected = true;
        socketHandlers.get('connect')?.();
        await vi.waitFor(() => expect(mockNotifyDaemonSessionActivity).toHaveBeenCalledTimes(2));
        expect(callback).not.toHaveBeenCalled();
        expect(client.inboundAfterSeq).toBe(0);

        releaseInboundReport({});
        await vi.waitFor(() => expect(client.inboundAfterSeq).toBe(1));

        expect(mockNotifyDaemonSessionActivity).toHaveBeenCalledTimes(2);
        expect(callback).toHaveBeenCalledTimes(1);
        expect(mockNotifyDaemonSessionActivity).toHaveBeenLastCalledWith(
            mockSession.id,
            expect.objectContaining({
                thinking: false,
                pendingOutbox: 0,
                lastActivityAt: expect.any(Number),
            }),
        );
        await client.close();
    });

    it('retries a failed canonical fetch from the unchanged cursor', async () => {
        const remote = storedMessage(1, { role: 'user', content: { type: 'text', text: 'retried fetch' } });
        fetchInboxPage
            .mockRejectedValueOnce(new Error('temporary database gateway failure'))
            .mockImplementation(async (afterSeq: number) => ({
                messages: afterSeq < 1 ? [remote] : [],
                hasMore: false,
                nextAfterSeq: Math.max(afterSeq, 1),
            }));
        const received: string[] = [];
        const client = new ApiSessionClient('fake-token', mockSession, options({
            retryBaseMs: 1,
            retryMaxMs: 1,
        }));
        client.onUserMessage((message) => {
            if (message.content.type === 'text') received.push(message.content.text);
        });

        mockSocket.connected = true;
        socketHandlers.get('connect')?.();

        await vi.waitFor(() => expect(received).toEqual(['retried fetch']));
        expect(fetchInboxPage.mock.calls.slice(0, 2).map((call) => call[0])).toEqual([0, 0]);
        expect(client.inboundAfterSeq).toBe(1);
        await client.close();
    });

    it('ignores agent history while preserving control and user records', async () => {
        const records = [
            storedMessage(1, { role: 'agent', content: { type: 'output', data: { text: 'history' } } }),
            storedMessage(2, { type: 'permission-response', approved: true }),
            storedMessage(3, { role: 'user', content: { type: 'text', text: 'execute this' } }),
        ];
        fetchInboxPage.mockImplementation(async (afterSeq: number) => ({
            messages: records.filter((message) => message.seq > afterSeq),
            hasMore: false,
            nextAfterSeq: records.at(-1)!.seq,
        }));
        const users: string[] = [];
        const controls: any[] = [];
        const client = new ApiSessionClient('fake-token', mockSession, options());
        client.onUserMessage((message) => {
            if (message.content.type === 'text') users.push(message.content.text);
        });
        client.on('message', (message) => controls.push(message));

        mockSocket.connected = true;
        socketHandlers.get('connect')?.();
        await vi.waitFor(() => expect(client.inboundAfterSeq).toBe(3));

        expect(users).toEqual(['execute this']);
        expect(controls).toEqual([{ type: 'permission-response', approved: true }]);
        await client.close();
    });

    it('queues a control record until a listener is attached', async () => {
        const control = storedMessage(1, { type: 'permission-response', approved: false });
        fetchInboxPage.mockImplementation(async (afterSeq: number) => ({
            messages: afterSeq < 1 ? [control] : [],
            hasMore: false,
            nextAfterSeq: Math.max(afterSeq, 1),
        }));
        const client = new ApiSessionClient('fake-token', mockSession, options());

        mockSocket.connected = true;
        socketHandlers.get('connect')?.();
        await vi.waitFor(() => expect(client.inboundAfterSeq).toBe(1));

        const received: unknown[] = [];
        client.on('message', (message) => received.push(message));
        expect(received).toEqual([{ type: 'permission-response', approved: false }]);
        await client.close();
    });

    it('replays the same localId after a lost ACK and restart', async () => {
        mockSocket.connected = true;
        mockSocket.emitWithAck.mockRejectedValue(new Error('ACK lost after commit'));
        const firstClient = new ApiSessionClient('fake-token', mockSession, options());

        firstClient.sendAgentMessage('claude', {
            type: 'task_failed',
            id: 'turn-1',
            message: 'API Error: ENOTFOUND',
        });
        await vi.waitFor(() => expect(mockSocket.emitWithAck).toHaveBeenCalledTimes(1));
        const firstDelivery = mockSocket.emitWithAck.mock.calls[0][1];
        expect(firstDelivery.localId).toBeTruthy();
        expect(firstClient.pendingOutboxCount).toBe(1);
        await firstClient.close();

        socketHandlers = new Map();
        const replaySocket: any = {
            ...mockSocket,
            connected: true,
            connect: vi.fn(),
            close: vi.fn(),
            emit: vi.fn(),
            emitWithAck: vi.fn(async (_event: string, data: any) => ({
                result: 'success',
                duplicate: true,
                message: {
                    id: 'server-message-id',
                    seq: 42,
                    localId: data.localId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            })),
            timeout: vi.fn(function (this: any) { return this; }),
            on: vi.fn((event: string, handler: (...args: any[]) => any) => {
                socketHandlers.set(event, handler);
                return replaySocket;
            }),
            volatile: { emit: vi.fn() },
        };
        mockIo.mockReturnValue(replaySocket);

        const restartedClient = new ApiSessionClient('fake-token', mockSession, options());
        socketHandlers.get('connect')?.();
        await vi.waitFor(() => expect(restartedClient.pendingOutboxCount).toBe(0));

        const replayDelivery = replaySocket.emitWithAck.mock.calls[0][1];
        expect(replayDelivery.localId).toBe(firstDelivery.localId);
        expect(replayDelivery.message).toBe(firstDelivery.message);
        await restartedClient.close();
    });

    it('delivers queued messages sequentially in durable order', async () => {
        const deferred: Array<() => void> = [];
        mockSocket.connected = true;
        mockSocket.emitWithAck.mockImplementation((_event: string, data: any) => new Promise((resolve) => {
            deferred.push(() => resolve({
                result: 'success',
                duplicate: false,
                message: {
                    id: `server-${data.localId}`,
                    seq: deferred.length,
                    localId: data.localId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            }));
        }));
        const client = new ApiSessionClient('fake-token', mockSession, options());
        client.sendSessionEvent({ type: 'message', message: 'first' });
        client.sendSessionEvent({ type: 'message', message: 'second' });

        await vi.waitFor(() => expect(mockSocket.emitWithAck).toHaveBeenCalledTimes(1));
        deferred.shift()!();
        await vi.waitFor(() => expect(mockSocket.emitWithAck).toHaveBeenCalledTimes(2));
        deferred.shift()!();
        await vi.waitFor(() => expect(client.pendingOutboxCount).toBe(0));
        await client.close();
    });

    it('replays and acknowledges session-end after an offline process close', async () => {
        const firstClient = new ApiSessionClient('fake-token', mockSession, options());
        firstClient.sendSessionDeath();
        expect(firstClient.pendingOutboxCount).toBe(1);
        await firstClient.flush();
        await firstClient.close();

        socketHandlers = new Map();
        const replaySocket: any = {
            ...mockSocket,
            connected: true,
            connect: vi.fn(),
            close: vi.fn(),
            emit: vi.fn(),
            emitWithAck: vi.fn(async (event: string, data: any) => {
                if (event !== 'session-end') throw new Error(`Unexpected event ${event}`);
                return { result: 'success', localId: data.localId };
            }),
            timeout: vi.fn(function (this: any) { return this; }),
            on: vi.fn((event: string, handler: (...args: any[]) => any) => {
                socketHandlers.set(event, handler);
                return replaySocket;
            }),
            volatile: { emit: vi.fn() },
        };
        mockIo.mockReturnValue(replaySocket);

        const restartedClient = new ApiSessionClient('fake-token', mockSession, options());
        socketHandlers.get('connect')?.();
        await vi.waitFor(() => expect(restartedClient.pendingOutboxCount).toBe(0));
        expect(replaySocket.emitWithAck).toHaveBeenCalledWith('session-end', {
            sid: mockSession.id,
            time: expect.any(Number),
            localId: expect.any(String),
            sessionInstanceId: expect.any(String),
        });
        await restartedClient.close();
    });

    it('quarantines a permanent rejection and never leapfrogs or retries it', async () => {
        mockSocket.connected = true;
        mockSocket.emitWithAck.mockResolvedValue({
            result: 'error',
            code: 'idempotency_conflict',
            retryable: false,
        });
        const client = new ApiSessionClient('fake-token', mockSession, options());
        client.sendSessionEvent({ type: 'message', message: 'conflicted-first' });
        client.sendSessionEvent({ type: 'message', message: 'must-not-leapfrog' });

        await vi.waitFor(() => expect(client.quarantinedOutboxCount).toBe(1));
        expect(client.pendingOutboxCount).toBe(1);
        expect(mockSocket.emitWithAck).toHaveBeenCalledTimes(1);
        socketHandlers.get('connect')?.();
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(mockSocket.emitWithAck).toHaveBeenCalledTimes(1);
        await client.close();
    });

    afterEach(() => {
        consoleSpy.mockRestore();
        rmSync(outboxDirectory, { recursive: true, force: true });
        vi.restoreAllMocks();
    });
});
