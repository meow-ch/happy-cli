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

const CODEX_MODELS_CACHE_PATH = join(homedir(), '.codex', 'models_cache.json');

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

async function readCodexModelsCache(): Promise<CodexModelInfo[] | null> {
    let raw: string;
    try {
        raw = await fs.readFile(CODEX_MODELS_CACHE_PATH, 'utf8');
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

/**
 * List models from the local `codex` CLI.
 *
 * Primary source: `~/.codex/models_cache.json` — this is the same file the
 * interactive `codex /model` selector reads, so the picker matches `/model`
 * exactly (including new entries like gpt-5.5 that don't have a structured
 * config in app-server's `model/list` RPC yet).
 *
 * Fallback: spawn `codex app-server --listen stdio://` and call `model/list`
 * for hosts where the cache file is missing (fresh codex install, custom
 * codex_home dir, or future versions that move the cache).
 */
export async function codexModelList(opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<CodexModelInfo[]> {
    const cached = await readCodexModelsCache();
    if (cached && cached.length > 0) return cached;
    return await codexModelListViaAppServer(opts);
}

async function codexModelListViaAppServer(opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<CodexModelInfo[]> {
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
