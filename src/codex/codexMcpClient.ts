/**
 * Codex MCP Client - Simple wrapper for Codex tools
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { logger } from '@/ui/logger';
import type { CodexSessionConfig, CodexToolResponse } from './types';
import { z } from 'zod';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { execSync } from 'child_process';

// Custom elicitation schema that preserves Codex-specific fields (codex_call_id, etc.).
// The standard ElicitRequestSchema uses Zod's default strip mode which silently drops
// unknown properties. Codex sends custom fields like codex_call_id, codex_command, and
// codex_cwd as top-level params, so we need .passthrough() to keep them.
//
// The params schema is intentionally permissive (`.passthrough()` over an empty
// object) — historic versions of codex put the elicitation message at
// `params.message` (string), but newer versions emitting `mcp_tool_call`
// approvals nest the human-readable text under `params.request.message` and
// the codex-specific approval metadata under `params.request._meta`. A
// stricter schema (e.g. requiring `params.message: z.string()`) silently
// drops the request, leaving codex hung waiting for an approval response.
const CodexElicitRequestSchema = z.object({
    method: z.literal('elicitation/create'),
    params: z.object({}).passthrough(),
}).passthrough();

const DEFAULT_TIMEOUT = 14 * 24 * 60 * 60 * 1000; // 14 days, which is the half of the maximum possible timeout (~28 days for int32 value in NodeJS)

// MCP tool names that are safe to auto-approve when codex asks for permission
// to run them via mcp_tool_call elicitations. The four entries cover all
// aliases registered in codex/happyMcpStdioBridge.ts:112-118 — different MCP
// transports escape underscores differently (single vs. double) and the model
// will pick whichever form appears in its prompt. Long-term we should collapse
// to a single canonical name (`change_title`) and remove the rest, but until
// the prompt + bridge are aligned, accept all four.
const AUTO_APPROVE_MCP_TOOLS = new Set([
    'change_title',
    'change__title',
    'happy__change_title',
    'happy__change__title',
]);

/**
 * Pull the actual MCP tool name out of a Codex `mcp_tool_call` elicitation.
 *
 * Codex doesn't put the tool name in a dedicated field — it embeds it in the
 * human-readable message string (`Allow the happy MCP server to run tool
 * "change__title"?`). `_meta.tool_title` is a display-friendly title (e.g.
 * "Change Chat Title") and not the tool's invocation name, so we regex the
 * message first and fall back to `_meta.tool_title` only if parsing fails.
 */
function extractMcpToolName(
    message: string | undefined,
    meta: { tool_title?: string } | undefined,
): string | null {
    if (typeof message === 'string') {
        const match = message.match(/run tool ['"]([^'"]+)['"]/i);
        if (match && match[1]) return match[1];
    }
    if (meta?.tool_title && typeof meta.tool_title === 'string') return meta.tool_title;
    return null;
}

/**
 * Get the correct MCP subcommand based on installed codex version
 * Versions >= 0.43.0-alpha.5 use 'mcp-server', older versions use 'mcp'
 * Returns null if codex is not installed or version cannot be determined
 */
function getCodexMcpCommand(): string | null {
    try {
        const version = execSync('codex --version', { encoding: 'utf8' }).trim();
        const match = version.match(/codex-cli\s+(\d+\.\d+\.\d+(?:-alpha\.\d+)?)/);
        if (!match) {
            logger.debug('[CodexMCP] Could not parse codex version:', version);
            return null;
        }

        const versionStr = match[1];
        const [major, minor, patch] = versionStr.split(/[-.]/).map(Number);

        // Version >= 0.43.0-alpha.5 has mcp-server
        if (major > 0 || minor > 43) return 'mcp-server';
        if (minor === 43 && patch === 0) {
            // Check for alpha version
            if (versionStr.includes('-alpha.')) {
                const alphaNum = parseInt(versionStr.split('-alpha.')[1]);
                return alphaNum >= 5 ? 'mcp-server' : 'mcp';
            }
            return 'mcp-server'; // 0.43.0 stable has mcp-server
        }
        return 'mcp'; // Older versions use mcp
    } catch (error) {
        logger.debug('[CodexMCP] Codex CLI not found or not executable:', error);
        return null;
    }
}

export class CodexMcpClient {
    private client: Client;
    private transport: StdioClientTransport | null = null;
    private connected: boolean = false;
    private sessionId: string | null = null;
    private conversationId: string | null = null;
    private handler: ((event: any) => void) | null = null;
    private permissionHandler: CodexPermissionHandler | null = null;

    constructor() {
        this.client = new Client(
            { name: 'happy-codex-client', version: '1.0.0' },
            { capabilities: { elicitation: {} } }
        );

        // @ts-expect-error MCP SDK Zod type mismatch — runtime behavior is correct
        this.client.setNotificationHandler(z.object({
            method: z.literal('codex/event'),
            params: z.object({
                msg: z.any()
            })
        }).passthrough(), (data) => {
            const msg = data.params.msg;
            this.updateIdentifiersFromEvent(msg);
            this.handler?.(msg);
        });
    }

    setHandler(handler: ((event: any) => void) | null): void {
        this.handler = handler;
    }

    /**
     * Set the permission handler for tool approval
     */
    setPermissionHandler(handler: CodexPermissionHandler): void {
        this.permissionHandler = handler;
    }

    async connect(): Promise<void> {
        if (this.connected) return;

        const mcpCommand = getCodexMcpCommand();

        if (mcpCommand === null) {
            throw new Error(
                'Codex CLI not found or not executable.\n' +
                '\n' +
                'To install codex:\n' +
                '  npm install -g @openai/codex\n' +
                '\n' +
                'Alternatively, use Claude:\n' +
                '  happy claude'
            );
        }

        logger.debug(`[CodexMCP] Connecting to Codex MCP server using command: codex ${mcpCommand}`);

        this.transport = new StdioClientTransport({
            command: 'codex',
            args: [mcpCommand],
            env: Object.keys(process.env).reduce((acc, key) => {
                const value = process.env[key];
                if (typeof value === 'string') acc[key] = value;
                return acc;
            }, {} as Record<string, string>)
        });

        // Register request handlers for Codex permission methods
        this.registerPermissionHandlers();

        await this.client.connect(this.transport);
        this.connected = true;

        logger.debug('[CodexMCP] Connected to Codex');
    }

    private registerPermissionHandlers(): void {
        // Register handler for Codex approval elicitations. As of codex 0.128
        // only `exec_approval` (bash exec) actually arrives here as a standard
        // MCP `elicitation/create` request — codex's mcp-server crate ships
        // handlers for exec_approval.rs and patch_approval.rs only, with no
        // mcp_tool_call_approval.rs equivalent. The newer
        // `_meta.codex_approval_kind === "mcp_tool_call"` flow is emitted
        // via `codex/event` notifications instead and waits for a response
        // method that mcp-server doesn't expose, so we work around it by
        // setting `approval-policy: 'on-request'` in runCodex.ts (which
        // bypasses the elicitation entirely for MCP tool calls). The
        // `mcp_tool_call` branch + AUTO_APPROVE_MCP_TOOLS set below stay as
        // forward-looking defense in case codex routes mcp_tool_call_approval
        // through standard elicit/create in a future release.
        //
        // We MUST bypass the Client's overridden setRequestHandler and call
        // Protocol's base version directly. The Client override wraps elicitation
        // handlers with ElicitResultSchema validation (which rejects responses
        // without an `action` field) and strips unknown fields. Codex uses a
        // NON-STANDARD response format { decision: ReviewDecision } that doesn't
        // conform to the MCP ElicitResult spec. Using the base Protocol handler
        // passes our response through without validation or field stripping.
        //
        // Also uses CodexElicitRequestSchema (passthrough) instead of the SDK's
        // ElicitRequestSchema because Codex sends custom fields (codex_call_id,
        // codex_command, codex_cwd) as top-level params that the standard schema
        // would strip.
        const protocolProto = Object.getPrototypeOf(Object.getPrototypeOf(this.client));
        protocolProto.setRequestHandler.call(
            this.client,
            CodexElicitRequestSchema,
            async (request: any) => {
                const params = request.params as {
                    message?: string,
                    codex_elicitation?: string,
                    codex_mcp_tool_call_id?: string,
                    codex_event_id?: string,
                    codex_call_id?: string,
                    codex_command?: string[],
                    codex_cwd?: string,
                    id?: string,
                    _meta?: {
                        codex_approval_kind?: string,
                        tool_title?: string,
                        tool_description?: string,
                        tool_params?: Record<string, unknown>,
                    },
                };

                const approvalKind = params._meta?.codex_approval_kind;
                const isMcpToolCall = approvalKind === 'mcp_tool_call';

                // Auto-approve known-safe MCP tool calls without round-tripping
                // through the app (matches the auto-approval behavior the
                // Gemini permission handler already has for change_title).
                // The happy MCP server registers four name aliases for the
                // title-change tool because different MCP transports escape
                // underscores differently (single vs. double); keep the auto-
                // approve list aligned with happyMcpStdioBridge.ts:112-118.
                if (isMcpToolCall) {
                    const mcpToolName = extractMcpToolName(params.message, params._meta);
                    if (mcpToolName && AUTO_APPROVE_MCP_TOOLS.has(mcpToolName)) {
                        logger.debug('[CodexMCP] Auto-approving safe MCP tool:', mcpToolName);
                        return { decision: 'approved_for_session' as const };
                    }
                }

                // Derive permission ID with intentional priority.
                // codex_call_id is the exec-level call ID that matches the call_id
                // in exec_approval_request events (used as tool call ID in the app).
                // For mcp_tool_call_approval elicitations the id can also arrive
                // embedded in the elicitation id like
                // "mcp_tool_call_approval_call_<id>"; extract it as a fallback.
                let permissionId: string | undefined =
                    params.codex_call_id || params.codex_mcp_tool_call_id;
                if (!permissionId && typeof params.id === 'string') {
                    const idMatch = params.id.match(/^mcp_tool_call_approval_(.+)$/);
                    if (idMatch) permissionId = idMatch[1];
                }
                logger.debug('[CodexMCP] Elicitation fields - kind:', approvalKind,
                    'codex_call_id:', params.codex_call_id,
                    'codex_mcp_tool_call_id:', params.codex_mcp_tool_call_id,
                    'permissionId:', permissionId, 'keys:', Object.keys(params));

                if (!permissionId || typeof permissionId !== 'string' || permissionId.trim().length === 0) {
                    logger.debug('[CodexMCP] Elicitation missing permission ID, denying. Keys:', Object.keys(params));
                    return { decision: 'denied' as const };
                }

                if (!this.permissionHandler) {
                    logger.debug('[CodexMCP] No permission handler set, denying');
                    return { decision: 'denied' as const };
                }

                // Pick a meaningful tool name for the app's permission UI:
                //   - mcp_tool_call: the actual MCP tool name parsed from the
                //     elicitation message / _meta (was previously hardcoded to
                //     'CodexBash', which made the app misrender as a bash exec
                //     prompt).
                //   - exec_approval (default): keep the historical 'CodexBash'.
                const toolName = isMcpToolCall
                    ? (extractMcpToolName(params.message, params._meta) || 'CodexMcpTool')
                    : 'CodexBash';

                const toolInput = isMcpToolCall
                    ? {
                        toolName,
                        title: params._meta?.tool_title,
                        description: params._meta?.tool_description,
                        arguments: params._meta?.tool_params,
                    }
                    : {
                        command: params.codex_command,
                        cwd: params.codex_cwd,
                    };

                try {
                    const result = await this.permissionHandler.handleToolCall(
                        permissionId,
                        toolName,
                        toolInput,
                    );

                    logger.debug('[CodexMCP] Permission result:', result);

                    // Codex uses a NON-STANDARD elicitation response format:
                    // { decision: ReviewDecision } where ReviewDecision is one of:
                    // "approved", "approved_for_session", "approved_execpolicy_amendment", "denied"
                    // See codex-rs/mcp-server/src/exec_approval.rs (ExecApprovalResponse)
                    // This does NOT conform to the MCP ElicitResult spec ({ action, content }).
                    const decision = result.decision === 'approved' || result.decision === 'approved_for_session'
                        ? result.decision
                        : 'denied';
                    return { decision };
                } catch (error) {
                    logger.debug('[CodexMCP] Error handling permission request:', error);
                    return { decision: 'denied' as const };
                }
            }
        );

        logger.debug('[CodexMCP] Permission handlers registered');
    }

    async startSession(config: CodexSessionConfig, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
        if (!this.connected) await this.connect();

        logger.debug('[CodexMCP] Starting Codex session:', config);

        const response = await this.client.callTool({
            name: 'codex',
            arguments: config as any
        }, undefined, {
            signal: options?.signal,
            timeout: DEFAULT_TIMEOUT,
            // maxTotalTimeout: 10000000000 
        });

        logger.debug('[CodexMCP] startSession response:', response);

        // Extract session / conversation identifiers from response if present
        this.extractIdentifiers(response);

        return response as CodexToolResponse;
    }

    async continueSession(prompt: string, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
        if (!this.connected) await this.connect();

        if (!this.sessionId) {
            throw new Error('No active session. Call startSession first.');
        }

        if (!this.conversationId) {
            // Some Codex deployments reuse the session ID as the conversation identifier
            this.conversationId = this.sessionId;
            logger.debug('[CodexMCP] conversationId missing, defaulting to sessionId:', this.conversationId);
        }

        const args = { sessionId: this.sessionId, conversationId: this.conversationId, prompt };
        logger.debug('[CodexMCP] Continuing Codex session:', args);

        const response = await this.client.callTool({
            name: 'codex-reply',
            arguments: args
        }, undefined, {
            signal: options?.signal,
            timeout: DEFAULT_TIMEOUT
        });

        logger.debug('[CodexMCP] continueSession response:', response);
        this.extractIdentifiers(response);

        return response as CodexToolResponse;
    }


    private updateIdentifiersFromEvent(event: any): void {
        if (!event || typeof event !== 'object') {
            return;
        }

        const candidates: any[] = [event];
        if (event.data && typeof event.data === 'object') {
            candidates.push(event.data);
        }

        for (const candidate of candidates) {
            const sessionId = candidate.session_id ?? candidate.sessionId;
            if (sessionId) {
                this.sessionId = sessionId;
                logger.debug('[CodexMCP] Session ID extracted from event:', this.sessionId);
            }

            const conversationId = candidate.conversation_id ?? candidate.conversationId;
            if (conversationId) {
                this.conversationId = conversationId;
                logger.debug('[CodexMCP] Conversation ID extracted from event:', this.conversationId);
            }
        }
    }
    private extractIdentifiers(response: any): void {
        const meta = response?.meta || {};
        if (meta.sessionId) {
            this.sessionId = meta.sessionId;
            logger.debug('[CodexMCP] Session ID extracted:', this.sessionId);
        } else if (response?.sessionId) {
            this.sessionId = response.sessionId;
            logger.debug('[CodexMCP] Session ID extracted:', this.sessionId);
        }

        if (meta.conversationId) {
            this.conversationId = meta.conversationId;
            logger.debug('[CodexMCP] Conversation ID extracted:', this.conversationId);
        } else if (response?.conversationId) {
            this.conversationId = response.conversationId;
            logger.debug('[CodexMCP] Conversation ID extracted:', this.conversationId);
        }

        const content = response?.content;
        if (Array.isArray(content)) {
            for (const item of content) {
                if (!this.sessionId && item?.sessionId) {
                    this.sessionId = item.sessionId;
                    logger.debug('[CodexMCP] Session ID extracted from content:', this.sessionId);
                }
                if (!this.conversationId && item && typeof item === 'object' && 'conversationId' in item && item.conversationId) {
                    this.conversationId = item.conversationId;
                    logger.debug('[CodexMCP] Conversation ID extracted from content:', this.conversationId);
                }
            }
        }
    }

    getSessionId(): string | null {
        return this.sessionId;
    }

    hasActiveSession(): boolean {
        return this.sessionId !== null;
    }

    clearSession(): void {
        // Store the previous session ID before clearing for potential resume
        const previousSessionId = this.sessionId;
        this.sessionId = null;
        this.conversationId = null;
        logger.debug('[CodexMCP] Session cleared, previous sessionId:', previousSessionId);
    }

    /**
     * Store the current session ID without clearing it, useful for abort handling
     */
    storeSessionForResume(): string | null {
        logger.debug('[CodexMCP] Storing session for potential resume:', this.sessionId);
        return this.sessionId;
    }

    /**
     * Force close the Codex MCP transport and clear all session identifiers.
     * Use this for permanent shutdown (e.g. kill/exit). Prefer `disconnect()` for
     * transient connection resets where you may want to keep the session id.
     */
    async forceCloseSession(): Promise<void> {
        logger.debug('[CodexMCP] Force closing session');
        try {
            await this.disconnect();
        } finally {
            this.clearSession();
        }
        logger.debug('[CodexMCP] Session force-closed');
    }

    async disconnect(): Promise<void> {
        if (!this.connected) return;

        // Capture pid in case we need to force-kill
        const pid = this.transport?.pid ?? null;
        logger.debug(`[CodexMCP] Disconnecting; child pid=${pid ?? 'none'}`);

        try {
            // Ask client to close the transport
            logger.debug('[CodexMCP] client.close begin');
            await this.client.close();
            logger.debug('[CodexMCP] client.close done');
        } catch (e) {
            logger.debug('[CodexMCP] Error closing client, attempting transport close directly', e);
            try { 
                logger.debug('[CodexMCP] transport.close begin');
                await this.transport?.close?.(); 
                logger.debug('[CodexMCP] transport.close done');
            } catch {}
        }

        // As a last resort, if child still exists, send SIGKILL
        if (pid) {
            try {
                process.kill(pid, 0); // check if alive
                logger.debug('[CodexMCP] Child still alive, sending SIGKILL');
                try { process.kill(pid, 'SIGKILL'); } catch {}
            } catch { /* not running */ }
        }

        this.transport = null;
        this.connected = false;
        // Preserve session/conversation identifiers for potential reconnection / recovery flows.
        logger.debug(`[CodexMCP] Disconnected; session ${this.sessionId ?? 'none'} preserved`);
    }
}
