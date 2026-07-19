import { EnhancedMode, ImageContent } from "./loop";
import { query, type QueryOptions, type SDKMessage, type SDKResultMessage, type SDKSystemMessage, AbortError, SDKUserMessage } from '@/claude/sdk'
import { mapToClaudeMode } from "./utils/permissionMode";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { join, resolve } from 'node:path';
import { projectPath } from "@/projectPath";
import { parseSpecialCommand } from "@/parsers/specialCommands";
import { logger } from "@/lib";
import { PushableAsyncIterable } from "@/utils/PushableAsyncIterable";
import { getProjectPath } from "./utils/path";
import { awaitFileExist } from "@/modules/watcher/awaitFileExist";
import { systemPrompt } from "./utils/systemPrompt";
import { PermissionResult } from "./sdk/types";
import type { JsRuntime } from "./runClaude";
import { randomUUID } from 'node:crypto';

type ClaudeRemoteTurn = { id: string; terminalProtocol?: 1 };

function createClaudeTurn(mode: EnhancedMode): ClaudeRemoteTurn {
    return {
        // Canonical inbox delivery injects SessionMessage.localId here. The
        // random fallback is only for legacy rows which have no durable id.
        id: mode.promptLocalId || randomUUID(),
        ...(mode.terminalProtocol === 1 ? { terminalProtocol: 1 as const } : {}),
    };
}

function createLocalClaudeSuccessResult(sessionId: string | null, result: string): SDKResultMessage {
    return {
        type: 'result',
        subtype: 'success',
        result,
        num_turns: 0,
        total_cost_usd: 0,
        duration_ms: 0,
        duration_api_ms: 0,
        is_error: false,
        session_id: sessionId ?? 'local-command',
        terminal_reason: 'completed',
    };
}

export const __testClaudeRemoteInternals = {
    createClaudeTurn,
    createLocalClaudeSuccessResult,
};

/**
 * Build message content for Claude SDK - either string or multipart array with images
 */
function buildMessageContent(text: string, images?: ImageContent[]): string | Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> {
    logger.debug(`[claudeRemote] 🖼️ buildMessageContent called - text length: ${text.length}, images: ${images?.length || 0}`);

    if (!images || images.length === 0) {
        logger.debug(`[claudeRemote] 🖼️ No images, returning text-only`);
        return text;
    }

    logger.debug(`[claudeRemote] 🖼️ Building MULTIPART content with ${images.length} images`);

    // Build multipart content array - images first, then text (Claude's recommended order)
    const content: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> = [];

    // Add images
    for (const img of images) {
        logger.debug(`[claudeRemote] 🖼️ Adding image: ${img.media_type}, base64 length: ${img.data.length}`);
        content.push({
            type: 'image',
            source: {
                type: 'base64',
                media_type: img.media_type,
                data: img.data
            }
        });
    }

    // Add text - if no text provided, use a default prompt for image-only messages
    const messageText = text.trim() || 'What do you see in this image?';
    logger.debug(`[claudeRemote] 🖼️ Adding text: "${messageText.substring(0, 50)}..."`);
    content.push({
        type: 'text',
        text: messageText
    });

    logger.debug(`[claudeRemote] 🖼️ Built content array with ${content.length} parts`);
    return content;
}

export async function claudeRemote(opts: {

    // Fixed parameters
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[],
    allowedTools: string[],
    signal?: AbortSignal,
    canCallTool: (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal }) => Promise<PermissionResult>,
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    hookSettingsPath: string,
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime,

    // Dynamic parameters
    nextMessage: () => Promise<{ message: string, mode: EnhancedMode } | null>,
    onTurnStarted: (turn: ClaudeRemoteTurn) => void | Promise<void>,
    onResult: (
        result: SDKResultMessage,
        turn: ClaudeRemoteTurn,
    ) => void | Promise<void>,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    onCompletionEvent?: (message: string) => void,
    onSessionReset?: () => void
}) {

    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }
    
    // Extract --resume from claudeArgs if present (for first spawn)
    if (!startFrom && opts.claudeArgs) {
        for (let i = 0; i < opts.claudeArgs.length; i++) {
            if (opts.claudeArgs[i] === '--resume') {
                // Check if next arg exists and looks like a session ID
                if (i + 1 < opts.claudeArgs.length) {
                    const nextArg = opts.claudeArgs[i + 1];
                    // If next arg doesn't start with dash and contains dashes, it's likely a UUID
                    if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                        startFrom = nextArg;
                        logger.debug(`[claudeRemote] Found --resume with session ID: ${startFrom}`);
                        break;
                    } else {
                        // Just --resume without UUID - SDK doesn't support this
                        logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                        break;
                    }
                } else {
                    // --resume at end of args - SDK doesn't support this
                    logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                    break;
                }
            }
        }
    }

    // Set environment variables for Claude Code SDK
    if (opts.claudeEnvVars) {
        Object.entries(opts.claudeEnvVars).forEach(([key, value]) => {
            process.env[key] = value;
        });
    }

    // Get initial message
    const initial = await opts.nextMessage();
    if (!initial) { // No initial message - exit
        return;
    }
    let activeTurn = createClaudeTurn(initial.mode);

    // Handle special commands
    const specialCommand = parseSpecialCommand(initial.message);

    // Every accepted protocol-v1 prompt receives a correlated start and one
    // explicit terminal, including commands completed locally without an SDK
    // query.
    await opts.onTurnStarted(activeTurn);

    // Handle /clear command
    if (specialCommand.type === 'clear') {
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Context was reset');
        }
        if (opts.onSessionReset) {
            opts.onSessionReset();
        }
        await opts.onResult(
            createLocalClaudeSuccessResult(opts.sessionId, 'Context was reset.'),
            activeTurn,
        );
        return;
    }

    // Handle /compact command
    let isCompactCommand = false;
    if (specialCommand.type === 'compact') {
        logger.debug('[claudeRemote] /compact command detected - will process as normal but with compaction behavior');
        isCompactCommand = true;
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Compaction started');
        }
    }

    // Prepare SDK options
    let mode = initial.mode;
    const sdkOptions: QueryOptions = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        mcpServers: opts.mcpServers,
        permissionMode: mapToClaudeMode(initial.mode.permissionMode),
        model: initial.mode.model,
        fallbackModel: initial.mode.fallbackModel,
        customSystemPrompt: initial.mode.customSystemPrompt ? initial.mode.customSystemPrompt + '\n\n' + systemPrompt : undefined,
        appendSystemPrompt: initial.mode.appendSystemPrompt ? initial.mode.appendSystemPrompt + '\n\n' + systemPrompt : systemPrompt,
        allowedTools: initial.mode.allowedTools ? initial.mode.allowedTools.concat(opts.allowedTools) : opts.allowedTools,
        disallowedTools: initial.mode.disallowedTools,
        canCallTool: (toolName: string, input: unknown, options: { signal: AbortSignal }) => opts.canCallTool(toolName, input, mode, options),
        executable: opts.jsRuntime ?? 'node',
        abort: opts.signal,
        pathToClaudeCodeExecutable: (() => {
            return resolve(join(projectPath(), 'scripts', 'claude_remote_launcher.cjs'));
        })(),
        settingsPath: opts.hookSettingsPath,
    }

    // Track thinking state
    let thinking = false;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[claudeRemote] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    // Push initial message
    let messages = new PushableAsyncIterable<SDKUserMessage>();
    const initialContent = buildMessageContent(initial.message, mode.images);
    logger.debug(`[claudeRemote] Initial message content type: ${typeof initialContent === 'string' ? 'string' : 'array'}`);
    if (Array.isArray(initialContent)) {
        logger.debug(`[claudeRemote] Content array length: ${initialContent.length}, types: ${initialContent.map(c => c.type).join(', ')}`);
    }
    messages.push({
        type: 'user',
        message: {
            role: 'user',
            content: initialContent,
        },
    });

    // Start the loop
    const response = query({
        prompt: messages,
        options: sdkOptions,
    });

    updateThinking(true);
    try {
        logger.debug(`[claudeRemote] Starting to iterate over response`);

        for await (const message of response) {
            logger.debugLargeJson(`[claudeRemote] Message ${message.type}`, message);

            // Handle messages
            opts.onMessage(message);

            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {
                // Start thinking when session initializes
                updateThinking(true);

                const systemInit = message as SDKSystemMessage;

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
                if (systemInit.session_id) {
                    logger.debug(`[claudeRemote] Waiting for session file to be written to disk: ${systemInit.session_id}`);
                    const projectDir = getProjectPath(opts.path);
                    const found = await awaitFileExist(join(projectDir, `${systemInit.session_id}.jsonl`));
                    logger.debug(`[claudeRemote] Session file found: ${systemInit.session_id} ${found}`);
                    opts.onSessionFound(systemInit.session_id);
                }
            }

            // Handle result messages
            if (message.type === 'result') {
                updateThinking(false);
                logger.debug('[claudeRemote] Result received, exiting claudeRemote');

                // Send completion messages
                if (isCompactCommand) {
                    logger.debug('[claudeRemote] Compaction completed');
                    if (opts.onCompletionEvent) {
                        opts.onCompletionEvent('Compaction completed');
                    }
                    isCompactCommand = false;
                }

                // The launcher must serialize provider output, synthetic tool
                // cleanup, and this authoritative terminal into one durable
                // stream before Claude can accept the next prompt.
                await opts.onResult(message as SDKResultMessage, activeTurn);

                // Push next message
                const next = await opts.nextMessage();
                if (!next) {
                    messages.end();
                    return;
                }
                mode = next.mode;
                activeTurn = createClaudeTurn(next.mode);
                await opts.onTurnStarted(activeTurn);
                messages.push({ type: 'user', message: { role: 'user', content: buildMessageContent(next.message, next.mode.images) } });
            }

            // Handle tool result
            if (message.type === 'user') {
                const msg = message as SDKUserMessage;
                if (msg.message.role === 'user' && Array.isArray(msg.message.content)) {
                    for (let c of msg.message.content) {
                        if (c.type === 'tool_result' && c.tool_use_id && opts.isAborted(c.tool_use_id)) {
                            logger.debug('[claudeRemote] Tool aborted, exiting claudeRemote');
                            return;
                        }
                    }
                }
            }
        }
    } catch (e) {
        if (e instanceof AbortError) {
            logger.debug(`[claudeRemote] Aborted`);
            // Ignore
        } else {
            throw e;
        }
    } finally {
        updateThinking(false);
    }
}
