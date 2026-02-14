import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

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
 * List models from the local `codex` CLI via `codex app-server --listen stdio://`.
 *
 * This is used by the daemon's RPC so the mobile app can show a machine-specific
 * model picker that stays in sync with Codex as the available models change.
 */
export async function codexModelList(opts?: { timeoutMs?: number }): Promise<CodexModelInfo[]> {
    const timeoutMs = opts?.timeoutMs ?? 8_000;

    // Codex app-server speaks newline-delimited JSON-RPC over stdio.
    const proc = spawn('codex', ['app-server', '--listen', 'stdio://'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
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

    const timer = setTimeout(() => {
        for (const [, p] of pending) {
            p.reject(new Error('Timed out while listing Codex models'));
        }
        pending.clear();
        kill();
    }, timeoutMs);

    proc.on('error', (e) => {
        for (const [, p] of pending) p.reject(e instanceof Error ? e : new Error(asErrorMessage(e)));
        pending.clear();
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

