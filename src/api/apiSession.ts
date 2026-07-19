import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import axios from 'axios';
import { AgentState, ClientToServerEvents, MessageContent, Metadata, PermissionMode, ServerToClientEvents, Session, SessionEndAckSchema, SessionMessage, SessionMessageAckSchema, SessionMessageReplayPage, SessionMessageReplayPageSchema, Update, UserMessage, UserMessageSchema, Usage } from './types'
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { backoff } from '@/utils/time';
import { configuration } from '@/configuration';
import { RawJSONLines } from '@/claude/types';
import { randomUUID } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers';
import { calculateCost } from '@/utils/pricing';
import { resolveUserMessageImageReferences } from './imageReferences';
import { SessionEndOutboxRecord, SessionMessageOutbox, SessionMessageOutboxOptions, SessionMessageOutboxRecord } from './sessionMessageOutbox';
import { notifyDaemonSessionActivity } from '@/daemon/controlClient';
import { SessionMessageInbox } from './sessionMessageInbox';

/**
 * ACP (Agent Communication Protocol) message data types.
 * This is the unified format for all agent messages - CLI adapts each provider's format to ACP.
 */
export type ACPMessageData =
    // Core message types
    | { type: 'message'; message: string }
    | { type: 'reasoning'; message: string }
    | { type: 'thinking'; text: string }
    | {
        type: 'plan';
        id: string;
        text?: string;
        explanation?: string | null;
        steps?: Array<{ step: string; status?: string | null }>;
        status?: 'updated' | 'complete';
      }
    | { type: 'plan_delta'; id: string; delta: string }
    // Tool interactions
    | { type: 'tool-call'; callId: string; name: string; input: unknown; id: string }
    | { type: 'tool-result'; callId: string; output: unknown; id: string; isError?: boolean }
    // File operations
    | { type: 'file-edit'; description: string; filePath: string; diff?: string; oldContent?: string; newContent?: string; id: string }
    // Terminal/command output
    | { type: 'terminal-output'; data: string; callId: string }
    // Task lifecycle events
    | { type: 'task_started'; id: string }
    | { type: 'task_complete'; id: string }
    | { type: 'task_failed'; id: string; message: string; code?: string; param?: string; status?: number }
    | { type: 'turn_aborted'; id: string }
    // Permissions
    | { type: 'permission-request'; permissionId: string; toolName: string; description: string; options?: unknown }
    // Usage/metrics
    | { type: 'token_count';[key: string]: unknown };

export type ACPProvider = 'gemini' | 'codex' | 'claude' | 'opencode';

export interface ApiSessionClientOptions {
    outbox?: SessionMessageOutboxOptions;
    messageAckTimeoutMs?: number;
    outboxRetryBaseMs?: number;
    outboxRetryMaxMs?: number;
    inbox?: {
        fetchPage?: (afterSeq: number) => Promise<SessionMessageReplayPage>;
        reconcileIntervalMs?: number;
        retryBaseMs?: number;
        retryMaxMs?: number;
    };
}

export class ApiSessionClient extends EventEmitter {
    private readonly token: string;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private pendingMessages: UserMessage[] = [];
    private pendingControlMessages: unknown[] = [];
    private pendingMessageCallback: ((message: UserMessage) => void | Promise<void>) | null = null;
    readonly rpcHandlerManager: RpcHandlerManager;
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private daemonActivityReportLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    private readonly outbox: SessionMessageOutbox;
    private readonly messageAckTimeoutMs: number;
    private readonly outboxRetryBaseMs: number;
    private readonly outboxRetryMaxMs: number;
    private readonly sessionInstanceId = randomUUID();
    private outboxDrainPromise: Promise<void> | null = null;
    private outboxRetryTimer: NodeJS.Timeout | null = null;
    private outboxRetryAttempt = 0;
    private outboxBlockedByPermanentError = false;
    private closed = false;
    private currentThinking = false;
    private currentLastActivityAt = Date.now();
    private lastDaemonActivityReportAt = 0;
    private lastReportedThinking: boolean | null = null;
    private lastReportedPendingOutbox: number | null = null;
    private readonly inbox: SessionMessageInbox;
    private readonly inboxReconcileIntervalMs: number;
    private readonly inboxRetryBaseMs: number;
    private readonly inboxRetryMaxMs: number;
    private inboxReconcilePromise: Promise<void> | null = null;
    private inboxRetryTimer: NodeJS.Timeout | null = null;
    private inboxPeriodicTimer: NodeJS.Timeout | null = null;
    private inboxRetryAttempt = 0;
    private readonly ownMessageCiphertextByLocalId = new Map<string, string>();

    constructor(token: string, session: Session, options: ApiSessionClientOptions = {}) {
        super()
        this.token = token;
        this.sessionId = session.id;
        this.metadata = session.metadata;
        this.metadataVersion = session.metadataVersion;
        this.agentState = session.agentState;
        this.agentStateVersion = session.agentStateVersion;
        this.encryptionKey = session.encryptionKey;
        this.encryptionVariant = session.encryptionVariant;
        this.outbox = new SessionMessageOutbox(session.id, options.outbox);
        this.outboxBlockedByPermanentError = this.outbox.hasBarrier;
        this.messageAckTimeoutMs = options.messageAckTimeoutMs
            ?? Number(process.env.HAPPY_MESSAGE_ACK_TIMEOUT_MS || 15_000);
        this.outboxRetryBaseMs = options.outboxRetryBaseMs ?? 1_000;
        this.outboxRetryMaxMs = options.outboxRetryMaxMs ?? 60_000;
        for (const record of this.outbox.pendingRecords()) {
            this.ownMessageCiphertextByLocalId.set(record.localId, record.message);
        }
        const fetchPage = options.inbox?.fetchPage ?? (async (afterSeq: number) => {
            const response = await axios.get(
                `${configuration.serverUrl}/v1/sessions/${encodeURIComponent(this.sessionId)}/messages`,
                {
                    headers: { Authorization: `Bearer ${this.token}` },
                    params: { afterSeq, limit: 500 },
                    timeout: 30_000,
                },
            );
            const parsed = SessionMessageReplayPageSchema.safeParse(response.data);
            if (!parsed.success) throw new Error('Invalid session message replay response');
            return parsed.data;
        });
        this.inbox = new SessionMessageInbox({
            initialAfterSeq: session.seq,
            fetchPage,
            deliver: (message) => this.deliverStoredSessionMessage(message),
        });
        this.inboxReconcileIntervalMs = options.inbox?.reconcileIntervalMs ?? 3_000;
        this.inboxRetryBaseMs = options.inbox?.retryBaseMs ?? 1_000;
        this.inboxRetryMaxMs = options.inbox?.retryMaxMs ?? 30_000;

        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });
        registerCommonHandlers(this.rpcHandlerManager, this.metadata.path);

        //
        // Create socket
        //

        this.socket = io(configuration.serverUrl, {
            auth: {
                token: this.token,
                clientType: 'session-scoped' as const,
                sessionId: this.sessionId,
                sessionInstanceId: this.sessionInstanceId,
            },
            path: '/v1/updates',
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 60000,
            randomizationFactor: 1,
            transports: ['websocket'],
            withCredentials: true,
            autoConnect: false
        });

        //
        // Handlers
        //

        this.socket.on('connect', () => {
            logger.debug('Socket connected successfully');
            this.rpcHandlerManager.onSocketConnect(this.socket);
            this.outboxRetryAttempt = 0;
            if (this.outboxRetryTimer) {
                clearTimeout(this.outboxRetryTimer);
                this.outboxRetryTimer = null;
            }
            this.scheduleOutboxDrain(0);
            this.startInboxPeriodicReconciliation();
            this.scheduleInboxReconciliation(0);
        })

        // Set up global RPC request handler
        this.socket.on('rpc-request', async (data: { callId?: string, method: string, params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data));
        })

        this.socket.on('disconnect', (reason) => {
            logger.debug('[API] Socket disconnected:', reason);
            this.rpcHandlerManager.onSocketDisconnect();
            this.stopInboxReconciliationTimers();
        })

        this.socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error:', error);
            this.rpcHandlerManager.onSocketDisconnect();
            this.stopInboxReconciliationTimers();
        })

        // Server events
        this.socket.on('update', async (data: Update) => {
            try {
                logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', data);

                if (!data.body) {
                    logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                    return;
                }

                if (data.body.t === 'new-message') {
                    // Socket delivery is only a wake-up. Reading the canonical
                    // cursor endpoint heals disconnects, Redis loss, duplicates,
                    // and out-of-order at-least-once notifications.
                    if (data.body.sid === this.sessionId) this.scheduleInboxReconciliation(0);
                } else if (data.body.t === 'update-session') {
                    if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.metadata.value));
                        this.metadataVersion = data.body.metadata.version;
                    }
                    if (data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
                        this.agentState = data.body.agentState.value ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.agentState.value)) : null;
                        this.agentStateVersion = data.body.agentState.version;
                    }
                } else if (data.body.t === 'update-machine') {
                    // Session clients shouldn't receive machine updates - log warning
                    logger.debug(`[SOCKET] WARNING: Session client received unexpected machine update - ignoring`);
                } else {
                    // If not a user message, it might be a permission response or other message type
                    this.emit('message', data.body);
                }
            } catch (error) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', { error });
            }
        });

        // DEATH
        this.socket.on('error', (error) => {
            logger.debug('[API] Socket error:', error);
        });

        //
        // Connect (after short delay to give a time to add handlers)
        //

        this.socket.connect();
    }

    get pendingOutboxCount(): number {
        return this.outbox.pendingCount;
    }

    get quarantinedOutboxCount(): number {
        return this.outbox.quarantinedCount;
    }

    get inboundAfterSeq(): number {
        return this.inbox.afterSeq;
    }

    override on(eventName: string | symbol, listener: (...args: any[]) => void): this {
        super.on(eventName, listener);
        if (eventName === 'message') this.drainPendingControlMessages();
        return this;
    }

    onUserMessage(callback: (data: UserMessage) => void | Promise<void>) {
        this.pendingMessageCallback = callback;
        while (this.pendingMessages.length > 0) {
            void Promise.resolve(callback(this.pendingMessages.shift()!)).catch((error) => {
                logger.debug('[INBOX] Pending user message callback failed', { error });
            });
        }
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendClaudeSessionMessage(body: RawJSONLines) {
        let content: MessageContent;

        // Check if body is already a MessageContent (has role property)
        if (body.type === 'user' && typeof body.message.content === 'string' && body.isSidechain !== true && body.isMeta !== true) {
            content = {
                role: 'user',
                content: {
                    type: 'text',
                    text: body.message.content
                },
                meta: {
                    sentFrom: 'cli'
                }
            }
        } else {
            // Wrap Claude messages in the expected format
            content = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: body  // This wraps the entire Claude message
                },
                meta: {
                    sentFrom: 'cli'
                }
            };
        }

        logger.debugLargeJson('[SOCKET] Sending message through socket:', content)

        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.enqueueEncryptedMessage(encrypted);

        // Track usage from assistant messages
        if (body.type === 'assistant' && body.message?.usage) {
            try {
                this.sendUsageData(body.message.usage, body.message.model);
            } catch (error) {
                logger.debug('[SOCKET] Failed to send usage data:', error);
            }
        }

        // Update metadata with summary if this is a summary message
        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            this.updateMetadata((metadata) => ({
                ...metadata,
                summary: {
                    text: body.summary,
                    updatedAt: Date.now()
                }
            }));
        }
    }

    sendCodexMessage(body: any) {
        let content = {
            role: 'agent',
            content: {
                type: 'codex',
                data: body  // This wraps the entire Claude message
            },
            meta: {
                sentFrom: 'cli'
            }
        };
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));

        this.enqueueEncryptedMessage(encrypted);
    }

    /**
     * Send a generic agent message to the session using ACP (Agent Communication Protocol) format.
     * Works for any agent type (Gemini, Codex, Claude, etc.) - CLI normalizes to unified ACP format.
     * 
     * @param provider - The agent provider sending the message (e.g., 'gemini', 'codex', 'claude')
     * @param body - The message payload (type: 'message' | 'reasoning' | 'tool-call' | 'tool-result')
     */
    sendAgentMessage(provider: 'gemini' | 'codex' | 'claude' | 'opencode', body: ACPMessageData) {
        let content = {
            role: 'agent',
            content: {
                type: 'acp',
                provider,
                data: body
            },
            meta: {
                sentFrom: 'cli'
            }
        };

        logger.debug(`[SOCKET] Sending ACP message from ${provider}:`, { type: body.type, hasMessage: 'message' in body });

        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.enqueueEncryptedMessage(encrypted);
    }

    sendSessionEvent(event: {
        type: 'switch', mode: 'local' | 'remote'
    } | {
        type: 'message', message: string
    } | {
        type: 'permission-mode-changed', mode: PermissionMode
    } | {
        type: 'ready'
    }, id?: string) {
        let content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event
            }
        };
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.enqueueEncryptedMessage(encrypted);
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        if (thinking !== this.currentThinking) this.currentLastActivityAt = Date.now();
        this.currentThinking = thinking;
        if (process.env.DEBUG) { // too verbose for production
            logger.debug(`[API] Sending keep alive message: ${thinking}`);
        }
        this.socket.volatile.emit('session-alive', {
            sid: this.sessionId,
            time: Date.now(),
            thinking,
            mode
        });
        void this.reportDaemonActivity();
    }

    /**
     * Send session death message
     */
    sendSessionDeath() {
        // Session-end is itself durable. The drain commits all messages already
        // present in this ordered outbox before it sends an end marker.
        this.currentLastActivityAt = Date.now();
        this.outbox.enqueueSessionEnd(this.sessionInstanceId);
        void this.reportDaemonActivity();
        this.scheduleOutboxDrain(0);
    }

    /**
     * Send usage data to the server
     */
    sendUsageData(usage: Usage, model?: string) {
        // Calculate total tokens
        const totalTokens = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);

        const costs = calculateCost(usage, model);

        // Transform Claude usage format to backend expected format
        const usageReport = {
            key: 'claude-session',
            sessionId: this.sessionId,
            tokens: {
                total: totalTokens,
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_creation: usage.cache_creation_input_tokens || 0,
                cache_read: usage.cache_read_input_tokens || 0
            },
            cost: {
                total: costs.total,
                input: costs.input,
                output: costs.output
            }
        }
        logger.debugLargeJson('[SOCKET] Sending usage data:', usageReport)
        this.socket.emit('usage-report', usageReport);
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    updateMetadata(handler: (metadata: Metadata) => Metadata) {
        this.metadataLock.inLock(async () => {
            await backoff(async () => {
                let updated = handler(this.metadata!); // Weird state if metadata is null - should never happen but here we are
                const answer = await this.socket.emitWithAck('update-metadata', { sid: this.sessionId, expectedVersion: this.metadataVersion, metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) });
                if (answer.result === 'success') {
                    this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    this.metadataVersion = answer.version;
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        this.metadataVersion = answer.version;
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    }
                    throw new Error('Metadata version mismatch');
                } else if (answer.result === 'error') {
                    // Hard error - ignore
                }
            });
        });
    }

    /**
     * Update session agent state
     * @param handler - Handler function that returns the updated agent state
     */
    updateAgentState(handler: (metadata: AgentState) => AgentState) {
        logger.debugLargeJson('Updating agent state', this.agentState);
        this.agentStateLock.inLock(async () => {
            await backoff(async () => {
                let updated = handler(this.agentState || {});
                const answer = await this.socket.emitWithAck('update-state', { sid: this.sessionId, expectedVersion: this.agentStateVersion, agentState: updated ? encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) : null });
                if (answer.result === 'success') {
                    this.agentState = answer.agentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState)) : null;
                    this.agentStateVersion = answer.version;
                    logger.debug('Agent state updated', this.agentState);
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.agentStateVersion) {
                        this.agentStateVersion = answer.version;
                        this.agentState = answer.agentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState)) : null;
                    }
                    throw new Error('Agent state version mismatch');
                } else if (answer.result === 'error') {
                    // console.error('Agent state update error', answer);
                    // Hard error - ignore
                }
            });
        });
    }

    /**
     * Wait for socket buffer to flush
     */
    async flush(): Promise<void> {
        if (!this.socket.connected) return;
        if (this.outboxRetryTimer) {
            clearTimeout(this.outboxRetryTimer);
            this.outboxRetryTimer = null;
        }
        this.scheduleOutboxDrain(0);
        const drain = this.outboxDrainPromise ?? Promise.resolve();
        let drainTimeout: NodeJS.Timeout | null = null;
        try {
            await Promise.race([
                drain,
                new Promise<void>((resolve) => {
                    drainTimeout = setTimeout(resolve, 10_000);
                }),
            ]);
        } finally {
            if (drainTimeout) clearTimeout(drainTimeout);
        }
        if (!this.socket.connected || this.outbox.pendingCount > 0) return;
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 10_000);
            this.socket.emit('ping', () => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }

    async close() {
        logger.debug('[API] socket.close() called');
        this.closed = true;
        if (this.outboxRetryTimer) clearTimeout(this.outboxRetryTimer);
        this.stopInboxReconciliationTimers();
        this.socket.close();
    }

    private startInboxPeriodicReconciliation(): void {
        if (this.inboxPeriodicTimer || this.inboxReconcileIntervalMs <= 0) return;
        this.inboxPeriodicTimer = setInterval(() => {
            this.scheduleInboxReconciliation(0);
        }, this.inboxReconcileIntervalMs);
        this.inboxPeriodicTimer.unref?.();
    }

    private stopInboxReconciliationTimers(): void {
        if (this.inboxRetryTimer) clearTimeout(this.inboxRetryTimer);
        if (this.inboxPeriodicTimer) clearInterval(this.inboxPeriodicTimer);
        this.inboxRetryTimer = null;
        this.inboxPeriodicTimer = null;
    }

    private scheduleInboxReconciliation(delayMs: number): void {
        if (this.closed || !this.socket.connected) return;
        if (delayMs === 0 && this.inboxRetryTimer) {
            clearTimeout(this.inboxRetryTimer);
            this.inboxRetryTimer = null;
        }
        if (this.inboxReconcilePromise) {
            // Mark another pass requested; SessionMessageInbox coalesces it into
            // the existing serialized worker.
            void this.inbox.reconcile();
            return;
        }
        if (this.inboxRetryTimer) return;
        if (delayMs > 0) {
            this.inboxRetryTimer = setTimeout(() => {
                this.inboxRetryTimer = null;
                this.scheduleInboxReconciliation(0);
            }, delayMs);
            this.inboxRetryTimer.unref?.();
            return;
        }

        const work = this.inbox.reconcile();
        this.inboxReconcilePromise = work;
        let retryDelay: number | null = null;
        void work.then(() => {
            this.inboxRetryAttempt = 0;
        }, (error) => {
            const ceiling = Math.min(
                this.inboxRetryMaxMs,
                this.inboxRetryBaseMs * (2 ** Math.min(this.inboxRetryAttempt++, 16)),
            );
            retryDelay = Math.floor(Math.random() * (ceiling + 1));
            logger.debug('[INBOX] Canonical session message reconciliation paused', {
                sessionId: this.sessionId,
                afterSeq: this.inbox.afterSeq,
                error: error instanceof Error ? error.message : String(error),
            });
        }).finally(() => {
            if (this.inboxReconcilePromise === work) this.inboxReconcilePromise = null;
            if (retryDelay !== null && !this.closed && this.socket.connected) {
                this.scheduleInboxReconciliation(retryDelay);
            }
        });
    }

    private async deliverStoredSessionMessage(message: SessionMessage): Promise<void> {
        const ownCiphertext = message.localId
            ? this.ownMessageCiphertextByLocalId.get(message.localId)
            : undefined;
        if (message.localId && ownCiphertext !== undefined) {
            if (message.content.c !== ownCiphertext) {
                throw new Error(`Canonical message conflicts with local outbox id ${message.localId}`);
            }
            this.ownMessageCiphertextByLocalId.delete(message.localId);
            logger.debug('[INBOX] Ignoring locally-produced session message', {
                sessionId: this.sessionId,
                messageId: message.id,
                seq: message.seq,
            });
            return;
        }

        const body = decrypt(
            this.encryptionKey,
            this.encryptionVariant,
            decodeBase64(message.content.c),
        );
        // Historical agent output is never executable input. This remains true
        // even if an old server notification is replayed after reconnect.
        if (body && typeof body === 'object' && body.role === 'agent') return;

        const userResult = UserMessageSchema.safeParse(body);
        if (userResult.success) {
            const resolvedUserMessage = await resolveUserMessageImageReferences(userResult.data);
            // Inbound work invalidates a previously reported safe-idle state
            // immediately. Without a forced report, the normal 30-second
            // heartbeat throttle can let daemon cleanup terminate a session
            // which has just accepted a new prompt.
            this.currentLastActivityAt = Date.now();
            await this.reportDaemonActivity(true);
            if (this.pendingMessageCallback) {
                await this.pendingMessageCallback(resolvedUserMessage);
            } else {
                this.pendingMessages.push(resolvedUserMessage);
            }
            logger.debug('[INBOX] Delivered canonical user message', {
                sessionId: this.sessionId,
                messageId: message.id,
                seq: message.seq,
            });
            return;
        }

        // Permission answers and future control messages intentionally do not
        // need to match UserMessageSchema. Queue before advancing the DB cursor
        // so messages arriving before listener registration remain available.
        this.currentLastActivityAt = Date.now();
        await this.reportDaemonActivity(true);
        this.pendingControlMessages.push(body);
        this.drainPendingControlMessages();
    }

    private drainPendingControlMessages(): void {
        if (this.listenerCount('message') === 0) return;
        while (this.pendingControlMessages.length > 0) {
            const message = this.pendingControlMessages[0];
            // EventEmitter dispatch is synchronous. Only remove the queued
            // control after every current listener accepted the handoff.
            super.emit('message', message);
            this.pendingControlMessages.shift();
        }
    }

    private enqueueEncryptedMessage(message: string): string {
        this.currentLastActivityAt = Date.now();
        const record = this.outbox.enqueue(message);
        this.ownMessageCiphertextByLocalId.set(record.localId, record.message);
        logger.debug('[OUTBOX] Persisted encrypted session message', {
            sessionId: this.sessionId,
            localId: record.localId,
            pending: this.outbox.pendingCount,
        });
        void this.reportDaemonActivity();
        this.scheduleOutboxDrain(0);
        return record.localId;
    }

    private scheduleOutboxDrain(delayMs: number): void {
        if (this.closed
            || this.outboxBlockedByPermanentError
            || this.outboxDrainPromise
            || this.outboxRetryTimer) return;
        if (delayMs > 0) {
            this.outboxRetryTimer = setTimeout(() => {
                this.outboxRetryTimer = null;
                this.scheduleOutboxDrain(0);
            }, delayMs);
            this.outboxRetryTimer.unref?.();
            return;
        }
        if (!this.socket.connected) return;

        this.outboxDrainPromise = this.drainOutbox()
            .catch((error) => {
                logger.debug('[OUTBOX] Drain paused; pending messages remain durable', {
                    sessionId: this.sessionId,
                    pending: this.outbox.pendingCount,
                    error: error instanceof Error ? error.message : String(error),
                });
            })
            .finally(() => {
                this.outboxDrainPromise = null;
                if (!this.closed
                    && !this.outboxBlockedByPermanentError
                    && this.socket.connected
                    && this.outbox.pendingCount > 0) {
                    const ceiling = Math.min(
                        this.outboxRetryMaxMs,
                        this.outboxRetryBaseMs * (2 ** Math.min(this.outboxRetryAttempt++, 16)),
                    );
                    // Full jitter prevents all daemon sessions reconnecting together.
                    this.scheduleOutboxDrain(Math.floor(Math.random() * (ceiling + 1)));
                }
            });
    }

    private async drainOutbox(): Promise<void> {
        while (!this.closed && this.socket.connected) {
            const record = this.outbox.pendingRecords()[0];
            if (record) {
                const acknowledged = await this.deliverOutboxRecord(record);
                if (!acknowledged) return;
                continue;
            }
            const sessionEnd = this.outbox.pendingSessionEnd();
            if (!sessionEnd) return;
            const acknowledged = await this.deliverSessionEnd(sessionEnd);
            if (!acknowledged) return;
        }
    }

    private async deliverOutboxRecord(record: SessionMessageOutboxRecord): Promise<boolean> {
        const rawAnswer = await this.socket
            .timeout(this.messageAckTimeoutMs)
            .emitWithAck('message', {
                sid: this.sessionId,
                message: record.message,
                localId: record.localId,
            });
        const parsedAnswer = SessionMessageAckSchema.safeParse(rawAnswer);
        if (!parsedAnswer.success) throw new Error('Invalid session message ACK from server');
        const answer = parsedAnswer.data;

        if (answer.result === 'success') {
            if (answer.message.localId !== record.localId) {
                throw new Error('Session message ACK localId mismatch');
            }
            this.outbox.acknowledge(record.localId);
            this.outboxRetryAttempt = 0;
            logger.debug('[OUTBOX] Server durably acknowledged session message', {
                sessionId: this.sessionId,
                localId: record.localId,
                seq: answer.message.seq,
                duplicate: answer.duplicate,
                pending: this.outbox.pendingCount,
            });
            void this.reportDaemonActivity();
            return true;
        }

        logger.debug('[OUTBOX] Server rejected session message', {
            sessionId: this.sessionId,
            localId: record.localId,
            code: answer.code,
            retryable: answer.retryable,
        });
        if (answer.retryable) throw new Error(`Retryable session message rejection: ${answer.code}`);
        // A permanent rejection (notably idempotency_conflict) must remain on
        // disk for operator diagnosis; silently deleting it would lose data.
        this.outbox.quarantine(record.localId, answer.code);
        this.outboxBlockedByPermanentError = true;
        void this.reportDaemonActivity();
        return false;
    }

    private async deliverSessionEnd(record: SessionEndOutboxRecord): Promise<boolean> {
        const rawAnswer = await this.socket
            .timeout(this.messageAckTimeoutMs)
            .emitWithAck('session-end', {
                sid: this.sessionId,
                time: record.createdAt,
                localId: record.localId,
                sessionInstanceId: record.sessionInstanceId,
            });
        const parsedAnswer = SessionEndAckSchema.safeParse(rawAnswer);
        if (!parsedAnswer.success) throw new Error('Invalid session-end ACK from server');
        const answer = parsedAnswer.data;
        if (answer.result === 'success') {
            if (answer.localId !== record.localId) throw new Error('Session-end ACK localId mismatch');
            this.outbox.acknowledge(record.localId);
            this.outboxRetryAttempt = 0;
            void this.reportDaemonActivity();
            return true;
        }
        if (answer.retryable) throw new Error(`Retryable session-end rejection: ${answer.code}`);
        this.outbox.quarantine(record.localId, answer.code);
        this.outboxBlockedByPermanentError = true;
        void this.reportDaemonActivity();
        return false;
    }

    private async reportDaemonActivity(force = false): Promise<void> {
        if (this.metadata?.startedBy !== 'daemon' && this.metadata?.startedFromDaemon !== true) return;
        await this.daemonActivityReportLock.inLock(async () => {
            const now = Date.now();
            const pendingOutbox = this.outbox.undeliveredCount;
            const thinking = this.currentThinking;
            const lastActivityAt = this.currentLastActivityAt;
            const stateChanged = thinking !== this.lastReportedThinking
                || pendingOutbox !== this.lastReportedPendingOutbox;
            const becameUnsafeToExpire = thinking
                || (pendingOutbox > 0 && (this.lastReportedPendingOutbox ?? 0) === 0);
            const minimumInterval = becameUnsafeToExpire ? 0 : 5_000;
            if (!force && stateChanged && now - this.lastDaemonActivityReportAt < minimumInterval) return;
            if (!force && !stateChanged && now - this.lastDaemonActivityReportAt < 30_000) return;

            try {
                const result = await notifyDaemonSessionActivity(this.sessionId, {
                    lastActivityAt,
                    thinking,
                    pendingOutbox,
                });
                if (result?.error) {
                    logger.debug('[OUTBOX] Failed to report daemon session activity', {
                        sessionId: this.sessionId,
                        error: result.error,
                    });
                    return;
                }
                // Throttling is based only on evidence the daemon actually
                // accepted. A failed POST must not suppress the next attempt.
                this.lastDaemonActivityReportAt = now;
                this.lastReportedThinking = thinking;
                this.lastReportedPendingOutbox = pendingOutbox;
            } catch (error) {
                logger.debug('[OUTBOX] Failed to report daemon session activity', {
                    sessionId: this.sessionId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        });
    }
}
