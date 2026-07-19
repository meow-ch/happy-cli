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
    ownerToken: string;
    createdAt: number;
}

interface CompletedLedgerRecord extends Omit<PendingLedgerRecord, 'status'> {
    status: 'completed';
    response: string;
    completedAt: number;
}

type LedgerRecord = PendingLedgerRecord | CompletedLedgerRecord;

export type RpcResultLedgerOutcome =
    | { status: 'completed'; response: string; replayed: boolean }
    | { status: 'conflict'; reason: string }
    | { status: 'unavailable'; reason: string };

export interface RpcResultLedgerOptions {
    directory?: string;
    maxEntries?: number;
    maxTotalBytes?: number;
    maxResultBytes?: number;
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

interface InFlightExecution {
    fingerprint: string;
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
const PROCESS_INSTANCE_ID = randomUUID();
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);
const LOCK_STATE_FILENAME = /^\.ledger-lock-(\d{16})\.json$/;
export const MIN_RPC_RESULT_RETENTION_MS = 24 * 60 * 60 * 1_000;

export function defaultRpcResultLedgerDirectory(): string {
    return join(configuration.happyHomeDir, 'rpc-result-ledger');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLedgerRecord(value: unknown): LedgerRecord | null {
    if (!isRecord(value)
        || value.version !== 1
        || (value.status !== 'pending' && value.status !== 'completed')
        || typeof value.callId !== 'string'
        || value.callId.length === 0
        || typeof value.method !== 'string'
        || value.method.length === 0
        || typeof value.paramsHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.paramsHash)
        || typeof value.fingerprint !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.fingerprint)
        || typeof value.ownerPid !== 'number'
        || !Number.isInteger(value.ownerPid)
        || value.ownerPid <= 0
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
    private readonly maxTotalBytes: number;
    private readonly maxResultBytes: number;
    private readonly minCompletedRetentionMs: number;
    private readonly lockTimeoutMs: number;
    private readonly pendingWaitMs: number;
    private readonly pollIntervalMs: number;
    private readonly now: () => number;

    constructor(options: RpcResultLedgerOptions = {}) {
        this.directory = options.directory ?? defaultRpcResultLedgerDirectory();
        this.maxEntries = Math.max(1, options.maxEntries ?? 512);
        this.maxTotalBytes = Math.max(1_024, options.maxTotalBytes ?? 64 * 1024 * 1024);
        this.maxResultBytes = Math.max(1_024, options.maxResultBytes ?? 8 * 1024 * 1024);
        this.minCompletedRetentionMs = Math.max(
            MIN_RPC_RESULT_RETENTION_MS,
            options.minCompletedRetentionMs ?? MIN_RPC_RESULT_RETENTION_MS,
        );
        this.lockTimeoutMs = Math.max(100, options.lockTimeoutMs ?? 5_000);
        this.pendingWaitMs = Math.max(0, options.pendingWaitMs ?? 60_000);
        this.pollIntervalMs = Math.max(5, options.pollIntervalMs ?? 50);
        this.now = options.now ?? Date.now;
    }

    async execute(
        input: { callId: string; method: string; paramsHash: string },
        executor: () => Promise<string>,
    ): Promise<RpcResultLedgerOutcome> {
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
            return current.promise;
        }

        const promise = this.executeInternal({ ...input, fingerprint }, executor);
        processInFlight.set(processKey, { fingerprint, promise });
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

    private async executeInternal(
        input: { callId: string; method: string; paramsHash: string; fingerprint: string },
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
                    ownerToken,
                    createdAt: this.now(),
                };
                const serialized = serializedBytes(pending);
                if (!await this.pruneToFit(1, serialized.bytes, new Set())) {
                    throw new Error('RPC result ledger capacity is exhausted by pending records');
                }
                await writeExclusive(recordPath, serialized.text);
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
            // Keep the durable pending reservation. The handler may have
            // completed a side effect before throwing, so retrying is unsafe.
            return {
                status: 'unavailable',
                reason: error instanceof Error ? error.message : String(error),
            };
        }
        if (typeof response !== 'string') {
            return { status: 'unavailable', reason: 'RPC handler returned a non-ciphertext result' };
        }
        if (Buffer.byteLength(response) > this.maxResultBytes) {
            return { status: 'unavailable', reason: 'RPC ciphertext result exceeds the durable ledger limit' };
        }

        try {
            return await this.withLock(async () => {
                const current = await this.readRecord(recordPath);
                if (current.fingerprint !== input.fingerprint || current.callId !== input.callId) {
                    return { status: 'conflict', reason: 'RPC callId ledger reservation changed' } as const;
                }
                if (current.status === 'completed') {
                    return { status: 'completed', response: current.response, replayed: true } as const;
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
                await replaceAtomically(recordPath, serialized.text);
                return { status: 'completed', response, replayed: false } as const;
            });
        } catch (error) {
            // The durable pending reservation intentionally remains. Replaying a
            // side effect after an unknown completion outcome would be unsafe.
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
            if (!pidIsAlive(record.ownerPid)) {
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

    private async loadRecords(): Promise<LoadedLedgerRecord[]> {
        const entries = await readdir(this.directory, { withFileTypes: true });
        const records: LoadedLedgerRecord[] = [];
        for (const entry of entries) {
            if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
            const path = join(this.directory, entry.name);
            const [record, metadata] = await Promise.all([this.readRecord(path), stat(path)]);
            records.push({ path, size: metadata.size, record });
        }
        return records;
    }

    private async pruneToFit(
        additionalEntries: number,
        additionalBytes: number,
        protectedPaths: ReadonlySet<string>,
    ): Promise<boolean> {
        const records = await this.loadRecords();
        let count = records.length + additionalEntries;
        let bytes = records.reduce((total, entry) => total + entry.size, 0) + additionalBytes;
        const victims = records
            .filter((entry) => entry.record.status === 'completed'
                && this.now() - entry.record.completedAt >= this.minCompletedRetentionMs
                && !protectedPaths.has(entry.path))
            .sort((left, right) => {
                const leftTime = left.record.status === 'completed' ? left.record.completedAt : Infinity;
                const rightTime = right.record.status === 'completed' ? right.record.completedAt : Infinity;
                return leftTime - rightTime;
            });
        let deleted = false;
        while ((count > this.maxEntries || bytes > this.maxTotalBytes) && victims.length > 0) {
            const victim = victims.shift()!;
            await unlink(victim.path);
            count -= 1;
            bytes -= victim.size;
            deleted = true;
        }
        if (deleted) await syncDirectory(this.directory);
        return count <= this.maxEntries && bytes <= this.maxTotalBytes;
    }

    private async withLock<T>(operation: () => Promise<T>): Promise<T> {
        const token = randomUUID();
        const deadline = Date.now() + this.lockTimeoutMs;
        let ownedGeneration: number | null = null;
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
                break;
            }
            if (Date.now() >= deadline) throw new Error('Timed out acquiring RPC result ledger lock');
            await delay(this.pollIntervalMs);
        }

        try {
            await this.pruneLockStates(ownedGeneration!);
            return await operation();
        } finally {
            const current = await this.readLatestLockState();
            if (current?.status !== 'locked'
                || current.generation !== ownedGeneration
                || current.ownerToken !== token) {
                throw new Error('RPC result ledger lock ownership was fenced unexpectedly');
            }
            if (!Number.isSafeInteger(current.generation + 1)) {
                throw new Error('RPC result ledger lock generation is exhausted');
            }
            const released = await this.publishLockState({
                version: 1,
                generation: current.generation + 1,
                status: 'unlocked',
                ownerPid: process.pid,
                ownerInstanceId: PROCESS_INSTANCE_ID,
                ownerToken: token,
                createdAt: this.now(),
            });
            if (!released) throw new Error('RPC result ledger lock release was superseded');
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
