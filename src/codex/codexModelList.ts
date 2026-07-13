import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type JsonRpcRequest = {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: any;
};

type JsonRpcResponse = {
    jsonrpc?: '2.0';
    id?: number;
    result?: any;
    error?: { code?: number; message?: string; data?: any };
};

export interface CodexReasoningEffortOption {
    reasoningEffort: string;
    label?: string;
    description?: string;
}

export interface CodexModelInfo {
    model: string;
    displayName?: string;
    description?: string;
    isDefault?: boolean;
    upgrade?: string | null;
    defaultReasoningEffort?: string | null;
    supportedReasoningEfforts?: CodexReasoningEffortOption[];
}

function asErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error ?? 'Unknown error');
}

interface CodexCachedReasoningLevel {
    effort?: string;
    description?: string;
}

interface CodexCachedModel {
    slug?: string;
    display_name?: string;
    description?: string;
    priority?: number;
    visibility?: string;
    upgrade?: string | null;
    default_reasoning_level?: string | null;
    supported_reasoning_levels?: CodexCachedReasoningLevel[];
}

interface CodexModelsCacheFile {
    models?: CodexCachedModel[];
}

function mapCachedModel(raw: CodexCachedModel): CodexModelInfo | null {
    if (!raw || typeof raw.slug !== 'string' || !raw.slug) return null;
    const efforts: CodexReasoningEffortOption[] = Array.isArray(raw.supported_reasoning_levels)
        ? raw.supported_reasoning_levels
            .filter((e): e is CodexCachedReasoningLevel => !!e && typeof e.effort === 'string')
            .map((e) => ({
                reasoningEffort: e.effort!,
                description: e.description,
            }))
        : [];
    return {
        model: raw.slug,
        displayName: typeof raw.display_name === 'string' ? raw.display_name : undefined,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        upgrade: raw.upgrade ?? null,
        defaultReasoningEffort: raw.default_reasoning_level ?? null,
        supportedReasoningEfforts: efforts.length > 0 ? efforts : undefined,
    };
}

function codexModelsCachePath(env?: Record<string, string>): string {
    const codexHome = env?.CODEX_HOME || process.env.CODEX_HOME || join(homedir(), '.codex');
    return join(codexHome, 'models_cache.json');
}

async function readCodexModelsCache(env?: Record<string, string>): Promise<CodexModelInfo[] | null> {
    let raw: string;
    try {
        raw = await fs.readFile(codexModelsCachePath(env), 'utf8');
    } catch {
        return null;
    }
    let parsed: CodexModelsCacheFile;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || !Array.isArray(parsed.models)) return null;

    const visible = parsed.models
        .filter((m) => m && (m.visibility === undefined || m.visibility === 'list'));

    const ordered = visible
        .map((m) => ({ priority: typeof m.priority === 'number' ? m.priority : Number.MAX_SAFE_INTEGER, model: m }))
        .sort((a, b) => a.priority - b.priority)
        .map((entry) => entry.model);

    const mapped: CodexModelInfo[] = [];
    for (const m of ordered) {
        const info = mapCachedModel(m);
        if (info) mapped.push(info);
    }
    if (mapped.length === 0) return null;
    mapped[0].isDefault = true;
    return mapped;
}

async function rpcCall(
    proc: ReturnType<typeof spawn>,
    pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>,
    req: JsonRpcRequest
) {
    const line = JSON.stringify(req) + '\n';
    if (!proc.stdin) throw new Error('Codex app-server stdin is not available');
    proc.stdin.write(line);

    return await new Promise<any>((resolve, reject) => {
        pending.set(req.id, { resolve, reject });
    });
}

function mergeCodexModelCatalogs(
    appServerModels: CodexModelInfo[],
    cachedModels: CodexModelInfo[] | null,
): CodexModelInfo[] {
    const cachedById = new Map((cachedModels ?? []).map((model) => [model.model, model]));
    const merged: CodexModelInfo[] = appServerModels.map((model) => {
        const cached = cachedById.get(model.model);
        const result: CodexModelInfo = {
            ...cached,
            ...model,
        };
        if (Object.prototype.hasOwnProperty.call(model, 'supportedReasoningEfforts')) {
            result.supportedReasoningEfforts = model.supportedReasoningEfforts;
        } else if (cached?.supportedReasoningEfforts !== undefined) {
            result.supportedReasoningEfforts = cached.supportedReasoningEfforts;
        } else {
            delete result.supportedReasoningEfforts;
        }
        if (Object.prototype.hasOwnProperty.call(model, 'defaultReasoningEffort')) {
            result.defaultReasoningEffort = model.defaultReasoningEffort;
        } else if (cached?.defaultReasoningEffort !== undefined) {
            result.defaultReasoningEffort = cached.defaultReasoningEffort;
        } else {
            delete result.defaultReasoningEffort;
        }
        return result;
    });

    const appServerIds = new Set(appServerModels.map((model) => model.model));
    for (const cached of cachedModels ?? []) {
        if (!appServerIds.has(cached.model)) merged.push({ ...cached });
    }

    const appServerDefault = appServerModels.find((model) => model.isDefault)?.model;
    const cachedDefault = cachedModels?.find((model) => model.isDefault)?.model;
    const defaultModel = appServerDefault ?? cachedDefault;
    for (const model of merged) {
        if (model.model === defaultModel) model.isDefault = true;
        else delete model.isDefault;
    }
    return merged;
}

/**
 * List models from the local `codex` CLI.
 *
 * `model/list` is authoritative for fields and per-model reasoning efforts.
 * The interactive selector's models cache supplements entries that a running
 * app-server has not exposed yet. If app-server discovery fails entirely, the
 * cache remains a graceful offline fallback.
 */
export async function codexModelList(opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<CodexModelInfo[]> {
    const cachedPromise = readCodexModelsCache(opts?.env);
    try {
        const appServerModels = await codexModelListViaAppServer(opts);
        const cachedModels = await cachedPromise;
        if (appServerModels.length > 0) {
            return mergeCodexModelCatalogs(appServerModels, cachedModels);
        }
        if (cachedModels?.length) return cachedModels;
        return [];
    } catch (error) {
        const cachedModels = await cachedPromise;
        if (cachedModels?.length) return cachedModels;
        throw error;
    }
}

export async function codexModelListViaAppServer(opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<CodexModelInfo[]> {
    const timeoutMs = opts?.timeoutMs ?? 8_000;

    // Codex app-server speaks newline-delimited JSON-RPC over stdio.
    const proc = spawn('codex', ['app-server', '--listen', 'stdio://'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...opts?.env },
    });

    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    let nextId = 1;
    let stderrBuf = '';

    const kill = () => {
        try {
            proc.kill('SIGTERM');
        } catch {
            // ignore
        }
    };

    const rejectPending = (error: Error) => {
        for (const [, p] of pending) {
            p.reject(error);
        }
        pending.clear();
    };

    const timer = setTimeout(() => {
        rejectPending(new Error('Timed out while listing Codex models'));
        kill();
    }, timeoutMs);

    proc.on('error', (e) => {
        rejectPending(e instanceof Error ? e : new Error(asErrorMessage(e)));
    });

    proc.on('exit', (code, signal) => {
        if (pending.size === 0) return;

        const detail = signal
            ? `signal ${signal}`
            : `exit code ${code ?? 'unknown'}`;
        rejectPending(new Error(`Codex app-server exited while listing models (${detail})`));
    });

    proc.stderr.on('data', (d) => {
        // Keep a small buffer for error reporting.
        const s = d.toString();
        stderrBuf = (stderrBuf + s).slice(-16_384);
    });

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
        let msg: JsonRpcResponse | null = null;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }
        if (!msg || typeof msg !== 'object') return;
        if (typeof msg.id !== 'number') return;

        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);

        if (msg.error) {
            p.reject(new Error(msg.error.message || 'Unknown JSON-RPC error'));
            return;
        }
        p.resolve(msg.result);
    });

    try {
        // Initialize is required by the app-server protocol.
        await rpcCall(proc, pending, {
            jsonrpc: '2.0',
            id: nextId++,
            method: 'initialize',
            params: {
                clientInfo: {
                    name: 'happy-coder',
                    title: null,
                    version: process.env.npm_package_version ?? '0',
                },
                capabilities: null,
            },
        });

        const models: CodexModelInfo[] = [];
        let cursor: string | null = null;

        while (true) {
            const result = await rpcCall(proc, pending, {
                jsonrpc: '2.0',
                id: nextId++,
                method: 'model/list',
                params: cursor ? { cursor, limit: 200 } : { limit: 200 },
            });

            const data = result?.data;
            if (Array.isArray(data)) {
                for (const m of data) {
                    if (!m || typeof m !== 'object') continue;
                    if (typeof (m as any).model !== 'string') continue;
                    models.push(m as CodexModelInfo);
                }
            }

            cursor = (typeof result?.nextCursor === 'string' && result.nextCursor) ? result.nextCursor : null;
            if (!cursor) break;
        }

        return models;
    } catch (e) {
        const msg = asErrorMessage(e);
        if (stderrBuf.trim()) {
            throw new Error(`${msg}\n\ncodex stderr:\n${stderrBuf.trim()}`);
        }
        throw new Error(msg);
    } finally {
        clearTimeout(timer);
        rl.close();
        kill();
    }
}
