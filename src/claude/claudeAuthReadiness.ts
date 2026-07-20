import { spawn } from 'node:child_process';
import type { EnvironmentVariablesMode } from '@/modules/common/registerCommonHandlers';

export type ClaudeAuthenticationStatus = 'ready' | 'required' | 'unknown';

export interface ClaudeProviderReadiness {
    type: 'provider-readiness';
    provider: 'claude';
    checkedAt: number;
    ready: boolean;
    executable: {
        status: 'ready' | 'missing' | 'unknown';
    };
    authentication: {
        status: ClaudeAuthenticationStatus;
        verification: 'claude_auth_status';
        reason: 'authenticated' | 'authentication_required' | 'probe_failed' | 'invalid_response';
        authMethod?: string;
        apiProvider?: string;
    };
}

export interface ProviderReadinessRequest {
    provider: 'claude';
    environmentVariables?: Record<string, string>;
    environmentVariablesMode?: EnvironmentVariablesMode;
    token?: string;
}

export type ProviderReadinessResponse = ClaudeProviderReadiness;

interface ClaudeAuthStatusProcessResult {
    kind: 'completed' | 'missing' | 'timed_out' | 'failed';
    exitCode?: number;
    stdout?: string;
}

export interface ProbeClaudeAuthReadinessOptions {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    now?: () => number;
    runAuthStatus?: (
        env: NodeJS.ProcessEnv,
        timeoutMs: number,
    ) => Promise<ClaudeAuthStatusProcessResult>;
}

const DEFAULT_AUTH_STATUS_TIMEOUT_MS = 5_000;
const MAX_AUTH_STATUS_STDOUT_BYTES = 16 * 1024;

function safeStatusValue(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    if (!normalized || normalized.length > 80) return undefined;
    // Auth method/provider identifiers are expected to be short machine
    // labels. Whitelisting their alphabet prevents future Claude output from
    // accidentally carrying credentials through this readiness response.
    return /^[a-zA-Z0-9_.-]+$/.test(normalized) ? normalized : undefined;
}

function parseClaudeAuthStatus(
    stdout: string,
    checkedAt: number,
): ClaudeProviderReadiness {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return unknownReadiness(checkedAt, 'invalid_response');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return unknownReadiness(checkedAt, 'invalid_response');
    }

    const status = parsed as Record<string, unknown>;
    if (typeof status.loggedIn !== 'boolean') {
        return unknownReadiness(checkedAt, 'invalid_response');
    }

    const authMethod = safeStatusValue(status.authMethod);
    const apiProvider = safeStatusValue(status.apiProvider);
    if (status.loggedIn) {
        return {
            type: 'provider-readiness',
            provider: 'claude',
            checkedAt,
            ready: true,
            executable: { status: 'ready' },
            authentication: {
                status: 'ready',
                verification: 'claude_auth_status',
                reason: 'authenticated',
                ...(authMethod ? { authMethod } : {}),
                ...(apiProvider ? { apiProvider } : {}),
            },
        };
    }

    return {
        type: 'provider-readiness',
        provider: 'claude',
        checkedAt,
        ready: false,
        executable: { status: 'ready' },
        authentication: {
            status: 'required',
            verification: 'claude_auth_status',
            reason: 'authentication_required',
            ...(authMethod ? { authMethod } : {}),
            ...(apiProvider ? { apiProvider } : {}),
        },
    };
}

function unknownReadiness(
    checkedAt: number,
    reason: 'probe_failed' | 'invalid_response',
    executableStatus: 'missing' | 'unknown' = 'unknown',
): ClaudeProviderReadiness {
    return {
        type: 'provider-readiness',
        provider: 'claude',
        checkedAt,
        ready: false,
        executable: { status: executableStatus },
        authentication: {
            status: 'unknown',
            verification: 'claude_auth_status',
            reason,
        },
    };
}

async function runClaudeAuthStatus(
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
): Promise<ClaudeAuthStatusProcessResult> {
    return new Promise((resolve) => {
        let settled = false;
        let stdout = '';
        let timer: NodeJS.Timeout | undefined;
        const finish = (result: ClaudeAuthStatusProcessResult) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(result);
        };
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn('claude', ['auth', 'status', '--json'], {
                env,
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true,
                shell: process.platform === 'win32',
            });
        } catch {
            finish({ kind: 'failed' });
            return;
        }
        timer = setTimeout(() => {
            child.kill('SIGTERM');
            finish({ kind: 'timed_out' });
        }, timeoutMs);
        timer.unref?.();

        child.stdout?.on('data', (chunk: Buffer | string) => {
            if (Buffer.byteLength(stdout) >= MAX_AUTH_STATUS_STDOUT_BYTES) return;
            stdout = (stdout + chunk.toString()).slice(0, MAX_AUTH_STATUS_STDOUT_BYTES);
        });
        child.on('error', (error: NodeJS.ErrnoException) => {
            finish({ kind: error.code === 'ENOENT' ? 'missing' : 'failed' });
        });
        child.on('close', (exitCode) => {
            finish({
                kind: 'completed',
                exitCode: exitCode ?? undefined,
                stdout,
            });
        });
    });
}

/**
 * Ask Claude Code for its local authentication status without sending a
 * prompt or returning credential-bearing fields. This proves local
 * configuration readiness, not remote token validity; definitive provider
 * authentication failures are classified separately from terminal results.
 */
export async function probeClaudeAuthReadiness(
    options: ProbeClaudeAuthReadinessOptions = {},
): Promise<ClaudeProviderReadiness> {
    const checkedAt = (options.now ?? Date.now)();
    const result = await (options.runAuthStatus ?? runClaudeAuthStatus)(
        options.env ?? process.env,
        options.timeoutMs ?? DEFAULT_AUTH_STATUS_TIMEOUT_MS,
    );

    if (result.kind === 'missing') {
        return unknownReadiness(checkedAt, 'probe_failed', 'missing');
    }
    if (result.kind !== 'completed' || typeof result.stdout !== 'string') {
        return unknownReadiness(checkedAt, 'probe_failed');
    }
    // `claude auth status --json` intentionally exits non-zero while logged
    // out, but still emits an authoritative `{ loggedIn: false }` document.
    // Parse valid JSON regardless of the process exit code.
    return parseClaudeAuthStatus(result.stdout, checkedAt);
}

export const __testClaudeAuthReadinessInternals = {
    parseClaudeAuthStatus,
};
