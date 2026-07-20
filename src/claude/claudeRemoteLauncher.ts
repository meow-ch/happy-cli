import { render } from "ink";
import { Session } from "./session";
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay";
import React from "react";
import { claudeRemote } from "./claudeRemote";
import { PermissionHandler } from "./utils/permissionHandler";
import { Future } from "@/utils/future";
import { SDKAssistantMessage, SDKMessage, SDKResultMessage, SDKUserMessage } from "./sdk";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter } from "./utils/sdkToLogConverter";
import { PLAN_FAKE_REJECT } from "./sdk/prompts";
import { EnhancedMode } from "./loop";
import { RawJSONLines } from "@/claude/types";
import { OutgoingMessageQueue } from "./utils/OutgoingMessageQueue";
import { getToolName } from "./utils/getToolName";
import type { ACPMessageData } from "@/api/apiSession";

interface PermissionsField {
    date: number;
    result: 'approved' | 'denied';
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowedTools?: string[];
}

function extractClaudePlanText(input: unknown): string {
    if (typeof input === 'string') return input.trim();
    if (Array.isArray(input)) {
        return input.map(extractClaudePlanText).filter(Boolean).join('\n\n').trim();
    }
    if (!input || typeof input !== 'object') return '';
    const raw = input as Record<string, unknown>;
    for (const key of ['plan', 'content', 'text', 'message', 'description']) {
        const value = raw[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    try {
        return JSON.stringify(raw, null, 2);
    } catch {
        return '';
    }
}

type ClaudeTurn = {
    id: string;
    terminalProtocol: 1;
    hookEventsVisible?: boolean;
};
type ClaudeTerminalEvent = Extract<ACPMessageData, {
    type: 'task_complete' | 'task_failed' | 'turn_aborted';
}>;

const MAX_CLAUDE_TERMINAL_RESULT_CHARS = 16_000;
const MAX_CLAUDE_TERMINAL_MESSAGE_CHARS = 3_000;
const MAX_CLAUDE_TERMINAL_CODE_CHARS = 80;
const SUCCESS_TERMINAL_REASONS = new Set(['success', 'completed', 'end_turn']);
const INCOMPLETE_ASSISTANT_STOP_REASONS = new Set(['max_tokens', 'tool_use', 'pause_turn']);
const CLAUDE_PROVIDER_AUTH_FAILURE_PATTERNS = [
    /\binvalid authentication credentials\b/i,
    /\b(?:anthropic|claude) authentication[_ -]?failed\b/i,
    /\bauthentication[_ -]?failed (?:for|with) (?:anthropic|claude)\b/i,
    /\bfailed to authenticate (?:with )?(?:anthropic|claude)\b/i,
    /\binvalid (?:anthropic api key|x-api-key)\b/i,
    /\bnot logged in to claude\b/i,
    /\bclaude(?: code)? (?:is )?not logged in\b/i,
    // Claude Code 2.1.212 emits this exact result text for a logged-out
    // `--print --output-format stream-json` invocation. Keep it anchored so
    // connector/tool prose cannot promote itself to machine-provider auth.
    /^not logged in\s*·\s*please run \/login$/i,
];
const NON_PROVIDER_AUTH_CONTEXT_PATTERNS = [
    /\bmcp\b/i,
    /\btool(?:[_ -]?(?:call|result|server|search|use))?\b/i,
    /\bplugin\b/i,
    /\bconnector\b/i,
    /\bre-?authori[sz](?:e|ation)\b/i,
];
const CLAUDE_HOOK_LIFECYCLE_SUBTYPES = new Set([
    'hook_started',
    'hook_progress',
    'hook_response',
]);
const CLAUDE_USAGE_METADATA_STRING_FIELDS = new Set([
    'service_tier',
    'inference_geo',
    'speed',
]);
const CLAUDE_USAGE_NUMERIC_CONTAINER_FIELDS = new Set([
    'server_tool_use',
    'cache_creation',
]);

function usageAttestsZeroWork(usage: unknown): boolean {
    if (usage === undefined) return true;
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;

    for (const [key, value] of Object.entries(usage)) {
        if (typeof value === 'number') {
            if (!Number.isFinite(value) || value !== 0) return false;
            continue;
        }
        if (CLAUDE_USAGE_METADATA_STRING_FIELDS.has(key)) {
            if (typeof value !== 'string') return false;
            continue;
        }
        if (key === 'iterations') {
            if (!Array.isArray(value) || value.length !== 0) return false;
            continue;
        }
        if (CLAUDE_USAGE_NUMERIC_CONTAINER_FIELDS.has(key)) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
            if (!Object.values(value).every(
                (nestedValue) => typeof nestedValue === 'number'
                    && Number.isFinite(nestedValue)
                    && nestedValue === 0,
            )) return false;
            continue;
        }
        // Unknown non-numeric fields cannot safely attest that no provider or
        // server-tool work occurred.
        return false;
    }
    return true;
}

function isClaudeTurnHookLifecycleMessage(message: SDKMessage): boolean {
    if (message.type !== 'system'
        || typeof message.subtype !== 'string'
        || !CLAUDE_HOOK_LIFECYCLE_SUBTYPES.has(message.subtype)) {
        return false;
    }

    // Claude emits SessionStart while establishing the process/session, before
    // it submits the prompt. It is intentionally excluded. Every other hook
    // lifecycle event is conservative evidence that local turn work began;
    // missing/malformed hook_event fields therefore also fail closed.
    return message.hook_event !== 'SessionStart';
}

function redactClaudeTerminalCredentials(value: string): string {
    return value
        .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{10,}\b/g, 'sk-REDACTED')
        .replace(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi, 'Bearer REDACTED')
        .replace(
            /(["']?(?:api[_-]?key|auth[_-]?token|access[_-]?token|oauth[_-]?token)["']?\s*[:=]\s*["']?)[^\s,"'}]{8,}/gi,
            '$1REDACTED',
        );
}

function hasConvincingZeroWorkEvidence(
    result: SDKResultMessage,
    toolWorkObserved: boolean,
    hookWorkObserved: boolean,
    hookEventsVisible: boolean,
): boolean {
    if (toolWorkObserved || hookWorkObserved || !hookEventsVisible) return false;
    const modelUsage = result.modelUsage;
    return result.duration_api_ms === 0
        && result.total_cost_usd === 0
        && usageAttestsZeroWork(result.usage)
        && !!modelUsage
        && typeof modelUsage === 'object'
        && !Array.isArray(modelUsage)
        && Object.keys(modelUsage).length === 0;
}

function isClaudeAuthenticationFailure(
    result: SDKResultMessage,
    convincingZeroWork: boolean,
): boolean {
    // These fields are emitted by the Claude runtime itself and therefore do
    // not depend on interpreting free-form assistant/tool output.
    if (result.api_error_status === 401) return true;
    if (result.error === 'authentication_failed') return true;

    // Compatibility fallback for older Claude versions that omitted the
    // structured status. Fail closed: it must be an API terminal with proof
    // that no provider/tool work ran, and tool/connector auth errors are never
    // promoted to machine-level Claude authentication failures.
    if (result.terminal_reason !== 'api_error' || !convincingZeroWork) return false;
    const diagnostic = [result.error, result.result]
        .filter((value): value is string => typeof value === 'string')
        .join('\n');
    if (!diagnostic) return false;
    if (NON_PROVIDER_AUTH_CONTEXT_PATTERNS.some((pattern) => pattern.test(diagnostic))) {
        return false;
    }
    return CLAUDE_PROVIDER_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(diagnostic));
}

function boundedTerminalText(value: unknown, maxChars: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .trim();
    if (!normalized) return undefined;
    return normalized.length > maxChars
        ? `${normalized.slice(0, maxChars)}\n…(truncated)`
        : normalized;
}

function boundedTerminalCode(value: unknown): string | undefined {
    const text = boundedTerminalText(value, MAX_CLAUDE_TERMINAL_CODE_CHARS);
    if (!text) return undefined;
    const safe = text.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
    return safe || undefined;
}

function nextTopLevelAssistantStopReason(
    current: string | null,
    message: SDKAssistantMessage,
): string | null {
    if (message.parent_tool_use_id != null) return current;
    if (!Object.prototype.hasOwnProperty.call(message.message, 'stop_reason')) return current;
    return typeof message.message.stop_reason === 'string' && message.message.stop_reason.trim()
        ? message.message.stop_reason
        : null;
}

function normalizeClaudeResultTerminal(input: {
    result: SDKResultMessage;
    turnId: string;
    terminalProtocol: 1;
    assistantStopReason?: string | null;
    pendingToolCallCount?: number;
    toolWorkObserved?: boolean;
    hookWorkObserved?: boolean;
    hookEventsVisible?: boolean;
}): ClaudeTerminalEvent {
    const subtype = boundedTerminalCode(input.result.subtype) ?? 'unknown';
    const providerReason = boundedTerminalCode(input.result.terminal_reason);
    // The final SDK result is authoritative. Streamed assistant messages can
    // carry null even when the provider ultimately stops at max_tokens, so the
    // top-level assistant value is only a compatibility fallback.
    const stopReason = boundedTerminalCode(input.result.stop_reason)
        ?? boundedTerminalCode(input.assistantStopReason);
    const providerReasonFailed = !!providerReason && !SUCCESS_TERMINAL_REASONS.has(providerReason);
    const stoppedIncomplete = !!stopReason && INCOMPLETE_ASSISTANT_STOP_REASONS.has(stopReason);
    const failed = input.result.is_error !== false
        || subtype !== 'success'
        || providerReasonFailed
        || stoppedIncomplete
        || (input.pendingToolCallCount ?? 0) > 0;
    const rawResultText = input.result.result ?? input.result.error;
    const resultText = boundedTerminalText(
        typeof rawResultText === 'string'
            ? redactClaudeTerminalCredentials(rawResultText)
            : rawResultText,
        MAX_CLAUDE_TERMINAL_RESULT_CHARS,
    );

    if (!failed) {
        return {
            type: 'task_complete',
            id: input.turnId,
            terminal_protocol: input.terminalProtocol,
            subtype,
            reason: providerReason ?? stopReason ?? 'completed',
            is_error: false,
            ...(resultText ? { result: resultText } : {}),
        };
    }

    const convincingZeroWork = hasConvincingZeroWorkEvidence(
        input.result,
        input.toolWorkObserved === true || (input.pendingToolCallCount ?? 0) > 0,
        input.hookWorkObserved === true,
        input.hookEventsVisible === true,
    );
    const authenticationFailure = isClaudeAuthenticationFailure(
        input.result,
        convincingZeroWork,
    );
    const immediateAuthenticationRejection = authenticationFailure && convincingZeroWork;
    const reason = authenticationFailure
        ? 'authentication_required'
        : providerReasonFailed
            ? providerReason
            : stoppedIncomplete
                ? stopReason
                : subtype !== 'success'
                    ? subtype
                    : (input.pendingToolCallCount ?? 0) > 0
                        ? 'pending_tool_calls'
                        : input.result.is_error === true
                            ? 'claude_result_error'
                            : 'invalid_is_error';
    const failureMessage = reason === 'authentication_required'
        ? 'Claude authentication is required on this machine. Run "claude auth login" locally, then retry this turn.'
        : reason === 'max_tokens'
        ? 'Claude reached its output token limit before completing the turn.'
        : reason === 'pending_tool_calls'
            ? 'Claude ended while one or more tool calls were still unresolved.'
            : reason === 'api_error'
                ? 'Claude reported an API error before completing the turn.'
                : reason === 'error_max_turns'
                    ? 'Claude exceeded its maximum turn limit before completing the task.'
                    : reason === 'error_during_execution'
                        ? 'Claude failed during execution before completing the turn.'
                        : reason === 'tool_use' || reason === 'pause_turn'
                            ? `Claude ended with an incomplete ${reason} stop condition.`
                            : reason === 'invalid_is_error'
                                ? 'Claude result did not explicitly attest is_error=false; the turn was treated as failed.'
                                : `Claude turn failed before completion (reason: ${reason}).`;
    return {
        type: 'task_failed',
        id: input.turnId,
        terminal_protocol: input.terminalProtocol,
        subtype,
        reason,
        is_error: true,
        code: reason,
        // Keep partial provider output in result. The failure message remains
        // causal and stable so recovery/UI cannot mistake partial prose for
        // the reason the turn failed.
        message: failureMessage,
        ...(authenticationFailure
            ? {
                retryable: immediateAuthenticationRejection,
                prompt_executed: !immediateAuthenticationRejection,
            }
            : {}),
        // Authentication payloads are intentionally omitted in full. Regex
        // redaction is useful for ordinary diagnostics, but cannot prove that
        // an arbitrary provider payload contains no credential material.
        ...(!authenticationFailure && resultText ? { result: resultText } : {}),
    };
}

function normalizeClaudeExitTerminal(input: {
    turn: ClaudeTurn;
    kind: 'aborted' | 'failed';
    reason: string;
    message?: string;
}): ClaudeTerminalEvent {
    const reason = boundedTerminalCode(input.reason)
        ?? (input.kind === 'aborted' ? 'user_abort' : 'unexpected_provider_exit');
    if (input.kind === 'aborted') {
        return {
            type: 'turn_aborted',
            id: input.turn.id,
            terminal_protocol: input.turn.terminalProtocol,
            subtype: 'aborted',
            reason,
            is_error: true,
        };
    }

    const fallbackMessage = 'Claude exited before reporting a provider result.';
    return {
        type: 'task_failed',
        id: input.turn.id,
        terminal_protocol: input.turn.terminalProtocol,
        subtype: 'error',
        reason,
        is_error: true,
        code: reason,
        message: boundedTerminalText(input.message, MAX_CLAUDE_TERMINAL_MESSAGE_CHARS)
            ?? fallbackMessage,
    };
}

async function emitClaudeTerminalAfterToolCleanup<T>(input: {
    pendingToolCalls: T[];
    interruptedResult: (pendingToolCall: T) => RawJSONLines;
    enqueueInterruptedResult: (result: RawJSONLines) => void;
    flushQueuedOutput: () => Promise<void>;
    emitTerminal: () => void;
    emitLegacyReady?: () => void;
}): Promise<void> {
    for (const pendingToolCall of input.pendingToolCalls) {
        input.enqueueInterruptedResult(input.interruptedResult(pendingToolCall));
    }
    await input.flushQueuedOutput();
    input.emitTerminal();
    input.emitLegacyReady?.();
}

export const __testClaudeRemoteLauncherInternals = {
    extractClaudePlanText,
    nextTopLevelAssistantStopReason,
    normalizeClaudeResultTerminal,
    normalizeClaudeExitTerminal,
    emitClaudeTerminalAfterToolCleanup,
    isClaudeAuthenticationFailure,
    hasConvincingZeroWorkEvidence,
    redactClaudeTerminalCredentials,
    isClaudeTurnHookLifecycleMessage,
    usageAttestsZeroWork,
};

function formatUnexpectedClaudeExit(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error ?? '');
    const normalized = detail.toLowerCase();
    const clipped = detail.length > 3000 ? `${detail.slice(0, 3000)}\n…(truncated)` : detail;

    if (normalized.includes('failed to spawn claude code process')) {
        return 'Claude process quit unexpectedly. Check that Claude CLI is installed and available in PATH.';
    }
    if (normalized.includes('claude code is not installed') || normalized.includes('please install claude code')) {
        return `Claude Code is not installed on this machine.\n\n${clipped}`;
    }
    if (normalized.includes('exited with code')) {
        // Prefer showing stderr detail if we captured it (helps with install/login debugging).
        if (normalized.includes('stderr:')) {
            return `Claude process quit unexpectedly:\n\n${clipped}`;
        }
        return 'Claude process quit unexpectedly. Check Claude installation and authentication on this machine (try running "claude" once), then retry.';
    }
    if (detail && detail !== '[object Object]') {
        return `Claude process quit unexpectedly: ${clipped}`;
    }
    return 'Claude process quit unexpectedly. Check Claude CLI installation and authentication, then retry.';
}

export async function claudeRemoteLauncher(session: Session): Promise<'switch' | 'exit'> {
    logger.debug('[claudeRemoteLauncher] Starting remote launcher');

    // Check if we have a TTY for UI rendering
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    logger.debug(`[claudeRemoteLauncher] TTY available: ${hasTTY}`);

    // Configure terminal
    let messageBuffer = new MessageBuffer();
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(RemoteModeDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? session.logPath : undefined,
            onExit: async () => {
                // Exit the entire client
                logger.debug('[remote]: Exiting client via Ctrl-C');
                if (!exitReason) {
                    exitReason = 'exit';
                }
                await abort();
            },
            onSwitchToLocal: () => {
                // Switch to local mode
                logger.debug('[remote]: Switching to local mode via double space');
                doSwitch();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    // Handle abort
    let exitReason: 'switch' | 'exit' | null = null;
    let abortController: AbortController | null = null;
    let abortFuture: Future<void> | null = null;

    async function abort() {
        if (abortController && !abortController.signal.aborted) {
            abortController.abort();
        }
        await abortFuture?.promise;
    }

    async function doAbort() {
        logger.debug('[remote]: doAbort');
        await abort();
    }

    async function doSwitch() {
        logger.debug('[remote]: doSwitch');
        if (!exitReason) {
            exitReason = 'switch';
        }
        await abort();
    }

    // When to abort
    session.client.rpcHandlerManager.registerHandler('abort', doAbort); // When abort clicked
    session.client.rpcHandlerManager.registerHandler('switch', doSwitch); // When switch clicked
    // Removed catch-all stdin handler - now handled by RemoteModeDisplay keyboard handlers

    // Create permission handler
    const permissionHandler = new PermissionHandler(session);

    // Create outgoing message queue
    const messageQueue = new OutgoingMessageQueue(
        (logMessage) => session.client.sendClaudeSessionMessage(logMessage)
    );

    // Set up callback to release delayed messages when permission is requested
    permissionHandler.setOnPermissionRequest((toolCallId: string) => {
        messageQueue.releaseToolCall(toolCallId);
    });

    // Create SDK to Log converter (pass responses from permissions)
    const sdkToLogConverter = new SDKToLogConverter({
        sessionId: session.sessionId || 'unknown',
        cwd: session.path,
        version: process.env.npm_package_version
    }, permissionHandler.getResponses());


    // Handle messages
    let planModeToolCalls = new Set<string>();
    let emittedPlanToolCalls = new Set<string>();
    let ongoingToolCalls = new Map<string, { parentToolCallId: string | null }>();
    let lastAssistantStopReason: string | null = null;
    let activeTurnToolWorkObserved = false;
    let activeTurnHookWorkObserved = false;
    let activeClaudeTurn: ClaudeTurn | null = null;
    let fallbackTerminal: ClaudeTerminalEvent | null = null;

    function onMessage(message: SDKMessage) {

        if (activeClaudeTurn && isClaudeTurnHookLifecycleMessage(message)) {
            activeTurnHookWorkObserved = true;
        }

        // Write to message log
        formatClaudeMessageForInk(message, messageBuffer);

        // Write to permission handler for tool id resolving
        permissionHandler.onMessage(message);

        // Detect plan mode tool call
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            lastAssistantStopReason = nextTopLevelAssistantStopReason(lastAssistantStopReason, umessage);
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use' && (c.name === 'exit_plan_mode' || c.name === 'ExitPlanMode')) {
                        logger.debug('[remote]: detected plan mode tool call ' + c.id!);
                        planModeToolCalls.add(c.id! as string);
                        if (c.id && !emittedPlanToolCalls.has(c.id as string)) {
                            const text = extractClaudePlanText(c.input);
                            if (text) {
                                emittedPlanToolCalls.add(c.id as string);
                                session.client.sendAgentMessage('claude', {
                                    type: 'plan',
                                    id: c.id as string,
                                    text,
                                    explanation: null,
                                    steps: [],
                                    status: 'complete',
                                });
                            }
                        }
                    }
                }
            }
        }

        // Track active tool calls
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use') {
                        activeTurnToolWorkObserved = true;
                        logger.debug('[remote]: detected tool use ' + c.id! + ' parent: ' + umessage.parent_tool_use_id);
                        ongoingToolCalls.set(c.id!, { parentToolCallId: umessage.parent_tool_use_id ?? null });
                    }
                }
            }
        }
        if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        ongoingToolCalls.delete(c.tool_use_id);

                        // When tool result received, release any delayed messages for this tool call
                        messageQueue.releaseToolCall(c.tool_use_id);
                    }
                }
            }
        }

        // Convert SDK message to log format and send to client
        let msg = message;

        // Hack plan mode exit
        if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                msg = {
                    ...umessage,
                    message: {
                        ...umessage.message,
                        content: umessage.message.content.map((c) => {
                            if (c.type === 'tool_result' && c.tool_use_id && planModeToolCalls.has(c.tool_use_id!)) {
                                if (c.content === PLAN_FAKE_REJECT) {
                                    logger.debug('[remote]: hack plan mode exit');
                                    logger.debugLargeJson('[remote]: hack plan mode exit', c);
                                    return {
                                        ...c,
                                        is_error: false,
                                        content: 'Plan approved',
                                        mode: c.mode
                                    }
                                } else {
                                    return c;
                                }
                            }
                            return c;
                        })
                    }
                }
            }
        }

        const logMessage = sdkToLogConverter.convert(msg);
        if (logMessage) {
            // Add permissions field to tool result content
            if (logMessage.type === 'user' && logMessage.message?.content) {
                const content = Array.isArray(logMessage.message.content)
                    ? logMessage.message.content
                    : [];

                // Modify the content array to add permissions to each tool_result
                for (let i = 0; i < content.length; i++) {
                    const c = content[i];
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        const responses = permissionHandler.getResponses();
                        const response = responses.get(c.tool_use_id);

                        if (response) {
                            const permissions: PermissionsField = {
                                date: response.receivedAt || Date.now(),
                                result: response.approved ? 'approved' : 'denied'
                            };

                            // Add optional fields if they exist
                            if (response.mode) {
                                permissions.mode = response.mode;
                            }

                            if (response.allowTools && response.allowTools.length > 0) {
                                permissions.allowedTools = response.allowTools;
                            }

                            // Add permissions directly to the tool_result content object
                            content[i] = {
                                ...c,
                                permissions
                            };
                        }
                    }
                }
            }

            // Queue message with optional delay for tool calls
            if (logMessage.type === 'assistant' && message.type === 'assistant') {
                const assistantMsg = message as SDKAssistantMessage;
                const toolCallIds: string[] = [];

                if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                    for (const block of assistantMsg.message.content) {
                        if (block.type === 'tool_use' && block.id) {
                            toolCallIds.push(block.id);
                        }
                    }
                }

                if (toolCallIds.length > 0) {
                    // Check if this is a sidechain tool call (has parent_tool_use_id)
                    const isSidechain = assistantMsg.parent_tool_use_id !== undefined;

                    if (!isSidechain) {
                        // Top-level tool call - queue with delay
                        messageQueue.enqueue(logMessage, {
                            delay: 250,
                            toolCallIds
                        });
                        return; // Don't queue again below
                    }
                }
            }

            // Queue all other messages immediately (no delay)
            messageQueue.enqueue(logMessage);
        }

        // Insert a fake message to start the sidechain
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use' && c.name === 'Task' && c.input && typeof (c.input as any).prompt === 'string') {
                        const logMessage2 = sdkToLogConverter.convertSidechainUserMessage(c.id!, (c.input as any).prompt);
                        if (logMessage2) {
                            messageQueue.enqueue(logMessage2);
                        }
                    }
                }
            }
        }
    }

    try {
        let pending: {
            message: string;
            mode: EnhancedMode;
        } | null = null;

        // Track session ID to detect when it actually changes
        // This prevents context loss when mode changes (permission mode, model, etc.)
        // without starting a new session. Only reset parent chain when session ID
        // actually changes (e.g., new session started or /clear command used).
        // See: https://github.com/anthropics/happy-cli/issues/143
        let previousSessionId: string | null = null;
        while (!exitReason) {
            logger.debug('[remote]: launch');
            messageBuffer.addMessage('═'.repeat(40), 'status');

            // Only reset parent chain and show "new session" message when session ID actually changes
            const isNewSession = session.sessionId !== previousSessionId;
            if (isNewSession) {
                messageBuffer.addMessage('Starting new Claude session...', 'status');
                permissionHandler.reset(); // Reset permissions before starting new session
                sdkToLogConverter.resetParentChain(); // Reset parent chain for new conversation
                logger.debug(`[remote]: New session detected (previous: ${previousSessionId}, current: ${session.sessionId})`);
            } else {
                messageBuffer.addMessage('Continuing Claude session...', 'status');
                logger.debug(`[remote]: Continuing existing session: ${session.sessionId}`);
            }

            previousSessionId = session.sessionId;
            const controller = new AbortController();
            abortController = controller;
            abortFuture = new Future<void>();
            let modeHash: string | null = null;
            let mode: EnhancedMode | null = null;
            try {
                await claudeRemote({
                    sessionId: session.sessionId,
                    path: session.path,
                    allowedTools: session.allowedTools ?? [],
                    mcpServers: session.mcpServers,
                    hookSettingsPath: session.hookSettingsPath,
                    jsRuntime: session.jsRuntime,
                    canCallTool: permissionHandler.handleToolCall,
                    isAborted: (toolCallId: string) => {
                        return permissionHandler.isAborted(toolCallId);
                    },
                    nextMessage: async () => {
                        if (pending) {
                            let p = pending;
                            pending = null;
                            permissionHandler.handleModeChange(p.mode.permissionMode);
                            return p;
                        }

                        let msg = await session.queue.waitForMessagesAndGetAsString(controller.signal);

                        // Check if mode has changed
                        if (msg) {
                            if ((modeHash && msg.hash !== modeHash) || msg.isolate) {
                                logger.debug('[remote]: mode has changed, pending message');
                                pending = msg;
                                return null;
                            }
                            modeHash = msg.hash;
                            mode = msg.mode;
                            permissionHandler.handleModeChange(mode.permissionMode);
                            return {
                                message: msg.message,
                                mode: msg.mode
                            }
                        }

                        // Exit
                        return null;
                    },
                    onSessionFound: (sessionId) => {
                        // Update converter's session ID when new session is found
                        sdkToLogConverter.updateSessionId(sessionId);
                        session.onSessionFound(sessionId);
                    },
                    onThinkingChange: session.onThinkingChange,
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    onMessage,
                    onCompletionEvent: (message: string) => {
                        logger.debug(`[remote]: Completion event: ${message}`);
                        session.client.sendSessionEvent({ type: 'message', message });
                    },
                    onSessionReset: () => {
                        logger.debug('[remote]: Session reset');
                        session.clearSessionId();
                    },
                    onTurnStarted: (turn) => {
                        fallbackTerminal = null;
                        lastAssistantStopReason = null;
                        activeTurnToolWorkObserved = false;
                        activeTurnHookWorkObserved = false;
                        if (turn.terminalProtocol !== 1) {
                            activeClaudeTurn = null;
                            return;
                        }
                        activeClaudeTurn = {
                            id: turn.id,
                            terminalProtocol: 1,
                            hookEventsVisible: turn.hookEventsVisible === true,
                        };
                        session.client.sendAgentMessage('claude', {
                            type: 'task_started',
                            id: turn.id,
                            terminal_protocol: turn.terminalProtocol,
                        });
                    },
                    onResult: async (result, turn) => {
                        if (turn.terminalProtocol !== 1) {
                            lastAssistantStopReason = null;
                            // Prompts which did not opt into authoritative
                            // terminals retain the historical Happy contract.
                            if (!pending && session.queue.size() === 0) {
                                session.client.sendSessionEvent({ type: 'ready' });
                                session.api.push().sendToAllDevices(
                                    'It\'s ready!',
                                    'Claude is waiting for your command',
                                    { sessionId: session.client.sessionId },
                                );
                            }
                            return;
                        }
                        const pendingToolCalls = Array.from(ongoingToolCalls.entries());
                        ongoingToolCalls.clear();
                        const terminal = normalizeClaudeResultTerminal({
                            result,
                            turnId: turn.id,
                            terminalProtocol: turn.terminalProtocol,
                            assistantStopReason: lastAssistantStopReason,
                            pendingToolCallCount: pendingToolCalls.length,
                            toolWorkObserved: activeTurnToolWorkObserved,
                            hookWorkObserved: activeTurnHookWorkObserved,
                            hookEventsVisible: turn.hookEventsVisible === true,
                        });
                        lastAssistantStopReason = null;
                        activeTurnToolWorkObserved = false;
                        activeTurnHookWorkObserved = false;

                        const isIdle = !pending && session.queue.size() === 0;
                        await emitClaudeTerminalAfterToolCleanup({
                            pendingToolCalls,
                            interruptedResult: ([toolCallId, { parentToolCallId }]) => (
                                sdkToLogConverter.generateInterruptedToolResult(
                                    toolCallId,
                                    parentToolCallId,
                                    terminal.reason,
                                )
                            ),
                            enqueueInterruptedResult: (interruptedResult) => {
                                messageQueue.enqueue(interruptedResult);
                            },
                            flushQueuedOutput: () => messageQueue.flush(),
                            emitTerminal: () => {
                                session.client.sendAgentMessage('claude', terminal);
                                activeClaudeTurn = null;
                                fallbackTerminal = null;
                            },
                            emitLegacyReady: isIdle
                                ? () => {
                                    session.client.sendSessionEvent({ type: 'ready' });
                                    if (terminal.type === 'task_complete') {
                                        session.api.push().sendToAllDevices(
                                            'It\'s ready!',
                                            'Claude is waiting for your command',
                                            { sessionId: session.client.sessionId },
                                        );
                                    }
                                }
                                : undefined,
                        });
                    },
                    signal: abortController.signal,
                });
                
                // Consume one-time Claude flags after spawn
                session.consumeOneTimeFlags();

                if (activeClaudeTurn && !fallbackTerminal) {
                    fallbackTerminal = controller.signal.aborted
                        ? normalizeClaudeExitTerminal({
                            turn: activeClaudeTurn,
                            kind: 'aborted',
                            reason: exitReason ? `user_${exitReason}` : 'user_abort',
                        })
                        : normalizeClaudeExitTerminal({
                            turn: activeClaudeTurn,
                            kind: 'failed',
                            reason: 'unexpected_provider_exit',
                        });
                }
                
                if (!exitReason && abortController.signal.aborted) {
                    session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                }
            } catch (e) {
                logger.debug('[remote]: launch error', e);
                if (activeClaudeTurn && !fallbackTerminal) {
                    fallbackTerminal = controller.signal.aborted
                        ? normalizeClaudeExitTerminal({
                            turn: activeClaudeTurn,
                            kind: 'aborted',
                            reason: exitReason ? `user_${exitReason}` : 'user_abort',
                        })
                        : normalizeClaudeExitTerminal({
                            turn: activeClaudeTurn,
                            kind: 'failed',
                            reason: 'claude_runtime_error',
                            message: formatUnexpectedClaudeExit(e),
                        });
                }
                if (!exitReason) {
                    session.client.sendSessionEvent({ type: 'message', message: formatUnexpectedClaudeExit(e) });
                    continue;
                }
            } finally {

                logger.debug('[remote]: launch finally');

                const pendingToolCalls = Array.from(ongoingToolCalls.entries());
                ongoingToolCalls.clear();

                // A started v1 turn must always end with an explicit terminal,
                // including aborts and provider exits that produce no SDK
                // result. The durable message outbox preserves this ordering
                // after the synthetic tool results flushed above.
                if (activeClaudeTurn) {
                    const terminal = fallbackTerminal ?? normalizeClaudeExitTerminal({
                        turn: activeClaudeTurn,
                        kind: controller.signal.aborted ? 'aborted' : 'failed',
                        reason: controller.signal.aborted ? 'user_abort' : 'unexpected_provider_exit',
                    });
                    await emitClaudeTerminalAfterToolCleanup({
                        pendingToolCalls,
                        interruptedResult: ([toolCallId, { parentToolCallId }]) => (
                            sdkToLogConverter.generateInterruptedToolResult(
                                toolCallId,
                                parentToolCallId,
                                terminal.reason,
                            )
                        ),
                        enqueueInterruptedResult: (interruptedResult) => {
                            logger.debug('[remote]: terminating unresolved tool call before terminal');
                            messageQueue.enqueue(interruptedResult);
                        },
                        flushQueuedOutput: () => messageQueue.flush(),
                        emitTerminal: () => {
                            session.client.sendAgentMessage('claude', terminal);
                            activeClaudeTurn = null;
                            fallbackTerminal = null;
                            lastAssistantStopReason = null;
                        },
                        // Preserve legacy ready strictly as an idle/UI hint,
                        // and only after the authoritative ACP terminal. Agent
                        // Plane protocol v1 ignores this hint for turn outcome.
                        emitLegacyReady: !exitReason && !pending && session.queue.size() === 0
                            ? () => session.client.sendSessionEvent({ type: 'ready' })
                            : undefined,
                    });
                } else {
                    for (const [toolCallId, { parentToolCallId }] of pendingToolCalls) {
                        logger.debug('[remote]: terminating orphaned tool call ' + toolCallId);
                        messageQueue.enqueue(sdkToLogConverter.generateInterruptedToolResult(
                            toolCallId,
                            parentToolCallId,
                            'launcher_exit',
                        ));
                    }
                    await messageQueue.flush();
                }
                messageQueue.destroy();
                logger.debug('[remote]: message queue flushed');

                // Reset abort controller and future
                abortController = null;
                abortFuture?.resolve(undefined);
                abortFuture = null;
                logger.debug('[remote]: launch done');
                permissionHandler.reset();
                modeHash = null;
                mode = null;
            }
        }
    } finally {

        // Clean up permission handler
        permissionHandler.reset();

        // Reset Terminal
        process.stdin.off('data', abort);
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
        if (inkInstance) {
            inkInstance.unmount();
        }
        messageBuffer.clear();

        // Resolve abort future
        if (abortFuture) { // Just in case of error
            abortFuture.resolve(undefined);
        }
    }

    return exitReason || 'exit';
}
