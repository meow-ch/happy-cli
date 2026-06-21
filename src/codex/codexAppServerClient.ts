import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import packageJson from '../../package.json';
import { logger } from '@/ui/logger';
import type { CodexSessionConfig, CodexToolResponse } from './types';
import { CodexPermissionHandler } from './utils/permissionHandler';
import type { AgentQuestionnaire } from '@/api/types';

const DEFAULT_TIMEOUT = 14 * 24 * 60 * 60 * 1000;

type JsonRpcId = number | string;

type JsonRpcRequest = {
    jsonrpc: '2.0';
    id: JsonRpcId;
    method: string;
    params?: unknown;
};

type JsonRpcResponse = {
    jsonrpc?: '2.0';
    id?: JsonRpcId;
    result?: unknown;
    error?: { code?: number; message?: string; data?: unknown };
};

type JsonRpcNotification = {
    jsonrpc?: '2.0';
    method: string;
    params?: unknown;
};

export type CodexAppServerInput =
    | { type: 'text'; text: string; text_elements: unknown[] }
    | { type: 'localImage'; path: string }
    | { type: 'image'; url: string };

type PendingTurn = {
    resolve: (response: CodexToolResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
};

function sandboxPolicyFromMode(mode: CodexSessionConfig['sandbox']): Record<string, unknown> | null {
    switch (mode) {
        case 'read-only':
            return { type: 'readOnly' };
        case 'workspace-write':
            return { type: 'workspaceWrite' };
        case 'danger-full-access':
            return { type: 'dangerFullAccess' };
        default:
            return null;
    }
}

function collaborationModeParams(config: Partial<CodexSessionConfig>): Record<string, unknown> | null {
    if (!config.collaboration_mode || !config.model) return null;
    return {
        mode: config.collaboration_mode,
        settings: {
            model: config.model,
            reasoning_effort: config.model_reasoning_effort ?? null,
            developer_instructions: null,
        },
    };
}

function normalizePlanSteps(value: unknown): Array<{ step: string; status?: string | null }> {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
            const raw = item as Record<string, unknown>;
            const step = typeof raw.step === 'string' ? raw.step.trim() : '';
            if (!step) return null;
            return {
                step,
                status: typeof raw.status === 'string' ? raw.status : null,
            };
        })
        .filter((item): item is { step: string; status: string | null } => item !== null);
}

function planTextFromParts(explanation: unknown, steps: Array<{ step: string; status?: string | null }>): string {
    const chunks: string[] = [];
    if (typeof explanation === 'string' && explanation.trim()) chunks.push(explanation.trim());
    if (steps.length > 0) {
        chunks.push(steps.map((item) => `- ${item.step}`).join('\n'));
    }
    return chunks.join('\n\n');
}

function turnLifecycleEventFromCompletion(params: any): { type: 'task_complete' | 'turn_aborted'; turn_id?: string } {
    const turn = params?.turn;
    const event = {
        type: turn?.status === 'interrupted' ? 'turn_aborted' : 'task_complete',
    } as { type: 'task_complete' | 'turn_aborted'; turn_id?: string };
    if (typeof turn?.id === 'string') event.turn_id = turn.id;
    return event;
}

export const __testCodexAppServerClientInternals = {
    normalizePlanSteps,
    planTextFromParts,
    turnLifecycleEventFromCompletion,
};

function asError(error: unknown): Error {
    if (error instanceof Error) return error;
    return new Error(String(error ?? 'Unknown error'));
}

function asAbortError(): Error {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
}

function mapPermissionDecision(decision: string): 'accept' | 'acceptForSession' | 'decline' | 'cancel' {
    switch (decision) {
        case 'approved':
            return 'accept';
        case 'approved_for_session':
            return 'acceptForSession';
        case 'denied':
            return 'decline';
        default:
            return 'cancel';
    }
}

export class CodexAppServerClient {
    private proc: ChildProcessWithoutNullStreams | null = null;
    private rl: ReadlineInterface | null = null;
    private connected = false;
    private nextId = 1;
    private pending = new Map<JsonRpcId, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    private pendingTurns = new Map<string, PendingTurn>();
    private completedTurns = new Map<string, CodexToolResponse>();
    private threadId: string | null = null;
    private handler: ((event: any) => void) | null = null;
    private permissionHandler: CodexPermissionHandler | null = null;
    private stderrBuf = '';

    constructor(private readonly env?: Record<string, string>) {}

    setHandler(handler: ((event: any) => void) | null): void {
        this.handler = handler;
    }

    setPermissionHandler(handler: CodexPermissionHandler): void {
        this.permissionHandler = handler;
    }

    async connect(): Promise<void> {
        if (this.connected) return;

        logger.debug('[CodexAppServer] Connecting to Codex app-server');
        this.proc = spawn('codex', ['app-server', '--listen', 'stdio://'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...Object.keys(process.env).reduce((acc, key) => {
                    const value = process.env[key];
                    if (typeof value === 'string') acc[key] = value;
                    return acc;
                }, {} as Record<string, string>),
                ...(this.env ?? {}),
            },
        });

        this.proc.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            this.stderrBuf = (this.stderrBuf + text).slice(-16_384);
            logger.debug(`[CodexAppServer:stderr] ${text.trimEnd()}`);
        });

        this.proc.on('error', (error) => {
            this.rejectAll(asError(error));
        });

        this.proc.on('exit', (code, signal) => {
            this.connected = false;
            const detail = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
            const error = new Error(`Codex app-server exited (${detail})`);
            this.rejectAll(error);
        });

        this.rl = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
        this.rl.on('line', (line) => this.handleLine(line));

        await this.rpcCall('initialize', {
            clientInfo: {
                name: 'happy-coder',
                title: null,
                version: packageJson.version ?? '0',
            },
            capabilities: { experimentalApi: true },
        });

        this.connected = true;
        logger.debug('[CodexAppServer] Connected to Codex app-server');
    }

    async listCollaborationModes(): Promise<Array<{ name?: string; mode?: string | null; model?: string | null; reasoning_effort?: string | null }>> {
        if (!this.connected) await this.connect();
        const response = await this.rpcCall('collaborationMode/list', {});
        return Array.isArray(response?.data) ? response.data : [];
    }

    async listPermissionProfiles(): Promise<Array<{ id: string; description?: string | null }>> {
        if (!this.connected) await this.connect();
        const profiles: Array<{ id: string; description?: string | null }> = [];
        let cursor: string | null = null;
        while (true) {
            const response = await this.rpcCall(
                'permissionProfile/list',
                cursor ? { cursor, limit: 200 } : { limit: 200 },
            );
            if (Array.isArray(response?.data)) {
                for (const profile of response.data) {
                    if (profile && typeof profile.id === 'string') {
                        profiles.push({
                            id: profile.id,
                            description: typeof profile.description === 'string' ? profile.description : null,
                        });
                    }
                }
            }
            cursor = typeof response?.nextCursor === 'string' && response.nextCursor ? response.nextCursor : null;
            if (!cursor) return profiles;
        }
    }

    async startSession(
        config: CodexSessionConfig,
        options?: { signal?: AbortSignal; input?: CodexAppServerInput[] }
    ): Promise<CodexToolResponse> {
        if (!this.connected) await this.connect();

        const threadParams: Record<string, unknown> = {
            model: config.model ?? null,
            cwd: config.cwd ?? process.cwd(),
            approvalPolicy: config['approval-policy'] ?? null,
            config: config.config ?? null,
            developerInstructions: config['base-instructions'] ?? null,
            ephemeral: false,
        };
        if (config.permissions) {
            threadParams.permissions = config.permissions;
        } else {
            threadParams.sandbox = config.sandbox ?? null;
        }

        const threadResponse: any = await this.rpcCall('thread/start', threadParams, options?.signal);
        this.threadId = threadResponse?.thread?.id ?? null;
        if (!this.threadId) {
            throw new Error('Codex app-server did not return a thread id');
        }

        logger.debug(`[CodexAppServer] Started thread ${this.threadId}`);
        const input = options?.input ?? [{ type: 'text' as const, text: config.prompt, text_elements: [] }];
        return await this.runTurn(input, config, options?.signal);
    }

    async continueSession(
        input: string | CodexAppServerInput[],
        options?: {
            signal?: AbortSignal;
            mode?: Pick<CodexSessionConfig, 'model' | 'model_reasoning_effort' | 'approval-policy' | 'sandbox' | 'permissions' | 'collaboration_mode'>;
        }
    ): Promise<CodexToolResponse> {
        if (!this.connected) await this.connect();
        if (!this.threadId) {
            throw new Error('No active session. Call startSession first.');
        }

        const resolvedInput = typeof input === 'string'
            ? [{ type: 'text' as const, text: input, text_elements: [] }]
            : input;
        return await this.runTurn(resolvedInput, options?.mode ?? {}, options?.signal);
    }

    getSessionId(): string | null {
        return this.threadId;
    }

    hasActiveSession(): boolean {
        return this.threadId !== null;
    }

    clearSession(): void {
        const previous = this.threadId;
        this.threadId = null;
        logger.debug('[CodexAppServer] Session cleared, previous threadId:', previous);
    }

    storeSessionForResume(): string | null {
        logger.debug('[CodexAppServer] Storing thread for potential resume:', this.threadId);
        return this.threadId;
    }

    async forceCloseSession(): Promise<void> {
        logger.debug('[CodexAppServer] Force closing session');
        try {
            await this.disconnect();
        } finally {
            this.clearSession();
        }
    }

    async disconnect(): Promise<void> {
        if (!this.proc) return;

        const pid = this.proc.pid ?? null;
        logger.debug(`[CodexAppServer] Disconnecting; child pid=${pid ?? 'none'}`);
        this.rl?.close();
        this.rl = null;

        try {
            this.proc.kill('SIGTERM');
        } catch {
            // ignore
        }

        if (pid) {
            setTimeout(() => {
                try {
                    process.kill(pid, 0);
                    process.kill(pid, 'SIGKILL');
                } catch {
                    // ignore
                }
            }, 2_000).unref();
        }

        this.proc = null;
        this.connected = false;
        this.rejectAll(new Error('Codex app-server disconnected'));
    }

    private async runTurn(
        input: CodexAppServerInput[],
        config: Partial<CodexSessionConfig>,
        signal?: AbortSignal
    ): Promise<CodexToolResponse> {
        if (!this.threadId) {
            throw new Error('No active Codex app-server thread');
        }

        const turnParams: Record<string, unknown> = {
            threadId: this.threadId,
            input,
            cwd: config.cwd ?? process.cwd(),
            approvalPolicy: config['approval-policy'] ?? null,
            model: config.model ?? null,
            effort: config.model_reasoning_effort ?? null,
        };
        const collaborationMode = collaborationModeParams(config);
        if (collaborationMode) {
            turnParams.collaborationMode = collaborationMode;
        }
        if (config.permissions) {
            turnParams.permissions = config.permissions;
        } else {
            const sandboxPolicy = sandboxPolicyFromMode(config.sandbox);
            if (sandboxPolicy) turnParams.sandboxPolicy = sandboxPolicy;
        }

        const turnResponse: any = await this.rpcCall('turn/start', turnParams, signal);
        const turnId = turnResponse?.turn?.id;
        if (!turnId || typeof turnId !== 'string') {
            throw new Error('Codex app-server did not return a turn id');
        }

        const completed = this.completedTurns.get(turnId);
        if (completed) {
            this.completedTurns.delete(turnId);
            return completed;
        }

        return await new Promise<CodexToolResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingTurns.delete(turnId);
                reject(new Error('Timed out waiting for Codex turn to finish'));
            }, DEFAULT_TIMEOUT);
            timer.unref();

            const abort = () => {
                this.pendingTurns.delete(turnId);
                clearTimeout(timer);
                this.interruptTurn(turnId).catch((error) => {
                    logger.debug('[CodexAppServer] Failed to interrupt turn after abort', error);
                });
                reject(asAbortError());
            };

            if (signal?.aborted) {
                abort();
                return;
            }

            if (signal) {
                signal.addEventListener('abort', abort, { once: true });
            }

            this.pendingTurns.set(turnId, {
                resolve: (value) => {
                    if (signal) signal.removeEventListener('abort', abort);
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    if (signal) signal.removeEventListener('abort', abort);
                    clearTimeout(timer);
                    reject(error);
                },
                timer,
            });
        });
    }

    private async interruptTurn(turnId: string): Promise<void> {
        if (!this.threadId || !this.connected) return;
        await this.rpcCall('turn/interrupt', { threadId: this.threadId, turnId });
    }

    private async rpcCall(method: string, params?: unknown, signal?: AbortSignal): Promise<any> {
        if (!this.proc?.stdin) {
            throw new Error('Codex app-server stdin is not available');
        }
        if (signal?.aborted) {
            throw asAbortError();
        }

        const id = this.nextId++;
        const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
        this.proc.stdin.write(`${JSON.stringify(request)}\n`);

        return await new Promise((resolve, reject) => {
            const abort = () => {
                this.pending.delete(id);
                reject(asAbortError());
            };
            if (signal) {
                signal.addEventListener('abort', abort, { once: true });
            }

            this.pending.set(id, {
                resolve: (value) => {
                    if (signal) signal.removeEventListener('abort', abort);
                    resolve(value);
                },
                reject: (error) => {
                    if (signal) signal.removeEventListener('abort', abort);
                    reject(error);
                },
            });
        });
    }

    private handleLine(line: string): void {
        let msg: any;
        try {
            msg = JSON.parse(line);
        } catch {
            logger.debug('[CodexAppServer] Ignoring non-JSON line from app-server');
            return;
        }

        if (msg && typeof msg === 'object' && 'id' in msg && ('result' in msg || 'error' in msg)) {
            this.handleResponse(msg as JsonRpcResponse);
            return;
        }

        if (msg && typeof msg === 'object' && 'id' in msg && typeof msg.method === 'string') {
            this.handleServerRequest(msg as JsonRpcRequest).catch((error) => {
                this.sendError(msg.id, error);
            });
            return;
        }

        if (msg && typeof msg === 'object' && typeof msg.method === 'string') {
            this.handleNotification(msg as JsonRpcNotification);
        }
    }

    private handleResponse(msg: JsonRpcResponse): void {
        if (msg.id === undefined) return;
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);

        if (msg.error) {
            pending.reject(new Error(msg.error.message || 'Unknown Codex app-server error'));
            return;
        }
        pending.resolve(msg.result);
    }

    private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
        logger.debug(`[CodexAppServer] Server request: ${request.method}`);
        switch (request.method) {
            case 'item/commandExecution/requestApproval': {
                const params = request.params as any;
                if (!this.permissionHandler) {
                    this.sendResult(request.id, { decision: 'decline' });
                    return;
                }
                const id = params?.approvalId || params?.itemId || String(request.id);
                const result = await this.permissionHandler.handleToolCall(
                    id,
                    'CodexBash',
                    {
                        command: params?.command,
                        cwd: params?.cwd,
                        reason: params?.reason,
                        commandActions: params?.commandActions,
                    }
                );
                this.sendResult(request.id, { decision: mapPermissionDecision(result.decision) });
                return;
            }
            case 'item/fileChange/requestApproval': {
                const params = request.params as any;
                if (!this.permissionHandler) {
                    this.sendResult(request.id, { decision: 'decline' });
                    return;
                }
                const id = params?.itemId || String(request.id);
                const result = await this.permissionHandler.handleToolCall(
                    id,
                    'CodexPatch',
                    {
                        reason: params?.reason,
                        grantRoot: params?.grantRoot,
                    }
                );
                this.sendResult(request.id, { decision: mapPermissionDecision(result.decision) });
                return;
            }
            case 'item/tool/requestUserInput': {
                const params = request.params as any;
                if (!this.permissionHandler) {
                    this.sendResult(request.id, { answers: {} });
                    return;
                }
                const id = typeof params?.itemId === 'string' && params.itemId
                    ? params.itemId
                    : String(request.id);
                const result = await this.permissionHandler.handleQuestionnaireRequest(
                    id,
                    'CodexRequestUserInput',
                    normalizeCodexQuestionnaire(params)
                );
                this.sendResult(request.id, { answers: result.answers });
                return;
            }
            case 'mcpServer/elicitation/request': {
                const params = request.params as any;
                logger.debug('[CodexAppServer] Declining MCP elicitation request:', params?.serverName, params?.message);
                this.sendResult(request.id, { action: 'decline', content: null, _meta: null });
                return;
            }
            default:
                this.sendError(request.id, new Error(`Unsupported Codex app-server request: ${request.method}`));
        }
    }

    private handleNotification(notification: JsonRpcNotification): void {
        const params: any = notification.params;
        logger.debug(`[CodexAppServer] Notification: ${notification.method}`);
        switch (notification.method) {
            case 'thread/started': {
                const threadId = params?.thread?.id;
                if (typeof threadId === 'string') {
                    this.threadId = threadId;
                }
                return;
            }
            case 'turn/started': {
                this.handler?.({
                    type: 'task_started',
                    turn_id: params?.turn?.id,
                    started_at: params?.turn?.startedAt,
                    session_id: params?.threadId,
                });
                return;
            }
            case 'turn/completed': {
                this.completeTurn(params);
                return;
            }
            case 'item/started': {
                this.handleThreadItem(params?.item, 'started');
                return;
            }
            case 'item/completed': {
                this.handleThreadItem(params?.item, 'completed');
                return;
            }
            case 'item/reasoning/textDelta':
            case 'item/reasoning/summaryTextDelta': {
                if (typeof params?.delta === 'string' && params.delta) {
                    this.handler?.({ type: 'agent_reasoning_delta', delta: params.delta });
                }
                return;
            }
            case 'turn/diff/updated': {
                const diff = params?.unifiedDiff ?? params?.unified_diff;
                if (typeof diff === 'string' && diff) {
                    this.handler?.({ type: 'turn_diff', unified_diff: diff });
                }
                return;
            }
            case 'turn/plan/updated': {
                const steps = normalizePlanSteps(params?.plan);
                const explanation = typeof params?.explanation === 'string' ? params.explanation : null;
                this.handler?.({
                    type: 'plan_update',
                    call_id: typeof params?.turnId === 'string' ? params.turnId : `plan_${Date.now()}`,
                    text: planTextFromParts(explanation, steps),
                    explanation,
                    steps,
                    status: 'updated',
                });
                return;
            }
            case 'item/plan/delta': {
                if (typeof params?.delta === 'string' && params.delta) {
                    this.handler?.({
                        type: 'plan_delta',
                        call_id: typeof params?.itemId === 'string' ? params.itemId : `plan_${Date.now()}`,
                        delta: params.delta,
                    });
                }
                return;
            }
            case 'error': {
                this.handler?.({
                    type: 'error',
                    message: params?.message || params?.error || JSON.stringify(params),
                });
                return;
            }
        }
    }

    private handleThreadItem(item: any, phase: 'started' | 'completed'): void {
        if (!item || typeof item !== 'object') return;

        if (item.type === 'agentMessage' && phase === 'completed' && typeof item.text === 'string') {
            this.handler?.({ type: 'agent_message', message: item.text });
            return;
        }

        if (item.type === 'plan' && phase === 'completed' && typeof item.text === 'string') {
            this.handler?.({
                type: 'plan_update',
                call_id: typeof item.id === 'string' ? item.id : `plan_${Date.now()}`,
                text: item.text,
                explanation: null,
                steps: [],
                status: 'complete',
            });
            return;
        }

        if (item.type === 'reasoning' && phase === 'completed') {
            const text = [
                ...(Array.isArray(item.summary) ? item.summary : []),
                ...(Array.isArray(item.content) ? item.content : []),
            ].filter((part) => typeof part === 'string' && part.length > 0).join('\n');
            if (text) {
                this.handler?.({ type: 'agent_reasoning', text });
            }
            return;
        }

        if (item.type === 'commandExecution') {
            if (phase === 'started') {
                this.handler?.({
                    type: 'exec_command_begin',
                    call_id: item.id,
                    command: item.command,
                    cwd: item.cwd,
                    source: item.source,
                });
            } else {
                this.handler?.({
                    type: 'exec_command_end',
                    call_id: item.id,
                    output: item.aggregatedOutput,
                    exit_code: item.exitCode,
                    duration_ms: item.durationMs,
                    status: item.status,
                });
            }
            return;
        }

        if (item.type === 'fileChange') {
            if (phase === 'started') {
                this.handler?.({
                    type: 'patch_apply_begin',
                    call_id: item.id,
                    auto_approved: false,
                    changes: {},
                });
            } else {
                this.handler?.({
                    type: 'patch_apply_end',
                    call_id: item.id,
                    stdout: item.status === 'completed' ? 'Files modified successfully' : '',
                    stderr: item.status === 'completed' ? '' : `Patch ${item.status}`,
                    success: item.status === 'completed',
                });
            }
        }
    }

    private completeTurn(params: any): void {
        const turn = params?.turn;
        const turnId = turn?.id;
        const status = turn?.status;
        const errorMessage = turn?.error?.message || turn?.error?.details || turn?.error?.additionalDetails;

        if (status === 'failed') {
            this.handler?.({
                type: 'error',
                message: errorMessage || 'Codex turn failed',
            });
        }

        const response: CodexToolResponse = {
            content: [],
            isError: status === 'failed',
        };

        if (typeof turnId !== 'string') {
            this.handler?.(turnLifecycleEventFromCompletion(params));
            return;
        }

        const pending = this.pendingTurns.get(turnId);
        if (!pending) {
            this.completedTurns.set(turnId, response);
            this.handler?.(turnLifecycleEventFromCompletion(params));
            return;
        }

        this.pendingTurns.delete(turnId);
        this.handler?.(turnLifecycleEventFromCompletion(params));
        pending.resolve(response);
    }

    private sendResult(id: JsonRpcId, result: unknown): void {
        if (!this.proc?.stdin) return;
        this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    }

    private sendError(id: JsonRpcId, error: unknown): void {
        if (!this.proc?.stdin) return;
        const err = asError(error);
        this.proc.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: err.message },
        })}\n`);
    }

    private rejectAll(error: Error): void {
        const detail = this.stderrBuf.trim();
        const finalError = detail && !error.message.includes(detail)
            ? new Error(`${error.message}\n\ncodex stderr:\n${detail}`)
            : error;

        for (const [, pending] of this.pending) {
            pending.reject(finalError);
        }
        this.pending.clear();

        for (const [, pendingTurn] of this.pendingTurns) {
            clearTimeout(pendingTurn.timer);
            pendingTurn.reject(finalError);
        }
        this.pendingTurns.clear();
    }
}

function normalizeCodexQuestionnaire(params: any): AgentQuestionnaire {
    const questions = Array.isArray(params?.questions) ? params.questions : [];
    return {
        provider: 'codex',
        autoResolutionMs: typeof params?.autoResolutionMs === 'number' ? params.autoResolutionMs : null,
        questions: questions.map((question: any, index: number) => {
            const id = typeof question?.id === 'string' && question.id ? question.id : `question_${index + 1}`;
            const text = typeof question?.question === 'string' && question.question
                ? question.question
                : (typeof question?.header === 'string' && question.header ? question.header : `Question ${index + 1}`);
            return {
                id,
                header: typeof question?.header === 'string' ? question.header : null,
                question: text,
                isOther: question?.isOther === true,
                isSecret: question?.isSecret === true,
                multiSelect: false,
                options: Array.isArray(question?.options)
                    ? question.options
                        .map((option: any) => ({
                            label: typeof option?.label === 'string' ? option.label : String(option ?? ''),
                            description: typeof option?.description === 'string' ? option.description : null,
                        }))
                        .filter((option: { label: string }) => option.label.length > 0)
                    : null,
            };
        }),
    };
}
