import { createHash, randomUUID } from 'node:crypto';
import { link, open, mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { configuration } from '@/configuration';

interface PendingLedgerRecord {
    version: 1;
    status: 'pending';
    callId: string;
    method: string;
    paramsHash: string;
    fingerprint: string;
    ownerPid: number;
    /** Distinguishes a restarted daemon if the OS later reuses its PID. */
    ownerInstanceId?: string;
    ownerToken: string;
    createdAt: number;
    /** Missing on records written before method-aware retention shipped. */
    retention?: RpcResultRetention;
}

interface CompletedLedgerRecord extends Omit<PendingLedgerRecord, 'status'> {
    status: 'completed';
    response: string;
    completedAt: number;
}

interface TombstoneLedgerRecord {
    version: 1;
    status: 'tombstone';
    callId: string;
    method: string;
    paramsHash: string;
    fingerprint: string;
    retiredAt: number;
    reason: 'acknowledged' | 'unknown_outcome';
}

type LedgerRecord = PendingLedgerRecord | CompletedLedgerRecord | TombstoneLedgerRecord;

export type RpcResultRetention = 'time_bounded' | 'caller_acknowledged';

export type RpcResultLedgerOutcome =
    | { status: 'completed'; response: string; replayed: boolean }
    | { status: 'conflict'; reason: string }
    | { status: 'unavailable'; reason: string };

export type RpcResultLedgerReplayOutcome = RpcResultLedgerOutcome
    | { status: 'not_found' };

export type RpcResultLedgerAcknowledgeOutcome =
    | { status: 'acknowledged' | 'already_acknowledged' }
    | { status: 'not_found' | 'conflict' | 'unavailable'; reason: string };

export interface RpcResultLedgerOptions {
    directory?: string;
    maxEntries?: number;
    maxTombstoneEntries?: number;
    maxTotalBytes?: number;
    maxResultBytes?: number;
    /** Grace before an authoritative caller-acknowledged tombstone is GC'd. */
    acknowledgedTombstoneRetentionMs?: number;
    /** Retry horizon for callers that have not implemented result ACKs. */
    minCompletedRetentionMs?: number;
    lockTimeoutMs?: number;
    pendingWaitMs?: number;
    pollIntervalMs?: number;
    now?: () => number;
}

interface LoadedLedgerRecord {
    path: string;
    size: number;
    record: LedgerRecord;
}

interface ProcessLedgerIndex {
    /** Latest immutable lock-journal generation represented by this index. */
    generation: number;
    records: Map<string, LoadedLedgerRecord>;
}

interface InFlightExecution {
    fingerprint: string;
    retention: RpcResultRetention;
    promise: Promise<RpcResultLedgerOutcome>;
}

interface LedgerLockState {
    version: 1;
    generation: number;
    status: 'locked' | 'unlocked';
    ownerPid: number;
    ownerInstanceId: string;
    ownerToken: string;
    createdAt: number;
}

const processInFlight = new Map<string, InFlightExecution>();
const processLedgerIndexes = new Map<string, ProcessLedgerIndex>();
const PROCESS_INSTANCE_ID = randomUUID();
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);
const LOCK_STATE_FILENAME = /^\.ledger-lock-(\d{16})\.json$/;
export const MIN_RPC_RESULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_RPC_RESULT_ACTIVE_ENTRIES = 8_192;
export const DEFAULT_RPC_RESULT_TOMBSTONE_ENTRIES = 65_536;
export const DEFAULT_RPC_RESULT_TOTAL_BYTES = 256 * 1024 * 1024;

export function defaultRpcResultLedgerDirectory(): string {
    return join(configuration.happyHomeDir, 'rpc-result-ledger');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLedgerRecord(value: unknown): LedgerRecord | null {
    if (!isRecord(value)
        || value.version !== 1
        || (value.status !== 'pending' && value.status !== 'completed' && value.status !== 'tombstone')
        || typeof value.callId !== 'string'
        || value.callId.length === 0
        || typeof value.method !== 'string'
        || value.method.length === 0
        || typeof value.paramsHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.paramsHash)
        || typeof value.fingerprint !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.fingerprint)
        || (value.retention !== undefined
            && value.retention !== 'time_bounded'
            && value.retention !== 'caller_acknowledged')
    ) return null;
    if (value.status === 'tombstone') {
        if (typeof value.retiredAt !== 'number'
            || !Number.isFinite(value.retiredAt)
            || value.retiredAt < 0
            || (value.reason !== 'acknowledged' && value.reason !== 'unknown_outcome')) {
            return null;
        }
        return value as unknown as TombstoneLedgerRecord;
    }
    if (typeof value.ownerPid !== 'number'
        || !Number.isInteger(value.ownerPid)
        || value.ownerPid <= 0
        || (value.ownerInstanceId !== undefined
            && (typeof value.ownerInstanceId !== 'string' || value.ownerInstanceId.length === 0))
        || typeof value.ownerToken !== 'string'
        || value.ownerToken.length === 0
        || typeof value.createdAt !== 'number'
        || !Number.isFinite(value.createdAt)
        || value.createdAt < 0) return null;
    if (value.status === 'completed'
        && (typeof value.response !== 'string'
            || typeof value.completedAt !== 'number'
            || !Number.isFinite(value.completedAt)
            || value.completedAt < 0)) return null;
    return value as unknown as LedgerRecord;
}

function parseLockState(value: unknown): LedgerLockState | null {
    if (!isRecord(value)
        || value.version !== 1
        || typeof value.generation !== 'number'
        || !Number.isSafeInteger(value.generation)
        || value.generation <= 0
        || (value.status !== 'locked' && value.status !== 'unlocked')
        || typeof value.ownerPid !== 'number'
        || !Number.isInteger(value.ownerPid)
        || value.ownerPid <= 0
        || typeof value.ownerInstanceId !== 'string'
        || value.ownerInstanceId.length === 0
        || typeof value.ownerToken !== 'string'
        || value.ownerToken.length === 0
        || typeof value.createdAt !== 'number'
        || !Number.isFinite(value.createdAt)
        || value.createdAt < 0) return null;
    return value as unknown as LedgerLockState;
}

function serializedBytes(value: unknown): { text: string; bytes: number } {
    const text = JSON.stringify(value);
    return { text, bytes: Buffer.byteLength(text) };
}

function errorCode(error: unknown): string | undefined {
    return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

async function syncDirectory(directory: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
        handle = await open(directory, 'r');
        await handle.sync();
    } catch (error) {
        if (!UNSUPPORTED_DIRECTORY_SYNC_CODES.has(errorCode(error) ?? '')) throw error;
    } finally {
        await handle?.close();
    }
}

async function writeExclusive(path: string, contents: string): Promise<void> {
    const handle = await open(path, 'wx', 0o600);
    try {
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
    await syncDirectory(dirname(path));
}

async function replaceAtomically(path: string, contents: string): Promise<void> {
    const directory = dirname(path);
    const temporaryPath = join(
        directory,
        `.${basename(path)}.${process.pid}.${randomUUID()}.pending`,
    );
    try {
        await writeExclusive(temporaryPath, contents);
        await rename(temporaryPath, path);
        await syncDirectory(directory);
    } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}

function pidIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return errorCode(error) === 'EPERM';
    }
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class RpcResultLedger {
    private readonly directory: string;
    private readonly maxEntries: number;
    private readonly maxTombstoneEntries: number;
    private readonly maxTotalBytes: number;
    private readonly maxResultBytes: number;
    private readonly minCompletedRetentionMs: number;
    private readonly acknowledgedTombstoneRetentionMs: number;
    private readonly lockTimeoutMs: number;
    private readonly pendingWaitMs: number;
    private readonly pollIntervalMs: number;
    private readonly now: () => number;
    private activeIndex: ProcessLedgerIndex | null = null;

    constructor(options: RpcResultLedgerOptions = {}) {
        this.directory = options.directory ?? defaultRpcResultLedgerDirectory();
        this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_RPC_RESULT_ACTIVE_ENTRIES);
        this.maxTombstoneEntries = Math.max(
            1,
            options.maxTombstoneEntries ?? DEFAULT_RPC_RESULT_TOMBSTONE_ENTRIES,
        );
        this.maxTotalBytes = Math.max(1_024, options.maxTotalBytes ?? DEFAULT_RPC_RESULT_TOTAL_BYTES);
        this.maxResultBytes = Math.max(1_024, options.maxResultBytes ?? 8 * 1024 * 1024);
        this.minCompletedRetentionMs = Math.max(
            MIN_RPC_RESULT_RETENTION_MS,
            options.minCompletedRetentionMs ?? MIN_RPC_RESULT_RETENTION_MS,
        );
        this.acknowledgedTombstoneRetentionMs = Math.max(
            MIN_RPC_RESULT_RETENTION_MS,
            options.acknowledgedTombstoneRetentionMs ?? MIN_RPC_RESULT_RETENTION_MS,
        );
        this.lockTimeoutMs = Math.max(100, options.lockTimeoutMs ?? 5_000);
        this.pendingWaitMs = Math.max(0, options.pendingWaitMs ?? 60_000);
        this.pollIntervalMs = Math.max(5, options.pollIntervalMs ?? 50);
        this.now = options.now ?? Date.now;
    }

    async execute(
        input: {
            callId: string;
            method: string;
            paramsHash: string;
            retention?: RpcResultRetention;
        },
        executor: () => Promise<string>,
    ): Promise<RpcResultLedgerOutcome> {
        const retention = input.retention ?? 'time_bounded';
        const fingerprint = createHash('sha256')
            .update(input.method)
            .update('\0')
            .update(input.paramsHash)
            .digest('hex');
        const processKey = `${this.directory}\0${input.callId}`;
        const current = processInFlight.get(processKey);
        if (current) {
            if (current.fingerprint !== fingerprint) {
                return { status: 'conflict', reason: 'RPC callId was reused with different method or params' };
            }
            if (current.retention !== retention) {
                return { status: 'conflict', reason: 'RPC callId retention policy changed' };
            }
            return current.promise;
        }

        const promise = this.executeInternal({ ...input, retention, fingerprint }, executor);
        processInFlight.set(processKey, { fingerprint, retention, promise });
        try {
            return await promise;
        } catch (error) {
            return {
                status: 'unavailable',
                reason: error instanceof Error ? error.message : String(error),
            };
        } finally {
            if (processInFlight.get(processKey)?.promise === promise) processInFlight.delete(processKey);
        }
    }

    /**
     * Replay/fence an already-known call without reserving a new slot. This is
     * used when a rolling upgrade removed the handler after its result was
     * persisted; arbitrary unknown methods must remain non-mutating.
     */
    async replayExisting(input: {
        callId: string;
        method: string;
        paramsHash: string;
    }): Promise<RpcResultLedgerReplayOutcome> {
        const fingerprint = createHash('sha256')
            .update(input.method)
            .update('\0')
            .update(input.paramsHash)
            .digest('hex');
        const processKey = `${this.directory}\0${input.callId}`;
        const inFlight = processInFlight.get(processKey);
        if (inFlight) {
            if (inFlight.fingerprint !== fingerprint) {
                return { status: 'conflict', reason: 'RPC callId was reused with different method or params' };
            }
            return inFlight.promise;
        }

        const recordPath = this.recordPath(input.callId);
        let record: LedgerRecord | null;
        try {
            record = await this.readRecordIfPresent(recordPath);
        } catch (error) {
            return {
                status: 'unavailable',
                reason: error instanceof Error ? error.message : String(error),
            };
        }
        if (!record) return { status: 'not_found' };
        if (record.callId !== input.callId || record.fingerprint !== fingerprint) {
            return { status: 'conflict', reason: 'RPC callId was reused with different method or params' };
        }
        if (record.status === 'completed') {
            return { status: 'completed', response: record.response, replayed: true };
        }
        if (record.status === 'tombstone') return this.tombstoneOutcome(record);
        return this.waitForCompletion(recordPath, input.callId, fingerprint);
    }

    /**
     * Release a replayable result only after the authoritative caller has
     * durably committed it. The short-lived tombstone fences delayed network
     * duplicates; unacknowledged results and unknown outcomes are never aged
     * into re-executable calls.
     */
    async acknowledge(input: {
        callId: string;
        method: string;
    }): Promise<RpcResultLedgerAcknowledgeOutcome> {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const recordPath = this.recordPath(input.callId);
        try {
            return await this.withLock(async () => {
                const current = await this.readRecordIfPresent(recordPath);
                if (!current) {
                    return { status: 'not_found', reason: 'RPC result ledger record was not found' } as const;
                }
                if (current.callId !== input.callId || current.method !== input.method) {
                    return { status: 'conflict', reason: 'RPC acknowledgement does not match the recorded call' } as const;
                }
                if (current.status === 'tombstone') {
                    return current.reason === 'acknowledged'
                        ? { status: 'already_acknowledged' } as const
                        : {
                            status: 'unavailable',
                            reason: 'Cannot acknowledge an RPC with an unknown execution outcome',
                        } as const;
                }
                if (current.status === 'pending') {
                    return {
                        status: 'unavailable',
                        reason: 'Cannot acknowledge an RPC that has no durable completed result',
                    } as const;
                }
                if (this.recordRetention(current) !== 'caller_acknowledged') {
                    return {
                        status: 'conflict',
                        reason: 'RPC result does not use caller-acknowledged retention',
                    } as const;
                }

                // GC older acknowledged fences before reserving another. This
                // method already owns the ledger lock.
                const records = await this.gcAcknowledgedTombstones(
                    await this.loadRecords(),
                    new Set([recordPath]),
                );
                const tombstoneCount = records.filter((entry) => entry.record.status === 'tombstone').length;
                if (tombstoneCount >= this.maxTombstoneEntries) {
                    return {
                        status: 'unavailable',
                        reason: 'RPC result ledger acknowledgement tombstone capacity is exhausted',
                    } as const;
                }
                const tombstone = this.tombstoneFor(current, 'acknowledged');
                const serialized = serializedBytes(tombstone);
                const currentSize = (await stat(recordPath)).size;
                const totalBytes = records.reduce((total, entry) => total + entry.size, 0)
                    - currentSize
                    + serialized.bytes;
                if (totalBytes > this.maxTotalBytes) {
                    return {
                        status: 'unavailable',
                        reason: 'RPC result ledger has no acknowledgement tombstone byte capacity',
                    } as const;
                }
                await this.replaceIndexedRecord(recordPath, tombstone, serialized);
                return { status: 'acknowledged' } as const;
            });
        } catch (error) {
            return {
                status: 'unavailable',
                reason: error instanceof Error ? error.message : String(error),
            };
        }
    }

    private async executeInternal(
        input: {
            callId: string;
            method: string;
            paramsHash: string;
            retention: RpcResultRetention;
            fingerprint: string;
        },
        executor: () => Promise<string>,
    ): Promise<RpcResultLedgerOutcome> {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const recordPath = this.recordPath(input.callId);
        const ownerToken = randomUUID();

        let reservation: { kind: 'new'; record: PendingLedgerRecord }
            | { kind: 'existing'; record: LedgerRecord };
        try {
            reservation = await this.withLock(async () => {
                const existing = await this.readRecordIfPresent(recordPath);
                if (existing) return { kind: 'existing' as const, record: existing };
                const pending: PendingLedgerRecord = {
                    version: 1,
                    status: 'pending',
                    callId: input.callId,
                    method: input.method,
                    paramsHash: input.paramsHash,
                    fingerprint: input.fingerprint,
                    ownerPid: process.pid,
                    ownerInstanceId: PROCESS_INSTANCE_ID,
                    ownerToken,
                    createdAt: this.now(),
                    retention: input.retention,
                };
                const serialized = serializedBytes(pending);
                if (!await this.pruneToFit(1, serialized.bytes, new Set())) {
                    throw new Error('RPC durable side-effect ledger capacity is exhausted');
                }
                await this.writeIndexedRecordExclusive(recordPath, pending, serialized);
                return { kind: 'new' as const, record: pending };
            });
        } catch (error) {
            return {
                status: 'unavailable',
                reason: error instanceof Error ? error.message : String(error),
            };
        }

        if (reservation.record.fingerprint !== input.fingerprint
            || reservation.record.callId !== input.callId) {
            return { status: 'conflict', reason: 'RPC callId was reused with different method or params' };
        }
        if (reservation.record.status !== 'tombstone'
            && reservation.record.retention !== undefined
            && reservation.record.retention !== input.retention) {
            return { status: 'conflict', reason: 'RPC callId retention policy changed' };
        }
        if (reservation.record.status === 'tombstone') {
            return this.tombstoneOutcome(reservation.record);
        }
        if (reservation.record.status === 'completed') {
            return { status: 'completed', response: reservation.record.response, replayed: true };
        }
        if (reservation.kind === 'existing') {
            return this.waitForCompletion(recordPath, input.callId, input.fingerprint);
        }

        let response: string;
        try {
            response = await executor();
        } catch (error) {
            // The handler may have completed a side effect before throwing.
            // Collapse the reservation to a permanent no-reexecution marker.
            await this.retirePending(recordPath, input, ownerToken).catch(() => undefined);
            return {
                status: 'unavailable',
                reason: error instanceof Error ? error.message : String(error),
            };
        }
        if (typeof response !== 'string') {
            await this.retirePending(recordPath, input, ownerToken).catch(() => undefined);
            return { status: 'unavailable', reason: 'RPC handler returned a non-ciphertext result' };
        }
        if (Buffer.byteLength(response) > this.maxResultBytes) {
            await this.retirePending(recordPath, input, ownerToken).catch(() => undefined);
            return { status: 'unavailable', reason: 'RPC ciphertext result exceeds the durable ledger limit' };
        }

        try {
            const persistenceOutcome = await this.withLock(async () => {
                const current = await this.readRecord(recordPath);
                if (current.fingerprint !== input.fingerprint || current.callId !== input.callId) {
                    return { status: 'conflict', reason: 'RPC callId ledger reservation changed' } as const;
                }
                if (current.status === 'completed') {
                    return { status: 'completed', response: current.response, replayed: true } as const;
                }
                if (current.status === 'tombstone') {
                    return this.tombstoneOutcome(current);
                }
                if (current.ownerToken !== ownerToken) {
                    return { status: 'unavailable', reason: 'RPC call is owned by another executor' } as const;
                }
                const completed: CompletedLedgerRecord = {
                    ...current,
                    status: 'completed',
                    response,
                    completedAt: this.now(),
                };
                const serialized = serializedBytes(completed);
                const pendingSize = (await stat(recordPath)).size;
                if (!await this.pruneToFit(0, serialized.bytes - pendingSize, new Set([recordPath]))) {
                    return { status: 'unavailable', reason: 'RPC result ledger has no durable result capacity' } as const;
                }
                await this.replaceIndexedRecord(recordPath, completed, serialized);
                return { status: 'completed', response, replayed: false } as const;
            });
            if (persistenceOutcome.status === 'unavailable'
                && persistenceOutcome.reason === 'RPC result ledger has no durable result capacity') {
                // The side effect already ran. Do not leave a live-process
                // pending reservation that can never complete; replace it
                // with a permanent unknown-outcome fence outside the lock.
                await this.retirePending(recordPath, input, ownerToken).catch(() => undefined);
            }
            return persistenceOutcome;
        } catch (error) {
            // Preserve at-most-once safety even if the full encrypted result
            // cannot be persisted. A compact tombstone frees active capacity.
            await this.retirePending(recordPath, input, ownerToken).catch(() => undefined);
            return {
                status: 'unavailable',
                reason: error instanceof Error ? error.message : String(error),
            };
        }
    }

    private async waitForCompletion(
        recordPath: string,
        callId: string,
        fingerprint: string,
    ): Promise<RpcResultLedgerOutcome> {
        const deadline = this.now() + this.pendingWaitMs;
        while (true) {
            const record = await this.readRecord(recordPath).catch((error) => {
                throw new Error(`RPC pending ledger record became unreadable: ${error}`);
            });
            if (record.callId !== callId || record.fingerprint !== fingerprint) {
                return { status: 'conflict', reason: 'RPC callId ledger record conflicts with this request' };
            }
            if (record.status === 'completed') {
                return { status: 'completed', response: record.response, replayed: true };
            }
            if (record.status === 'tombstone') return this.tombstoneOutcome(record);
            if (!this.pendingOwnerAppearsAlive(record)) {
                await this.retirePending(recordPath, {
                    callId,
                    method: record.method,
                    paramsHash: record.paramsHash,
                    fingerprint,
                }).catch(() => undefined);
                return { status: 'unavailable', reason: 'Previous RPC executor exited with an unknown outcome' };
            }
            if (this.now() >= deadline) {
                return { status: 'unavailable', reason: 'RPC call is still in flight' };
            }
            await delay(this.pollIntervalMs);
        }
    }

    private recordPath(callId: string): string {
        const key = createHash('sha256').update(callId).digest('hex');
        return join(this.directory, `${key}.json`);
    }

    private tombstoneOutcome(record: TombstoneLedgerRecord): RpcResultLedgerOutcome {
        return {
            status: 'unavailable',
            reason: record.reason === 'acknowledged'
                ? 'RPC outcome was already acknowledged; refusing to re-execute the side effect'
                : 'Previous RPC executor exited with an unknown outcome',
        };
    }

    private tombstoneFor(
        record: LedgerRecord,
        reason: TombstoneLedgerRecord['reason'],
    ): TombstoneLedgerRecord {
        return {
            version: 1,
            status: 'tombstone',
            callId: record.callId,
            method: record.method,
            paramsHash: record.paramsHash,
            fingerprint: record.fingerprint,
            retiredAt: this.now(),
            reason,
        };
    }

    private recordRetention(record: PendingLedgerRecord | CompletedLedgerRecord): RpcResultRetention {
        return record.retention ?? 'time_bounded';
    }

    private pendingOwnerAppearsAlive(record: PendingLedgerRecord): boolean {
        if (record.ownerPid !== process.pid) return pidIsAlive(record.ownerPid);
        // Records written before incarnation fencing shipped have no safe way
        // to distinguish a same-process owner from a reused PID. Preserve the
        // old fail-closed behavior for those legacy records.
        return record.ownerInstanceId === undefined
            || record.ownerInstanceId === PROCESS_INSTANCE_ID;
    }

    private async retirePending(
        recordPath: string,
        input: { callId: string; method: string; paramsHash: string; fingerprint: string },
        ownerToken?: string,
    ): Promise<void> {
        await this.withLock(async () => {
            const current = await this.readRecord(recordPath);
            if (current.callId !== input.callId || current.fingerprint !== input.fingerprint) return;
            if (current.status !== 'pending') return;
            const ownedByCaller = ownerToken !== undefined && current.ownerToken === ownerToken;
            if (!ownedByCaller && this.pendingOwnerAppearsAlive(current)) return;

            const records = await this.gcAcknowledgedTombstones(
                await this.loadRecords(),
                new Set([recordPath]),
            );
            const tombstoneCount = records.filter((entry) => entry.record.status === 'tombstone').length;
            if (tombstoneCount >= this.maxTombstoneEntries) return;
            const tombstone = this.tombstoneFor(current, 'unknown_outcome');
            const serialized = serializedBytes(tombstone);
            const currentSize = (await stat(recordPath)).size;
            const totalBytes = records.reduce((total, entry) => total + entry.size, 0)
                - currentSize
                + serialized.bytes;
            if (totalBytes > this.maxTotalBytes) return;
            await this.replaceIndexedRecord(recordPath, tombstone, serialized);
        });
    }

    private async readRecordIfPresent(path: string): Promise<LedgerRecord | null> {
        try {
            return await this.readRecord(path);
        } catch (error) {
            if (errorCode(error) === 'ENOENT') return null;
            throw error;
        }
    }

    private async readRecord(path: string): Promise<LedgerRecord> {
        const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
        const parsed = parseLedgerRecord(raw);
        if (!parsed) throw new Error(`Malformed RPC result ledger record: ${basename(path)}`);
        return parsed;
    }

    private indexedRecord(record: LedgerRecord): LedgerRecord {
        // Capacity/GC only need completed metadata. Do not retain encrypted
        // response payloads in the process-wide index.
        return record.status === 'completed'
            ? { ...record, response: '' }
            : record;
    }

    private indexRecord(path: string, record: LedgerRecord, size: number): void {
        if (!this.activeIndex) {
            processLedgerIndexes.delete(this.directory);
            return;
        }
        this.activeIndex.records.set(path, {
            path,
            size,
            record: this.indexedRecord(record),
        });
    }

    private invalidateActiveIndex(): void {
        processLedgerIndexes.delete(this.directory);
        this.activeIndex = null;
    }

    private async writeIndexedRecordExclusive(
        path: string,
        record: LedgerRecord,
        serialized: { text: string; bytes: number },
    ): Promise<void> {
        try {
            await writeExclusive(path, serialized.text);
            this.indexRecord(path, record, serialized.bytes);
        } catch (error) {
            // Creation may have reached disk before a final fsync failed.
            this.invalidateActiveIndex();
            throw error;
        }
    }

    private async replaceIndexedRecord(
        path: string,
        record: LedgerRecord,
        serialized: { text: string; bytes: number },
    ): Promise<void> {
        try {
            await replaceAtomically(path, serialized.text);
            this.indexRecord(path, record, serialized.bytes);
        } catch (error) {
            // Rename may have committed before a final fsync failed.
            this.invalidateActiveIndex();
            throw error;
        }
    }

    private unindexRecord(path: string): void {
        if (!this.activeIndex) {
            processLedgerIndexes.delete(this.directory);
            return;
        }
        this.activeIndex.records.delete(path);
    }

    private async loadRecordsFromDisk(): Promise<LoadedLedgerRecord[]> {
        const entries = await readdir(this.directory, { withFileTypes: true });
        const records: LoadedLedgerRecord[] = [];
        const paths = entries
            .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name))
            .map((entry) => join(this.directory, entry.name));
        // A rebuild happens only after startup or an external process changes
        // the lock generation. Bound filesystem concurrency to avoid EMFILE.
        for (let index = 0; index < paths.length; index += 64) {
            const batch = await Promise.all(paths.slice(index, index + 64).map(async (path) => {
                const [record, metadata] = await Promise.all([this.readRecord(path), stat(path)]);
                return {
                    path,
                    size: metadata.size,
                    record: this.indexedRecord(record),
                };
            }));
            records.push(...batch);
        }
        return records;
    }

    private async loadRecords(): Promise<LoadedLedgerRecord[]> {
        if (this.activeIndex) return Array.from(this.activeIndex.records.values());
        return this.loadRecordsFromDisk();
    }

    private async gcAcknowledgedTombstones(
        records: LoadedLedgerRecord[],
        protectedPaths: ReadonlySet<string>,
    ): Promise<LoadedLedgerRecord[]> {
        const removed = new Set<string>();
        for (const entry of records) {
            if (entry.record.status !== 'tombstone'
                || entry.record.reason !== 'acknowledged'
                || this.now() - entry.record.retiredAt < this.acknowledgedTombstoneRetentionMs
                || protectedPaths.has(entry.path)) continue;
            await unlink(entry.path);
            this.unindexRecord(entry.path);
            removed.add(entry.path);
        }
        if (removed.size === 0) return records;
        await syncDirectory(this.directory);
        return records.filter((entry) => !removed.has(entry.path));
    }

    private async pruneToFit(
        additionalEntries: number,
        additionalBytes: number,
        protectedPaths: ReadonlySet<string>,
    ): Promise<boolean> {
        let records = await this.loadRecords();

        // Once the authoritative caller has committed an outcome and the
        // delayed-delivery grace has elapsed, its fence may be removed.
        records = await this.gcAcknowledgedTombstones(records, protectedPaths);
        let tombstoneCount = records.filter((entry) => entry.record.status === 'tombstone').length;

        // Existing Happy clients do not yet ACK every session/common RPC.
        // Preserve their historical bounded retry contract without allowing
        // it to weaken Agent Plane's caller-acknowledged side effects.
        const expiredTimeBounded = records
            .filter((entry) => entry.record.status === 'completed'
                && this.recordRetention(entry.record) === 'time_bounded'
                && this.now() - entry.record.completedAt >= this.minCompletedRetentionMs
                && !protectedPaths.has(entry.path))
            .sort((left, right) => {
                const leftTime = left.record.status === 'completed' ? left.record.completedAt : Infinity;
                const rightTime = right.record.status === 'completed' ? right.record.completedAt : Infinity;
                return leftTime - rightTime;
            });
        let activeCount = records.filter((entry) => entry.record.status !== 'tombstone').length
            + additionalEntries;
        let bytes = records.reduce((total, entry) => total + entry.size, 0) + additionalBytes;
        const removed = new Set<string>();
        while ((activeCount > this.maxEntries || bytes > this.maxTotalBytes)
            && expiredTimeBounded.length > 0) {
            const victim = expiredTimeBounded.shift()!;
            await unlink(victim.path);
            this.unindexRecord(victim.path);
            removed.add(victim.path);
            activeCount -= 1;
            bytes -= victim.size;
        }
        if (removed.size > 0) {
            await syncDirectory(this.directory);
            records = records.filter((entry) => !removed.has(entry.path));
        }

        // A pending record owned by a dead process has an unknowable outcome.
        // Convert it to a compact permanent fence so crashed calls do not
        // consume the active-result budget forever.
        for (const entry of records) {
            if (entry.record.status !== 'pending'
                || this.pendingOwnerAppearsAlive(entry.record)
                || protectedPaths.has(entry.path)
                || tombstoneCount >= this.maxTombstoneEntries) continue;
            const tombstone = this.tombstoneFor(entry.record, 'unknown_outcome');
            const serialized = serializedBytes(tombstone);
            await this.replaceIndexedRecord(entry.path, tombstone, serialized);
            entry.record = tombstone;
            entry.size = serialized.bytes;
            tombstoneCount += 1;
        }

        activeCount = records.filter((entry) => entry.record.status !== 'tombstone').length
            + additionalEntries;
        bytes = records.reduce((total, entry) => total + entry.size, 0) + additionalBytes;
        return activeCount <= this.maxEntries
            && tombstoneCount <= this.maxTombstoneEntries
            && bytes <= this.maxTotalBytes;
    }

    private async withLock<T>(operation: () => Promise<T>): Promise<T> {
        const token = randomUUID();
        const deadline = Date.now() + this.lockTimeoutMs;
        let ownedGeneration: number | null = null;
        let priorGeneration = 0;
        while (true) {
            const current = await this.readLatestLockState();
            const currentOwnerIsThisProcessIncarnation = current?.ownerPid === process.pid
                && current.ownerInstanceId === PROCESS_INSTANCE_ID;
            const currentOwnerAppearsLive = current?.status === 'locked'
                && (currentOwnerIsThisProcessIncarnation
                    || (current.ownerPid !== process.pid && pidIsAlive(current.ownerPid)));
            if (currentOwnerAppearsLive) {
                if (Date.now() >= deadline) throw new Error('Timed out acquiring RPC result ledger lock');
                await delay(this.pollIntervalMs);
                continue;
            }

            const nextGeneration = (current?.generation ?? 0) + 1;
            if (!Number.isSafeInteger(nextGeneration)) {
                throw new Error('RPC result ledger lock generation is exhausted');
            }
            const acquired = await this.publishLockState({
                version: 1,
                generation: nextGeneration,
                status: 'locked',
                ownerPid: process.pid,
                ownerInstanceId: PROCESS_INSTANCE_ID,
                ownerToken: token,
                createdAt: this.now(),
            });
            if (acquired) {
                ownedGeneration = nextGeneration;
                priorGeneration = current?.generation ?? 0;
                break;
            }
            if (Date.now() >= deadline) throw new Error('Timed out acquiring RPC result ledger lock');
            await delay(this.pollIntervalMs);
        }

        try {
            await this.pruneLockStates(ownedGeneration!);
            const cached = processLedgerIndexes.get(this.directory);
            if (cached?.generation === priorGeneration) {
                cached.generation = ownedGeneration!;
                this.activeIndex = cached;
            } else {
                processLedgerIndexes.delete(this.directory);
                const rebuilt = await this.loadRecordsFromDisk();
                this.activeIndex = {
                    generation: ownedGeneration!,
                    records: new Map(rebuilt.map((entry) => [entry.path, entry])),
                };
                processLedgerIndexes.set(this.directory, this.activeIndex);
            }
            return await operation();
        } finally {
            let current: LedgerLockState | null;
            try {
                current = await this.readLatestLockState();
            } catch (error) {
                // We cannot prove that the cached directory snapshot still
                // corresponds to the authoritative lock generation.
                this.invalidateActiveIndex();
                throw error;
            }
            if (current?.status !== 'locked'
                || current.generation !== ownedGeneration
                || current.ownerToken !== token) {
                this.invalidateActiveIndex();
                throw new Error('RPC result ledger lock ownership was fenced unexpectedly');
            }
            if (!Number.isSafeInteger(current.generation + 1)) {
                this.invalidateActiveIndex();
                throw new Error('RPC result ledger lock generation is exhausted');
            }
            let released: boolean;
            try {
                released = await this.publishLockState({
                    version: 1,
                    generation: current.generation + 1,
                    status: 'unlocked',
                    ownerPid: process.pid,
                    ownerInstanceId: PROCESS_INSTANCE_ID,
                    ownerToken: token,
                    createdAt: this.now(),
                });
            } catch (error) {
                // Publishing may have reached disk before a final directory
                // sync failed, so the next lock attempt must rebuild.
                this.invalidateActiveIndex();
                throw error;
            }
            if (!released) {
                this.invalidateActiveIndex();
                throw new Error('RPC result ledger lock release was superseded');
            }
            if (this.activeIndex) this.activeIndex.generation = current.generation + 1;
            this.activeIndex = null;
        }
    }

    private lockStatePath(generation: number): string {
        return join(
            this.directory,
            `.ledger-lock-${generation.toString().padStart(16, '0')}.json`,
        );
    }

    private async readLatestLockState(): Promise<LedgerLockState | null> {
        // A lock owner may prune an older generation after another contender
        // lists it. Retry that benign ENOENT race against the immutable journal.
        while (true) {
            const entries = await readdir(this.directory, { withFileTypes: true });
            const generations = entries
                .filter((entry) => entry.isFile() && LOCK_STATE_FILENAME.test(entry.name))
                .map((entry) => ({
                    name: entry.name,
                    generation: Number(LOCK_STATE_FILENAME.exec(entry.name)?.[1]),
                }))
                .filter((entry) => Number.isSafeInteger(entry.generation))
                .sort((left, right) => right.generation - left.generation);
            const latest = generations[0];
            if (!latest) return null;
            try {
                const value = JSON.parse(await readFile(join(this.directory, latest.name), 'utf8')) as unknown;
                const state = parseLockState(value);
                if (!state || state.generation !== latest.generation) {
                    throw new Error(`Malformed RPC result ledger lock state: ${latest.name}`);
                }
                return state;
            } catch (error) {
                if (errorCode(error) === 'ENOENT') continue;
                throw error;
            }
        }
    }

    private async publishLockState(state: LedgerLockState): Promise<boolean> {
        const finalPath = this.lockStatePath(state.generation);
        const temporaryPath = join(
            this.directory,
            `.ledger-lock-${process.pid}-${randomUUID()}.pending`,
        );
        const serialized = JSON.stringify(state);
        const handle = await open(temporaryPath, 'wx', 0o600);
        try {
            await handle.writeFile(serialized, 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }

        let published = false;
        try {
            await link(temporaryPath, finalPath);
            published = true;
            await syncDirectory(this.directory);
        } catch (error) {
            if (errorCode(error) !== 'EEXIST') throw error;
        } finally {
            await unlink(temporaryPath).catch((error) => {
                if (errorCode(error) !== 'ENOENT') throw error;
            });
            await syncDirectory(this.directory);
        }
        return published;
    }

    private async pruneLockStates(keepGeneration: number): Promise<void> {
        const entries = await readdir(this.directory, { withFileTypes: true });
        let deleted = false;
        for (const entry of entries) {
            const match = entry.isFile() ? LOCK_STATE_FILENAME.exec(entry.name) : null;
            if (!match || Number(match[1]) === keepGeneration) continue;
            await unlink(join(this.directory, entry.name)).catch((error) => {
                if (errorCode(error) !== 'ENOENT') throw error;
            });
            deleted = true;
        }
        if (deleted) await syncDirectory(this.directory);
    }
}
