import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import { CodexAppServerClient, type CodexAppServerInput } from './codexAppServerClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import os from 'node:os';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { projectPath } from '@/projectPath';
import { join } from 'node:path';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import fs from 'node:fs';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import { trimIdent } from "@/utils/trimIdent";
import type { CodexSessionConfig } from './types';
import {
    CODEX_EXTERNAL_MCP_SERVERS_ENV,
    mergeCodexMcpServers,
    parseExternalCodexMcpServers,
} from './codexMcpServers';
import { resolveCodexExecutionPolicy } from './executionPolicy';
// Codex does not support the Gemini-style `functions.happy__change_title` instruction.
// It can, however, call MCP tools exposed via `mcp_servers` (see `mcpServers` below).
const CODEX_CHANGE_TITLE_INSTRUCTION = [
    'Based on the user\'s message, set a concise and specific session title (2-6 words).',
    'Do NOT use generic titles like "Set Session Title", "Session Title", "New Session", "Chat", or "Conversation".',
    'If the message is too short or not informative (e.g. "ok", "yeah", "test"), do not change the title.',
    // Tool name varies across MCP routers; accept either.
    'Call the MCP tool `mcp__happy__change__title` (or `mcp__happy__change_title` if that is what you see) with JSON: {"title": "<new title>"}',
    'If the task changes significantly, call it again to update the title.',
].join(' ');
import { notifyDaemonSessionStarted } from "@/daemon/controlClient";
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import { delay } from "@/utils/time";
import { stopCaffeinate } from "@/utils/caffeinate";
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentPlanDecision } from '@/api/types';

type ReadyEventOptions = {
    pending: unknown;
    queueSize: () => number;
    shouldExit: boolean;
    sendReady: () => void;
    notify?: () => void;
};

/**
 * Notify connected clients when Codex finishes processing and the queue is idle.
 * Returns true when a ready event was emitted.
 */
export function emitReadyIfIdle({ pending, queueSize, shouldExit, sendReady, notify }: ReadyEventOptions): boolean {
    if (shouldExit) {
        return false;
    }
    if (pending) {
        return false;
    }
    if (queueSize() > 0) {
        return false;
    }

    sendReady();
    notify?.();
    return true;
}

/**
 * Main entry point for the codex command with ink UI
 */
export async function runCodex(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
}): Promise<void> {
    // Use shared PermissionMode type for cross-agent compatibility
    type PermissionMode = import('@/api/types').PermissionMode;
    type PermissionPreset = import('@/api/types').PermissionPreset;
    type CodexApprovalPolicy = import('@/api/types').CodexApprovalPolicy;
    type CodexCollaborationMode = import('@/api/types').CodexCollaborationMode;
    type CodexPermissionProfile = import('@/api/types').CodexPermissionProfile;
    type CodexSandboxMode = import('@/api/types').CodexSandboxMode;
    type RuntimeAccessMode = import('@/api/types').RuntimeAccessMode;
    type RuntimeMode = import('@/api/types').RuntimeMode;
    interface CodexImageContent {
        mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
        data: string;
    }
    interface EnhancedMode {
        permissionMode: PermissionMode;
        permissionPreset?: PermissionPreset;
        runtimeMode?: RuntimeMode;
        accessMode?: RuntimeAccessMode;
        collaborationMode?: CodexCollaborationMode;
        permissionProfile?: CodexPermissionProfile;
        approvalPolicy?: CodexApprovalPolicy;
        sandboxMode?: CodexSandboxMode;
        model?: string;
        reasoningEffort?: string;
        images?: CodexImageContent[];
    }
    type CompletedPlanForDecision = {
        requestId: string;
        planDecision: AgentPlanDecision;
    };

    //
    // Define session
    //

    const sessionTag = randomUUID();

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Codex');

    const api = await ApiClient.create(opts.credentials);

    // Log startup options
    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    //
    // Machine
    //

    const settings = await readSettings();
    let machineId = settings?.machineId;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    //
    // Create session
    //

    const { state, metadata } = createSessionMetadata({
        flavor: 'codex',
        machineId,
        startedBy: opts.startedBy
    });
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

    // Handle server unreachable case - create offline stub with hot reconnection
    let session: ApiSessionClient;
    // Permission handler declared here so it can be updated in onSessionSwap callback
    // (assigned later at line ~385 after client setup)
    let permissionHandler: CodexPermissionHandler;
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        onSessionSwap: (newSession) => {
            session = newSession;
            // Update permission handler with new session to avoid stale reference
            if (permissionHandler) {
                permissionHandler.updateSession(newSession);
            }
        }
    });
    session = initialSession;

    // Always report to daemon if it exists (skip if offline)
    if (response) {
        try {
            logger.debug(`[START] Reporting session ${response.id} to daemon`);
            const result = await notifyDaemonSessionStarted(response.id, metadata);
            if (result.error) {
                logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
            } else {
                logger.debug(`[START] Reported session ${response.id} to daemon`);
            }
        } catch (error) {
            logger.debug('[START] Failed to report to daemon (may not be running):', error);
        }
    }

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        permissionPreset: mode.permissionPreset,
        runtimeMode: mode.runtimeMode,
        accessMode: mode.accessMode,
        collaborationMode: mode.collaborationMode,
        permissionProfile: mode.permissionProfile,
        approvalPolicy: mode.approvalPolicy,
        sandboxMode: mode.sandboxMode,
        model: mode.model,
        reasoningEffort: mode.reasoningEffort,
    }));

    // Track current overrides to apply per message
    // Use shared PermissionMode type from api/types for cross-agent compatibility
    let currentPermissionMode: import('@/api/types').PermissionMode | undefined = undefined;
    let currentPermissionPreset: import('@/api/types').PermissionPreset | undefined = undefined;
    let currentRuntimeMode: import('@/api/types').RuntimeMode | undefined = undefined;
    let currentAccessMode: import('@/api/types').RuntimeAccessMode | undefined = undefined;
    let currentCollaborationMode: import('@/api/types').CodexCollaborationMode | undefined = undefined;
    let currentPermissionProfile: import('@/api/types').CodexPermissionProfile | undefined = undefined;
    let currentApprovalPolicy: import('@/api/types').CodexApprovalPolicy | undefined = undefined;
    let currentSandboxMode: import('@/api/types').CodexSandboxMode | undefined = undefined;
    let currentModel: string | undefined = undefined;
    let currentReasoningEffort: string | undefined = undefined;

    session.onUserMessage((message) => {
        // Resolve permission mode (accept all modes, will be mapped in switch statement)
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            messagePermissionMode = message.meta.permissionMode as import('@/api/types').PermissionMode;
            currentPermissionMode = messagePermissionMode;
            logger.debug(`[Codex] Permission mode updated from user message to: ${currentPermissionMode}`);
        } else {
            logger.debug(`[Codex] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
        }

        let messagePermissionPreset = currentPermissionPreset;
        if (message.meta?.hasOwnProperty('permissionPreset')) {
            messagePermissionPreset = message.meta.permissionPreset || undefined;
            currentPermissionPreset = messagePermissionPreset;
            logger.debug(`[Codex] Permission preset updated from user message: ${messagePermissionPreset || 'reset to provider defaults'}`);
        }

        let messageRuntimeMode = currentRuntimeMode;
        if (message.meta?.hasOwnProperty('mode')) {
            messageRuntimeMode = message.meta.mode || undefined;
            currentRuntimeMode = messageRuntimeMode;
            logger.debug(`[Codex] Runtime mode updated from user message: ${messageRuntimeMode || 'reset to default'}`);
        }

        let messageAccessMode = currentAccessMode;
        if (message.meta?.hasOwnProperty('accessMode')) {
            messageAccessMode = message.meta.accessMode || undefined;
            currentAccessMode = messageAccessMode;
            logger.debug(`[Codex] Access mode updated from user message: ${messageAccessMode || 'reset to default'}`);
        }

        let messageCollaborationMode = currentCollaborationMode;
        if (message.meta?.hasOwnProperty('codexCollaborationMode')) {
            messageCollaborationMode = message.meta.codexCollaborationMode || undefined;
            currentCollaborationMode = messageCollaborationMode;
            logger.debug(`[Codex] Collaboration mode updated from user message: ${messageCollaborationMode || 'reset to default'}`);
        }

        let messagePermissionProfile = currentPermissionProfile;
        if (message.meta?.hasOwnProperty('codexPermissionProfile')) {
            messagePermissionProfile = (message.meta.codexPermissionProfile || undefined) as CodexPermissionProfile | undefined;
            currentPermissionProfile = messagePermissionProfile;
            logger.debug(`[Codex] Permission profile updated from user message: ${messagePermissionProfile || 'reset to mode default'}`);
        }

        // Resolve Codex approval policy; explicit null resets to mode default.
        let messageApprovalPolicy = currentApprovalPolicy;
        if (message.meta?.hasOwnProperty('approvalPolicy')) {
            messageApprovalPolicy = message.meta.approvalPolicy || undefined;
            currentApprovalPolicy = messageApprovalPolicy;
            logger.debug(`[Codex] Approval policy updated from user message: ${messageApprovalPolicy || 'reset to mode default'}`);
        }

        // Resolve Codex sandbox mode; explicit null resets to mode default.
        let messageSandboxMode = currentSandboxMode;
        if (message.meta?.hasOwnProperty('sandboxMode')) {
            messageSandboxMode = message.meta.sandboxMode || undefined;
            currentSandboxMode = messageSandboxMode;
            logger.debug(`[Codex] Sandbox mode updated from user message: ${messageSandboxMode || 'reset to mode default'}`);
        }

        // Resolve model; explicit null resets to default (undefined)
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined;
            currentModel = messageModel;
            logger.debug(`[Codex] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[Codex] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        // Resolve reasoning effort; explicit null resets to default (undefined)
        let messageReasoningEffort = currentReasoningEffort;
        if (message.meta?.hasOwnProperty('reasoningEffort')) {
            messageReasoningEffort = message.meta.reasoningEffort || undefined;
            currentReasoningEffort = messageReasoningEffort;
            logger.debug(`[Codex] Reasoning effort updated from user message: ${messageReasoningEffort || 'reset to default'}`);
        }

        let messageText = '';
        let messageImages: CodexImageContent[] | undefined;
        if (message.content.type === 'text') {
            messageText = message.content.text;
        } else {
            const images: CodexImageContent[] = [];
            for (const part of message.content.parts) {
                if (part.type === 'text') {
                    messageText = messageText ? `${messageText}\n${part.text}` : part.text;
                    continue;
                }
                if (part.type === 'image' && part.source.type === 'base64') {
                    images.push({
                        mediaType: part.source.media_type,
                        data: part.source.data,
                    });
                }
            }
            if (images.length > 0) {
                messageImages = images;
                logger.debug(`[Codex] Extracted ${images.length} image(s) from user message`);
            }
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            permissionPreset: messagePermissionPreset,
            runtimeMode: messageRuntimeMode,
            accessMode: messageAccessMode,
            collaborationMode: messageCollaborationMode,
            permissionProfile: messagePermissionProfile,
            approvalPolicy: messageApprovalPolicy,
            sandboxMode: messageSandboxMode,
            model: messageModel,
            reasoningEffort: messageReasoningEffort,
            images: messageImages,
        };
        if (messageImages && messageImages.length > 0) {
            messageQueue.pushIsolate(messageText, enhancedMode);
        } else {
            messageQueue.push(messageText, enhancedMode);
        }
    });
    let thinking = false;
    session.keepAlive(thinking, 'remote');
    // Periodic keep-alive; store handle so we can clear on exit
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, 'remote');
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
        try {
            api.push().sendToAllDevices(
                "It's ready!",
                'Codex is waiting for your command',
                { sessionId: session.sessionId }
            );
        } catch (pushError) {
            logger.debug('[Codex] Failed to send ready push', pushError);
        }
    };

    // Debug helper: log active handles/requests if DEBUG is enabled
    function logActiveHandles(tag: string) {
        if (!process.env.DEBUG) return;
        const anyProc: any = process as any;
        const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
        const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
        logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
        try {
            const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
            logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
        } catch { }
    }

    //
    // Abort handling
    // IMPORTANT: There are two different operations:
    // 1. Abort (handleAbort): Stops the current inference/task but keeps the session alive
    //    - Used by the 'abort' RPC from mobile app
    //    - Similar to Claude Code's abort behavior
    //    - Allows continuing with new prompts after aborting
    // 2. Kill (handleKillSession): Terminates the entire process
    //    - Used by the 'killSession' RPC
    //    - Completely exits the CLI process
    //

    let abortController = new AbortController();
    let shouldExit = false;
    let storedSessionIdForResume: string | null = null;

    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort() {
        logger.debug('[Codex] Abort requested - stopping current task');
        try {
            // Store the current session ID before aborting for potential resume
            if (client.hasActiveSession()) {
                storedSessionIdForResume = client.storeSessionForResume();
                logger.debug('[Codex] Stored session for resume:', storedSessionIdForResume);
            }
            
            abortController.abort();
            reasoningProcessor.abort();
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
        } finally {
            abortController = new AbortController();
        }
    }

    /**
     * Handles session termination and process exit.
     * This is called when the session needs to be completely killed (not just aborted).
     * Abort stops the current inference but keeps the session alive.
     * Kill terminates the entire process.
     */
    const handleKillSession = async () => {
        logger.debug('[Codex] Kill session requested - terminating process');
        await handleAbort();
        logger.debug('[Codex] Abort completed, proceeding with termination');

        try {
            // Update lifecycle state to archived before closing
            if (session) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                }));
                
                // Send session death message
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            // Force close Codex transport (best-effort) so we don't leave stray processes
            try {
                await client.forceCloseSession();
            } catch (e) {
                logger.debug('[Codex] Error while force closing Codex session during termination', e);
            }

            // Stop caffeinate
            stopCaffeinate();

            // Stop Happy MCP server
            happyServer.stop();

            logger.debug('[Codex] Session termination complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[Codex] Error during session termination:', error);
            process.exit(1);
        }
    };

    // Register abort handler
    session.rpcHandlerManager.registerHandler('abort', handleAbort);

    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    //
    // Initialize Ink UI
    //

    const messageBuffer = new MessageBuffer();
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
            onExit: async () => {
                // Exit the agent
                logger.debug('[codex]: Exiting agent via Ctrl-C');
                shouldExit = true;
                await handleAbort();
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

    //
    // Start Context 
    //

    const client = new CodexAppServerClient();
    const codexImageTempDir = join(os.tmpdir(), 'happy-codex-images', sessionTag);

    // Helper: find Codex session transcript for a given sessionId
    function findCodexResumeFile(sessionId: string | null): string | null {
        if (!sessionId) return null;
        try {
            const codexHomeDir = process.env.CODEX_HOME || join(os.homedir(), '.codex');
            const rootDir = join(codexHomeDir, 'sessions');

            // Recursively collect all files under the sessions directory
            function collectFilesRecursive(dir: string, acc: string[] = []): string[] {
                let entries: fs.Dirent[];
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch {
                    return acc;
                }
                for (const entry of entries) {
                    const full = join(dir, entry.name);
                    if (entry.isDirectory()) {
                        collectFilesRecursive(full, acc);
                    } else if (entry.isFile()) {
                        acc.push(full);
                    }
                }
                return acc;
            }

            const candidates = collectFilesRecursive(rootDir)
                .filter(full => full.endsWith(`-${sessionId}.jsonl`))
                .filter(full => {
                    try { return fs.statSync(full).isFile(); } catch { return false; }
                })
                .sort((a, b) => {
                    const sa = fs.statSync(a).mtimeMs;
                    const sb = fs.statSync(b).mtimeMs;
                    return sb - sa; // newest first
                });
            return candidates[0] || null;
        } catch {
            return null;
        }
    }

    function imageExtension(mediaType: CodexImageContent['mediaType']): string {
        switch (mediaType) {
            case 'image/jpeg':
                return 'jpg';
            case 'image/png':
                return 'png';
            case 'image/gif':
                return 'gif';
            case 'image/webp':
                return 'webp';
        }
    }

    function writeCodexImage(image: CodexImageContent): string {
        fs.mkdirSync(codexImageTempDir, { recursive: true });
        const filePath = join(codexImageTempDir, `${Date.now()}-${randomUUID()}.${imageExtension(image.mediaType)}`);
        fs.writeFileSync(filePath, Buffer.from(image.data, 'base64'));
        return filePath;
    }

    function buildCodexInput(text: string, images?: CodexImageContent[]): CodexAppServerInput[] {
        const input: CodexAppServerInput[] = [];
        for (const image of images ?? []) {
            const path = writeCodexImage(image);
            input.push({ type: 'localImage', path });
        }
        if (text.length > 0 || input.length === 0) {
            input.push({ type: 'text', text, text_elements: [] });
        }
        return input;
    }

    permissionHandler = new CodexPermissionHandler(session);
    const reasoningProcessor = new ReasoningProcessor((message) => {
        // Callback to send messages directly from the processor
        session.sendCodexMessage(message);
    });
    const diffProcessor = new DiffProcessor((message) => {
        // Callback to send messages directly from the processor
        session.sendCodexMessage(message);
    });
    client.setPermissionHandler(permissionHandler);
    const completedPlanForDecision: { current: CompletedPlanForDecision | null } = { current: null };
    let deferredCompletionEvent: { type: 'task_complete' | 'turn_aborted'; id: string } | null = null;
    const rememberCompletedPlanForDecision = (input: {
        id: string;
        text?: string;
        explanation?: string | null;
        steps?: Array<{ step: string; status?: string | null }>;
        status?: 'updated' | 'complete';
    }) => {
        if (input.status !== 'complete') return;
        const planId = String(input.id || randomUUID());
        completedPlanForDecision.current = {
            requestId: `${planId}:decision`,
            planDecision: {
                provider: 'codex',
                planId,
                actions: ['approve', 'stay_in_plan'],
                plan: {
                    id: planId,
                    provider: 'codex',
                    text: input.text,
                    explanation: input.explanation ?? null,
                    steps: Array.isArray(input.steps) ? input.steps : [],
                    status: 'complete',
                },
            },
        };
    };
    const consumeCompletedPlanForDecision = (): CompletedPlanForDecision | null => {
        const plan = completedPlanForDecision.current;
        completedPlanForDecision.current = null;
        return plan;
    };
    const modeForPlanDecision = (
        baseMode: EnhancedMode,
        decision: 'approve' | 'stay_in_plan',
    ): EnhancedMode => ({
        ...baseMode,
        runtimeMode: decision === 'approve' ? 'default' : 'plan',
        collaborationMode: decision === 'approve' ? 'default' : 'plan',
    });
    const sendCompletionEvent = (event: { type: 'task_complete' | 'turn_aborted'; id: string }) => {
        session.sendAgentMessage('codex', event);
    };
    client.setHandler((msg) => {
        logger.debug(`[Codex] MCP message: ${JSON.stringify(msg)}`);

        // Add messages to the ink UI buffer based on message type
        if (msg.type === 'agent_message') {
            messageBuffer.addMessage(msg.message, 'assistant');
        } else if (msg.type === 'agent_reasoning_delta') {
            // Skip reasoning deltas in the UI to reduce noise
        } else if (msg.type === 'agent_reasoning') {
            messageBuffer.addMessage(`[Thinking] ${msg.text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${msg.command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            const output = msg.output || msg.error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msg.type === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'task_complete') {
            messageBuffer.addMessage('Task completed', 'status');
            sendReady();
        } else if (msg.type === 'turn_aborted') {
            messageBuffer.addMessage('Turn aborted', 'status');
            sendReady();
        } else if (msg.type === 'plan_update') {
            messageBuffer.addMessage('Plan updated', 'status');
        }

        if (msg.type === 'task_started') {
            session.sendAgentMessage('codex', {
                type: 'task_started',
                id: typeof msg.turn_id === 'string' ? msg.turn_id : randomUUID(),
            });
            if (!thinking) {
                logger.debug('thinking started');
                thinking = true;
                session.keepAlive(thinking, 'remote');
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            const completionEvent = {
                type: msg.type,
                id: typeof msg.turn_id === 'string' ? msg.turn_id : randomUUID(),
            };
            if (thinking) {
                logger.debug('thinking completed');
                thinking = false;
                session.keepAlive(thinking, 'remote');
            }
            // Reset diff processor on task end or abort
            diffProcessor.reset();
            if (msg.type === 'task_complete' && completedPlanForDecision.current) {
                deferredCompletionEvent = completionEvent;
                return;
            }
            sendCompletionEvent(completionEvent);
        }
        if (msg.type === 'agent_reasoning_section_break') {
            // Reset reasoning processor for new section
            reasoningProcessor.handleSectionBreak();
        }
        if (msg.type === 'agent_reasoning_delta') {
            // Process reasoning delta - tool calls are sent automatically via callback
            reasoningProcessor.processDelta(msg.delta);
        }
        if (msg.type === 'agent_reasoning') {
            // Complete the reasoning section - tool results or reasoning messages sent via callback
            reasoningProcessor.complete(msg.text);
        }
        if (msg.type === 'agent_message') {
            session.sendCodexMessage({
                type: 'message',
                message: msg.message,
                id: randomUUID()
            });
        }
        if (msg.type === 'plan_update') {
            const planId = String(msg.call_id ?? randomUUID());
            rememberCompletedPlanForDecision({
                id: planId,
                text: typeof msg.text === 'string' ? msg.text : '',
                explanation: typeof msg.explanation === 'string' ? msg.explanation : null,
                steps: Array.isArray(msg.steps) ? msg.steps : [],
                status: msg.status === 'updated' ? 'updated' : 'complete',
            });
            session.sendAgentMessage('codex', {
                type: 'plan',
                id: planId,
                text: typeof msg.text === 'string' ? msg.text : '',
                explanation: typeof msg.explanation === 'string' ? msg.explanation : null,
                steps: Array.isArray(msg.steps) ? msg.steps : [],
                status: msg.status === 'updated' ? 'updated' : 'complete',
            });
        }
        if (msg.type === 'plan_delta') {
            session.sendAgentMessage('codex', {
                type: 'plan_delta',
                id: String(msg.call_id ?? randomUUID()),
                delta: String(msg.delta ?? ''),
            });
        }
        if (msg.type === 'exec_command_begin' || msg.type === 'exec_approval_request') {
            let { call_id, type, ...inputs } = msg;
            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexBash',
                callId: call_id,
                input: inputs,
                id: randomUUID()
            });
        }
        if (msg.type === 'exec_command_end') {
            let { call_id, type, ...output } = msg;
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId: call_id,
                output: output,
                id: randomUUID()
            });
        }
        if (msg.type === 'token_count') {
            session.sendCodexMessage({
                ...msg,
                id: randomUUID()
            });
        }
        if (msg.type === 'patch_apply_begin') {
            // Handle the start of a patch operation
            let { call_id, auto_approved, changes } = msg;

            // Add UI feedback for patch operation
            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');

            // Send tool call message
            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexPatch',
                callId: call_id,
                input: {
                    auto_approved,
                    changes
                },
                id: randomUUID()
            });
        }
        if (msg.type === 'patch_apply_end') {
            // Handle the end of a patch operation
            let { call_id, stdout, stderr, success } = msg;

            // Add UI feedback for completion
            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }

            // Send tool call result message
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId: call_id,
                output: {
                    stdout,
                    stderr,
                    success
                },
                id: randomUUID()
            });
        }
        if (msg.type === 'turn_diff') {
            // Handle turn_diff messages and track unified_diff changes
            if (msg.unified_diff) {
                diffProcessor.processDiff(msg.unified_diff);
            }
        }
        if (msg.type === 'error' || msg.type === 'stream_error') {
            const errorMessage = msg.message || msg.error || msg.text || JSON.stringify(msg);
            logger.warn(`[Codex] Error from Codex: ${errorMessage}`);
            messageBuffer.addMessage(`Error: ${errorMessage}`, 'system');
            session.sendCodexMessage({
                type: 'message',
                message: `Error: ${errorMessage}`,
                id: randomUUID()
            });
        }
    });

    // Start Happy MCP server (HTTP) and prepare STDIO bridge config for Codex
    const happyServer = await startHappyServer(session);
    const bridgeCommand = join(projectPath(), 'bin', 'boujot-mcp.mjs');
    const builtInMcpServers = {
        happy: {
            // Run via Node directly to avoid shebang/exec-bit issues across environments.
            command: process.execPath,
            args: [bridgeCommand, '--url', happyServer.url],
            // Pre-trust every tool exposed by the happy MCP server (we
            // registered it ourselves; the model is asking permission to
            // call something we've already authorized). Without this, codex
            // 0.128's mcp-server elicits an mcp_tool_call_approval that has
            // no response path back to the daemon → session deadlocks on
            // the very first model-driven MCP tool call (e.g. our
            // auto-prompted change_title). Session-wide approval-policy
            // (untrusted/on-request/never) doesn't bypass these — only the
            // per-server default_tools_approval_mode does.
            // Codex 0.128 accepts `auto`, `prompt`, or `approve` here.
            // `prompt` (default) elicits → daemon hangs; `auto` routes to
            // codex's auto-review subagent which ALSO elicits in mcp-server
            // topology (verified by scripts/probe-codex-elicit.mjs);
            // `approve` is the only value that bypasses the elicitation
            // entirely and lets the tool execute. We register every tool
            // exposed by `happy` ourselves, so blanket-approve is correct.
            default_tools_approval_mode: 'approve',
        }
    } as const;
    const externalMcp = parseExternalCodexMcpServers(process.env[CODEX_EXTERNAL_MCP_SERVERS_ENV]);
    if (externalMcp.warning) {
        logger.warn(`[Codex] ${externalMcp.warning}`);
    } else if (Object.keys(externalMcp.servers).length > 0) {
        logger.debug(`[Codex] Adding external MCP servers: ${Object.keys(externalMcp.servers).join(', ')}`);
    }
    const mcpServers = mergeCodexMcpServers(builtInMcpServers, externalMcp.servers);
    try {
        logger.debug('[codex]: client.connect begin');
        await client.connect();
        logger.debug('[codex]: client.connect done');
        let wasCreated = false;
        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;

        while (!shouldExit) {
            logActiveHandles('loop-top');
            // Get next batch; respect mode boundaries like Claude
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = pending;
            pending = null;
            if (!message) {
                // Capture the current signal to distinguish idle-abort from queue close
                const waitSignal = abortController.signal;
                const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    // If wait was aborted (e.g., remote abort with no active inference), ignore and continue
                    if (waitSignal.aborted && !shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
            }

            // Defensive check for TS narrowing
            if (!message) {
                break;
            }

            // Display user messages in the UI
            const imageCount = message.mode.images?.length ?? 0;
            const userDisplay = message.message || (imageCount > 0 ? `[${imageCount} image${imageCount === 1 ? '' : 's'}]` : '');
            messageBuffer.addMessage(userDisplay, 'user');
            completedPlanForDecision.current = null;
            deferredCompletionEvent = null;

            try {
                const policy = resolveCodexExecutionPolicy({
                    runtimeMode: message.mode.runtimeMode,
                    permissionPreset: message.mode.permissionPreset,
                    accessMode: message.mode.accessMode,
                    permissionMode: message.mode.permissionMode,
                    collaborationMode: message.mode.collaborationMode,
                    permissionProfile: message.mode.permissionProfile,
                    approvalPolicy: message.mode.approvalPolicy,
                    sandboxMode: message.mode.sandboxMode,
                    model: message.mode.model,
                    reasoningEffort: message.mode.reasoningEffort,
                });
                permissionHandler.setPermissionPreset(policy.permissionPreset);

                if (!wasCreated) {
                    const startConfig: CodexSessionConfig = {
                        prompt: message.message,
                        'approval-policy': policy.approvalPolicy,
                        'base-instructions': CODEX_CHANGE_TITLE_INSTRUCTION,
                        config: { mcp_servers: mcpServers }
                    };
                    if (policy.permissionProfile) {
                        startConfig.permissions = policy.permissionProfile;
                    } else if (policy.sandboxMode) {
                        startConfig.sandbox = policy.sandboxMode;
                    }
                    if (policy.collaborationMode) {
                        startConfig.collaboration_mode = policy.collaborationMode;
                    }
                    if (policy.model) {
                        startConfig.model = policy.model;
                    }
                    if (policy.reasoningEffort) {
                        startConfig.model_reasoning_effort = policy.reasoningEffort;
                    }
                    
                    // Check for resume file from multiple sources
                    let resumeFile: string | null = null;
                    
                    // Resume from stored abort session
                    if (storedSessionIdForResume) {
                        const abortResumeFile = findCodexResumeFile(storedSessionIdForResume);
                        if (abortResumeFile) {
                            resumeFile = abortResumeFile;
                            logger.debug('[Codex] Using resume file from aborted session:', resumeFile);
                            messageBuffer.addMessage('Resuming from aborted session...', 'status');
                        }
                        storedSessionIdForResume = null; // consume once
                    }
                    
                    // Apply resume file if found
                    if (resumeFile) {
                        (startConfig.config as any).experimental_resume = resumeFile;
                    }
                    
                    await client.startSession(
                        startConfig,
                        {
                            signal: abortController.signal,
                            input: buildCodexInput(message.message, message.mode.images),
                        }
                    );
                    wasCreated = true;
                } else {
                    const response = await client.continueSession(
                        buildCodexInput(message.message, message.mode.images),
                        {
                            signal: abortController.signal,
                            mode: {
                                model: policy.model,
                                model_reasoning_effort: policy.reasoningEffort,
                                'approval-policy': policy.approvalPolicy,
                                permissions: policy.permissionProfile,
                                sandbox: policy.sandboxMode,
                                collaboration_mode: policy.collaborationMode,
                            }
                        }
                    );
                    logger.debug('[Codex] continueSession response:', response);
                }
                const planRequest = consumeCompletedPlanForDecision();
                if (planRequest) {
                    const decision = await permissionHandler.handlePlanDecisionRequest(
                        planRequest.requestId,
                        'PlanDecision',
                        planRequest.planDecision,
                    );
                    const feedback = typeof decision.feedback === 'string' ? decision.feedback.trim() : '';
                    if (decision.decision === 'approve') {
                        messageQueue.unshift(
                            feedback || 'Proceed with the approved plan.',
                            modeForPlanDecision(message.mode, 'approve'),
                        );
                    } else if (feedback) {
                        messageQueue.unshift(
                            feedback,
                            modeForPlanDecision(message.mode, 'stay_in_plan'),
                        );
                    } else if (deferredCompletionEvent) {
                        sendCompletionEvent(deferredCompletionEvent);
                    }
                    deferredCompletionEvent = null;
                }
            } catch (error) {
                logger.warn('Error in codex session:', error);
                const isAbortError = error instanceof Error && error.name === 'AbortError';
                
                if (isAbortError) {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    // Abort cancels the current task/inference but keeps the Codex session alive.
                    // Do not clear session state here; the next user message should continue on the
                    // existing session if possible.
                } else {
                    const errorDetail = error instanceof Error ? error.message : String(error);
                    const userMessage = `Codex error: ${errorDetail}`;
                    messageBuffer.addMessage(userMessage, 'status');
                    session.sendCodexMessage({
                        type: 'message',
                        message: userMessage,
                        id: randomUUID()
                    });
                    session.sendSessionEvent({ type: 'message', message: userMessage });
                    // For unexpected exits, try to store session for potential recovery
                    if (client.hasActiveSession()) {
                        storedSessionIdForResume = client.storeSessionForResume();
                        logger.debug('[Codex] Stored session after unexpected error:', storedSessionIdForResume);
                    }
                }
            } finally {
                // Reset permission handler, reasoning processor, and diff processor
                permissionHandler.reset();
                reasoningProcessor.abort();  // Use abort to properly finish any in-progress tool calls
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                logActiveHandles('after-turn');
            }
        }

    } finally {
        // Clean up resources when main loop exits
        logger.debug('[codex]: Final cleanup start');
        logActiveHandles('cleanup-start');

        // Cancel offline reconnection if still running
        if (reconnectionHandle) {
            logger.debug('[codex]: Cancelling offline reconnection');
            reconnectionHandle.cancel();
        }

        try {
            logger.debug('[codex]: sendSessionDeath');
            session.sendSessionDeath();
            logger.debug('[codex]: flush begin');
            await session.flush();
            logger.debug('[codex]: flush done');
            logger.debug('[codex]: session.close begin');
            await session.close();
            logger.debug('[codex]: session.close done');
        } catch (e) {
            logger.debug('[codex]: Error while closing session', e);
        }
        logger.debug('[codex]: client.forceCloseSession begin');
        await client.forceCloseSession();
        logger.debug('[codex]: client.forceCloseSession done');
        // Stop Happy MCP server
        logger.debug('[codex]: happyServer.stop');
        happyServer.stop();

        // Clean up ink UI
        if (process.stdin.isTTY) {
            logger.debug('[codex]: setRawMode(false)');
            try { process.stdin.setRawMode(false); } catch { }
        }
        // Stop reading from stdin so the process can exit
        if (hasTTY) {
            logger.debug('[codex]: stdin.pause()');
            try { process.stdin.pause(); } catch { }
        }
        // Clear periodic keep-alive to avoid keeping event loop alive
        logger.debug('[codex]: clearInterval(keepAlive)');
        clearInterval(keepAliveInterval);
        if (inkInstance) {
            logger.debug('[codex]: inkInstance.unmount()');
            inkInstance.unmount();
        }
        messageBuffer.clear();

        logActiveHandles('cleanup-end');
        logger.debug('[codex]: Final cleanup completed');
    }
}
