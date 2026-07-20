import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { RpcHandlerManager } from './RpcHandlerManager';
import { RpcResultLedger } from './RpcResultLedger';
import { hashObject } from '@/utils/deterministicJson';

const key = new Uint8Array(32);
const temporaryDirectories: string[] = [];

function createDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), 'boujot-rpc-ledger-test-'));
    temporaryDirectories.push(directory);
    return directory;
}

function createManager(directory: string): RpcHandlerManager {
    return new RpcHandlerManager({
        scopePrefix: 'scope',
        encryptionKey: key,
        encryptionVariant: 'legacy',
        resultLedger: new RpcResultLedger({ directory, pollIntervalMs: 5, pendingWaitMs: 100 }),
    });
}

function encryptedParams(value: unknown): string {
    return encodeBase64(encrypt(key, 'legacy', value));
}

function decryptedResponse(value: string): any {
    return decrypt(key, 'legacy', decodeBase64(value));
}

function ledgerRecords(directory: string): Array<Record<string, unknown>> {
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')) as Record<string, unknown>);
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('RpcHandlerManager durable call ledger', () => {
    it('returns the exact persisted ciphertext after process-local manager restart', async () => {
        const directory = createDirectory();
        const callId = '9cb597ef-5b66-4132-b995-bdddff1f6b35';
        const request = { callId, method: 'scope:effect', params: encryptedParams({ value: 7, nested: { b: 2, a: 1 } }) };
        const handler = vi.fn(async () => ({ accepted: true }));
        const firstManager = createManager(directory);
        firstManager.registerHandler('effect', handler);

        const first = await firstManager.handleRequest(request);
        const restartedManager = createManager(directory);
        restartedManager.registerHandler('effect', vi.fn(async () => ({ accepted: false })));
        const retriedWithFreshCiphertext = {
            ...request,
            params: encryptedParams({ nested: { a: 1, b: 2 }, value: 7 }),
        };
        expect(retriedWithFreshCiphertext.params).not.toBe(request.params);
        const replay = await restartedManager.handleRequest(retriedWithFreshCiphertext);

        expect(handler).toHaveBeenCalledTimes(1);
        expect(replay).toBe(first);
        expect(decryptedResponse(replay)).toEqual({ accepted: true });
    });

    it('joins an in-flight duplicate and invokes the side effect once', async () => {
        const directory = createDirectory();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const handler = vi.fn(async () => {
            await gate;
            return { done: true };
        });
        const manager = createManager(directory);
        manager.registerHandler('effect', handler);
        const request = {
            callId: '746b8081-fc8f-4f7d-8021-d86c30427b44',
            method: 'scope:effect',
            params: encryptedParams({ value: 1 }),
        };

        const first = manager.handleRequest(request);
        const duplicate = manager.handleRequest(request);
        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
        release();

        expect(await duplicate).toBe(await first);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('fails closed when a callId is reused with different params', async () => {
        const directory = createDirectory();
        const manager = createManager(directory);
        const handler = vi.fn(async (params) => ({ params }));
        manager.registerHandler('effect', handler);
        const callId = 'b1dfe188-3259-4ea4-b4ad-5a466bf7d307';

        await manager.handleRequest({ callId, method: 'scope:effect', params: encryptedParams({ value: 1 }) });
        const conflict = await manager.handleRequest({ callId, method: 'scope:effect', params: encryptedParams({ value: 2 }) });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(decryptedResponse(conflict)).toEqual({
            error: 'RPC callId was reused with different method or params',
        });
    });

    it('preserves legacy execution when a rolling-upgrade server omits callId', async () => {
        const directory = createDirectory();
        const manager = createManager(directory);
        const handler = vi.fn(async () => ({ ok: true }));
        manager.registerHandler('legacy', handler);
        const request = { method: 'scope:legacy', params: encryptedParams({}) };

        await manager.handleRequest(request);
        await manager.handleRequest(request);

        expect(handler).toHaveBeenCalledTimes(2);
    });

    it('bypasses durable reservations only for explicitly registered read-only handlers', async () => {
        const directory = createDirectory();
        const manager = createManager(directory);
        const readOnly = vi.fn(async () => ({ value: 1 }));
        manager.registerHandler('provider-readiness', readOnly, { execution: 'read-only' });

        await manager.handleRequest({
            callId: '935366e7-11c8-4601-9408-7ed222f46e5b',
            method: 'scope:provider-readiness',
            params: encryptedParams({ provider: 'claude' }),
        });
        await manager.handleRequest({
            callId: '201c5f60-e206-49de-85ff-a4c2c448b651',
            method: 'scope:provider-readiness',
            params: encryptedParams({ provider: 'claude' }),
        });

        expect(readOnly).toHaveBeenCalledTimes(2);
        expect(ledgerRecords(directory)).toEqual([]);

        // A name that merely resembles a probe remains durable unless its
        // trusted registration explicitly opts out.
        const durable = vi.fn(async () => ({ spawned: true }));
        manager.registerHandler('spawn-happy-session', durable);
        await manager.handleRequest({
            callId: '7f5db35e-258b-407a-8a90-a263b831fc3c',
            method: 'scope:spawn-happy-session',
            params: encryptedParams({ directory: '/tmp/work' }),
        });
        expect(durable).toHaveBeenCalledOnce();
        expect(ledgerRecords(directory)).toHaveLength(1);
    });

    it('does not reserve durable capacity for unknown methods', async () => {
        const directory = createDirectory();
        const manager = createManager(directory);

        const response = await manager.handleRequest({
            callId: '6bc5b935-f0ea-4482-bda6-1a0559169855',
            method: 'scope:removed-method',
            params: encryptedParams({}),
        });

        expect(decryptedResponse(response)).toEqual({ error: 'Method not found' });
        expect(ledgerRecords(directory)).toEqual([]);
    });

    it('acknowledges a persisted caller-committed result after its handler is removed', async () => {
        const directory = createDirectory();
        const manager = createManager(directory);
        const callId = '005614fc-14c6-49db-85f1-cb6c5469c23b';
        manager.registerHandler(
            'agent-plane-effect',
            async () => ({ committed: true }),
            { execution: 'durable-acknowledged' },
        );
        const firstResponse = await manager.handleRequest({
            callId,
            method: 'scope:agent-plane-effect',
            params: encryptedParams({}),
        });
        manager.clearHandlers();

        const replayAfterRemoval = await manager.handleRequest({
            callId,
            method: 'scope:agent-plane-effect',
            params: encryptedParams({}),
        });
        expect(replayAfterRemoval).toBe(firstResponse);

        await expect(manager.acknowledgeDurableResult({
            callId,
            method: 'agent-plane-effect',
        })).resolves.toEqual({ status: 'acknowledged' });
        expect(ledgerRecords(directory)).toEqual([
            expect.objectContaining({
                callId,
                status: 'tombstone',
                reason: 'acknowledged',
            }),
        ]);
    });

    it('rejects ACKs for compatibility time-bounded results', async () => {
        const directory = createDirectory();
        const manager = createManager(directory);
        const callId = 'd2129178-b463-4e1a-a24f-9bb023711af7';
        manager.registerHandler('legacy-effect', async () => ({ committed: true }));
        await manager.handleRequest({
            callId,
            method: 'scope:legacy-effect',
            params: encryptedParams({}),
        });

        await expect(manager.acknowledgeDurableResult({
            callId,
            method: 'legacy-effect',
        })).resolves.toEqual({
            status: 'conflict',
            reason: 'RPC result does not use caller-acknowledged retention',
        });
    });

    it('ages only compatibility time-bounded results after the retry horizon', async () => {
        const directory = createDirectory();
        let now = 1;
        const ledger = new RpcResultLedger({
            directory,
            maxEntries: 1,
            maxTotalBytes: 1024 * 1024,
            now: () => now,
        });
        expect((await ledger.execute({
            callId: 'fc54fbed-9069-4269-a271-ac9c20ec460d',
            method: 'scope:compatibility-side-effect',
            paramsHash: hashObject({ value: 1 }),
        }, async () => 'first')).status).toBe('completed');

        now += 24 * 60 * 60 * 1_000 + 1;
        expect((await ledger.execute({
            callId: '5d358453-ad1b-49fe-9860-abcb658b002a',
            method: 'scope:compatibility-side-effect',
            paramsHash: hashObject({ value: 2 }),
        }, async () => 'replacement')).status).toBe('completed');
        expect(ledgerRecords(directory)).toEqual([
            expect.objectContaining({
                callId: '5d358453-ad1b-49fe-9860-abcb658b002a',
                retention: 'time_bounded',
            }),
        ]);
    });

    it('never ages an unacknowledged result into a re-executable side effect', async () => {
        const directory = createDirectory();
        let now = 1;
        const ledger = new RpcResultLedger({
            directory,
            maxEntries: 1,
            maxTotalBytes: 1024 * 1024,
            now: () => now,
        });
        const firstCallId = '5385341a-72ab-47c0-9aa2-a3ed6567fb2c';
        const firstInput = {
            callId: firstCallId,
            method: 'scope:bounded',
            paramsHash: hashObject({ value: firstCallId }),
            retention: 'caller_acknowledged' as const,
        };
        expect((await ledger.execute(firstInput, async () => 'encrypted-result')).status)
            .toBe('completed');

        now += 365 * 24 * 60 * 60 * 1_000;
        const blockedExecutor = vi.fn(async () => 'must-not-run-before-ack');
        expect((await ledger.execute({
            callId: 'ce875e89-b3a3-4c4c-894e-977b92472854',
            method: 'scope:bounded',
            paramsHash: hashObject({ value: 2 }),
            retention: 'caller_acknowledged',
        }, blockedExecutor)).status).toBe('unavailable');
        expect(blockedExecutor).not.toHaveBeenCalled();

        expect(await ledger.acknowledge({ callId: firstCallId, method: 'scope:bounded' }))
            .toEqual({ status: 'acknowledged' });
        const delayedDuplicate = vi.fn(async () => 'must-not-reexecute-after-ack');
        expect(await ledger.execute(firstInput, delayedDuplicate)).toEqual({
            status: 'unavailable',
            reason: 'RPC outcome was already acknowledged; refusing to re-execute the side effect',
        });
        expect(delayedDuplicate).not.toHaveBeenCalled();

        expect((await ledger.execute({
            callId: 'd3aa76b2-c7f8-4d65-860e-f7fa07fc3a7f',
            method: 'scope:bounded',
            paramsHash: hashObject({ value: 3 }),
            retention: 'caller_acknowledged',
        }, async () => 'next-result')).status).toBe('completed');
        expect(ledgerRecords(directory).map((record) => record.status).sort())
            .toEqual(['completed', 'tombstone']);
    });

    it('fails closed at active capacity until the authoritative caller acknowledges a result', async () => {
        const directory = createDirectory();
        let now = 10_000;
        const ledger = new RpcResultLedger({
            directory,
            maxEntries: 1,
            maxTotalBytes: 1024 * 1024,
            now: () => now,
        });
        const firstExecutor = vi.fn(async () => 'first-result');
        const blockedExecutor = vi.fn(async () => 'must-not-run');
        expect((await ledger.execute({
            callId: '167c9274-d005-45e0-8f4d-c7cb4de9b5a2',
            method: 'scope:retained',
            paramsHash: hashObject({ value: 1 }),
            retention: 'caller_acknowledged',
        }, firstExecutor)).status).toBe('completed');

        const blocked = await ledger.execute({
            callId: 'b320c948-9040-4949-96d7-84a6c986e582',
            method: 'scope:retained',
            paramsHash: hashObject({ value: 2 }),
            retention: 'caller_acknowledged',
        }, blockedExecutor);

        expect(blocked.status).toBe('unavailable');
        expect(blockedExecutor).not.toHaveBeenCalled();
        expect(readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)))
            .toHaveLength(1);

        now += 100 * 24 * 60 * 60 * 1_000;
        expect((await ledger.execute({
            callId: 'f40440a8-735f-4a53-b0e8-d062d3a188c4',
            method: 'scope:retained',
            paramsHash: hashObject({ value: 3 }),
            retention: 'caller_acknowledged',
        }, async () => 'still-blocked')).status).toBe('unavailable');

        expect(await ledger.acknowledge({
            callId: '167c9274-d005-45e0-8f4d-c7cb4de9b5a2',
            method: 'scope:retained',
        })).toEqual({ status: 'acknowledged' });
        expect((await ledger.execute({
            callId: 'f40440a8-735f-4a53-b0e8-d062d3a188c4',
            method: 'scope:retained',
            paramsHash: hashObject({ value: 3 }),
            retention: 'caller_acknowledged',
        }, async () => 'replacement')).status).toBe('completed');
        expect(ledgerRecords(directory).map((record) => record.status).sort())
            .toEqual(['completed', 'tombstone']);
    });

    it('permanently fences a side effect when its encrypted response cannot fit', async () => {
        const directory = createDirectory();
        const ledger = new RpcResultLedger({
            directory,
            maxEntries: 1,
            maxTotalBytes: 1_024,
            maxResultBytes: 2_048,
        });
        const callId = '323574c6-958b-4682-b104-7b252bd35731';
        const input = {
            callId,
            method: 'scope:oversized-persisted-response',
            paramsHash: hashObject({ value: 1 }),
            retention: 'caller_acknowledged' as const,
        };
        const executor = vi.fn(async () => 'x'.repeat(900));

        expect(await ledger.execute(input, executor)).toEqual({
            status: 'unavailable',
            reason: 'RPC result ledger has no durable result capacity',
        });
        expect(executor).toHaveBeenCalledOnce();
        expect(ledgerRecords(directory)).toEqual([
            expect.objectContaining({
                callId,
                status: 'tombstone',
                reason: 'unknown_outcome',
            }),
        ]);

        const duplicateExecutor = vi.fn(async () => 'must-not-run');
        await expect(ledger.execute(input, duplicateExecutor)).resolves.toEqual({
            status: 'unavailable',
            reason: 'Previous RPC executor exited with an unknown outcome',
        });
        expect(duplicateExecutor).not.toHaveBeenCalled();
    });

    it('serializes concurrent capacity reservations across ledger instances', async () => {
        const directory = createDirectory();
        const options = {
            directory,
            maxEntries: 1,
            maxTotalBytes: 1024 * 1024,
            pollIntervalMs: 1,
        };
        const firstLedger = new RpcResultLedger(options);
        const secondLedger = new RpcResultLedger(options);
        const firstExecutor = vi.fn(async () => 'first');
        const secondExecutor = vi.fn(async () => 'second');

        const outcomes = await Promise.all([
            firstLedger.execute({
                callId: '3ee04d9c-8e89-4a76-ac96-c526c7c48f81',
                method: 'scope:capacity-race',
                paramsHash: hashObject({ value: 1 }),
            }, firstExecutor),
            secondLedger.execute({
                callId: '7134dc33-6a62-4475-bc6b-cd45b1a7e0d2',
                method: 'scope:capacity-race',
                paramsHash: hashObject({ value: 2 }),
            }, secondExecutor),
        ]);

        expect(outcomes.map((outcome) => outcome.status).sort())
            .toEqual(['completed', 'unavailable']);
        expect(firstExecutor.mock.calls.length + secondExecutor.mock.calls.length).toBe(1);
        expect(readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)))
            .toHaveLength(1);
    });

    it('GCs only acknowledged tombstones after the configured delivery grace', async () => {
        const directory = createDirectory();
        const day = 24 * 60 * 60 * 1_000;
        let now = 1_000;
        const ledger = new RpcResultLedger({
            directory,
            maxEntries: 1,
            maxTombstoneEntries: 1,
            maxTotalBytes: 1024 * 1024,
            acknowledgedTombstoneRetentionMs: 2 * day,
            now: () => now,
        });
        expect((await ledger.execute({
            callId: 'b07a669c-af73-4857-97f9-725c111017a1',
            method: 'scope:retained-longer',
            paramsHash: hashObject({ value: 1 }),
            retention: 'caller_acknowledged',
        }, async () => 'first')).status).toBe('completed');

        expect(await ledger.acknowledge({
            callId: 'b07a669c-af73-4857-97f9-725c111017a1',
            method: 'scope:retained-longer',
        })).toEqual({ status: 'acknowledged' });
        expect((await ledger.execute({
            callId: '86ef2e7b-7be4-4838-af0e-2c83069f8a95',
            method: 'scope:retained-longer',
            paramsHash: hashObject({ value: 2 }),
            retention: 'caller_acknowledged',
        }, async () => 'second')).status).toBe('completed');

        now += day + 1;
        expect((await ledger.acknowledge({
            callId: '86ef2e7b-7be4-4838-af0e-2c83069f8a95',
            method: 'scope:retained-longer',
        })).status).toBe('unavailable');

        now += day;
        expect(await ledger.acknowledge({
            callId: '86ef2e7b-7be4-4838-af0e-2c83069f8a95',
            method: 'scope:retained-longer',
        })).toEqual({ status: 'acknowledged' });
        expect(ledgerRecords(directory)).toEqual([
            expect.objectContaining({
                callId: '86ef2e7b-7be4-4838-af0e-2c83069f8a95',
                status: 'tombstone',
                reason: 'acknowledged',
            }),
        ]);
    });

    it('fails closed on a malformed live lock without executing the handler', async () => {
        const directory = createDirectory();
        writeFileSync(
            join(directory, '.ledger-lock-0000000000000001.json'),
            '{partial',
            { mode: 0o600 },
        );
        const ledger = new RpcResultLedger({
            directory,
            lockTimeoutMs: 100,
            pollIntervalMs: 5,
        });
        const executor = vi.fn(async () => 'unsafe');

        const outcome = await ledger.execute({
            callId: '2bed2a49-f40a-4058-8211-b6246c93c574',
            method: 'scope:locked',
            paramsHash: hashObject({ value: 1 }),
        }, executor);

        expect(outcome.status).toBe('unavailable');
        expect(executor).not.toHaveBeenCalled();
    });

    it('fences a dead lock generation without re-executing its unknown pending call', async () => {
        const directory = createDirectory();
        const callId = '96296a9c-c090-4b6b-bcb3-43f4454d4fc4';
        const method = 'scope:stale';
        const paramsHash = hashObject({ value: 1 });
        const fingerprint = createHash('sha256')
            .update(method)
            .update('\0')
            .update(paramsHash)
            .digest('hex');
        const deadPid = 999_999_999;
        writeFileSync(
            join(directory, '.ledger-lock-0000000000000001.json'),
            JSON.stringify({
                version: 1,
                generation: 1,
                status: 'locked',
                ownerPid: deadPid,
                ownerInstanceId: 'dead-process-instance',
                ownerToken: 'dead-lock',
                createdAt: 1,
            }),
        );
        writeFileSync(
            join(directory, `${createHash('sha256').update(callId).digest('hex')}.json`),
            JSON.stringify({
                version: 1,
                status: 'pending',
                callId,
                method,
                paramsHash,
                fingerprint,
                ownerPid: deadPid,
                ownerToken: 'dead-owner',
                createdAt: 1,
            }),
        );
        const ledger = new RpcResultLedger({
            directory,
            maxEntries: 1,
            lockTimeoutMs: 100,
            pollIntervalMs: 5,
            pendingWaitMs: 20,
        });
        const executor = vi.fn(async () => 'unsafe');

        const outcome = await ledger.execute({ callId, method, paramsHash }, executor);

        expect(outcome).toEqual({
            status: 'unavailable',
            reason: 'Previous RPC executor exited with an unknown outcome',
        });
        expect(executor).not.toHaveBeenCalled();

        const next = await ledger.execute({
            callId: 'd64f8a20-1ac7-40b0-8a8b-f8703409e862',
            method: 'scope:after-recovery',
            paramsHash: hashObject({ value: 2 }),
        }, async () => 'recovered-result');
        expect(next).toEqual({
            status: 'completed',
            response: 'recovered-result',
            replayed: false,
        });
        expect(ledgerRecords(directory).map((record) => record.status).sort())
            .toEqual(['completed', 'tombstone']);
        const latestLock = readdirSync(directory)
            .filter((name) => name.startsWith('.ledger-lock-') && name.endsWith('.json'))
            .sort()
            .at(-1)!;
        expect(JSON.parse(readFileSync(join(directory, latestLock), 'utf8')))
            .toEqual(expect.objectContaining({ status: 'unlocked' }));
    });

    it('recovers when the operating system reused a stale lock owner PID', async () => {
        const directory = createDirectory();
        writeFileSync(
            join(directory, '.ledger-lock-0000000000000001.json'),
            JSON.stringify({
                version: 1,
                generation: 1,
                status: 'locked',
                ownerPid: process.pid,
                ownerInstanceId: 'a-prior-process-with-the-same-pid',
                ownerToken: 'stale-reused-pid-lock',
                createdAt: 1,
            }),
        );
        const ledger = new RpcResultLedger({ directory, pollIntervalMs: 5 });
        const executor = vi.fn(async () => 'executed-after-fencing-stale-incarnation');

        const outcome = await ledger.execute({
            callId: '95d80664-cf0e-44aa-a9bb-e7bd09eae863',
            method: 'scope:pid-reuse',
            paramsHash: hashObject({ value: 1 }),
        }, executor);

        expect(outcome).toEqual({
            status: 'completed',
            response: 'executed-after-fencing-stale-incarnation',
            replayed: false,
        });
        expect(executor).toHaveBeenCalledTimes(1);
    });

    it('fences an unknown pending call when the operating system reused its owner PID', async () => {
        const directory = createDirectory();
        const callId = '055bd285-ff95-49f7-9e79-bd6335cb2096';
        const method = 'scope:pending-pid-reuse';
        const paramsHash = hashObject({ value: 1 });
        const fingerprint = createHash('sha256')
            .update(method)
            .update('\0')
            .update(paramsHash)
            .digest('hex');
        writeFileSync(
            join(directory, `${createHash('sha256').update(callId).digest('hex')}.json`),
            JSON.stringify({
                version: 1,
                status: 'pending',
                callId,
                method,
                paramsHash,
                fingerprint,
                ownerPid: process.pid,
                ownerInstanceId: 'a-prior-process-with-the-same-pid',
                ownerToken: 'stale-pending-owner',
                createdAt: 1,
                retention: 'caller_acknowledged',
            }),
        );
        const ledger = new RpcResultLedger({
            directory,
            pollIntervalMs: 5,
            pendingWaitMs: 20,
        });
        const executor = vi.fn(async () => 'unsafe');

        await expect(ledger.execute({
            callId,
            method,
            paramsHash,
            retention: 'caller_acknowledged',
        }, executor)).resolves.toEqual({
            status: 'unavailable',
            reason: 'Previous RPC executor exited with an unknown outcome',
        });
        expect(executor).not.toHaveBeenCalled();
        expect(ledgerRecords(directory)).toEqual([
            expect.objectContaining({
                callId,
                status: 'tombstone',
                reason: 'unknown_outcome',
            }),
        ]);
    });
});
