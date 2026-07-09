/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import { io, Socket } from 'socket.io-client';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import { registerCommonHandlers, SpawnSessionOptions, SpawnSessionResult } from '../modules/common/registerCommonHandlers';
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import { backoff } from '@/utils/time';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import {
    getAgentPlaneSessionPrepCapabilities,
    prepareAgentPlaneSession,
    PrepareAgentPlaneSessionRequest,
    PrepareAgentPlaneSessionResponse
} from './agentPlaneSessionPrep';
import type { DaemonSessionStatus } from '@/daemon/sessionRegistry';
import packageJson from '../../package.json';

interface ServerToDaemonEvents {
    update: (data: Update) => void;
    'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void;
    'rpc-registered': (data: { method: string }) => void;
    'rpc-unregistered': (data: { method: string }) => void;
    'rpc-error': (data: { type: string, error: string }) => void;
    auth: (data: { success: boolean, user: string }) => void;
    error: (data: { message: string }) => void;
}

interface DaemonToServerEvents {
    'machine-alive': (data: {
        machineId: string;
        time: number;
    }) => void;

    'machine-update-metadata': (data: {
        machineId: string;
        metadata: string; // Encrypted MachineMetadata
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        metadata: string
    } | {
        result: 'success',
        version: number,
        metadata: string
    }) => void) => void;

    'machine-update-state': (data: {
        machineId: string;
        daemonState: string; // Encrypted DaemonState
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        daemonState: string
    } | {
        result: 'success',
        version: number,
        daemonState: string
    }) => void) => void;

    'rpc-register': (data: { method: string }) => void;
    'rpc-unregister': (data: { method: string }) => void;
    'rpc-call': (data: { method: string, params: any }, callback: (response: {
        ok: boolean
        result?: any
        error?: string
    }) => void) => void;
}

type MachineRpcHandlers = {
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => boolean;
    sessionStatusList: (sessionIds: string[]) => Array<{
        sessionId: string;
        status: DaemonSessionStatus;
        pid?: number;
        startedBy?: string;
        trackingSource?: 'memory' | 'registry';
    }> | Promise<Array<{
        sessionId: string;
        status: DaemonSessionStatus;
        pid?: number;
        startedBy?: string;
        trackingSource?: 'memory' | 'registry';
    }>>;
    requestShutdown: () => void;
}

const DAEMON_MANAGED_MACHINE_METADATA_KEYS = [
    'host',
    'platform',
    'happyCliVersion',
    'homeDir',
    'happyHomeDir',
    'happyLibDir',
    'claudeCodeVersion',
    'claudeCodeLatestVersion',
    'claudeCodeUpdateCommand',
] as const;

type DaemonManagedMachineMetadataKey = typeof DAEMON_MANAGED_MACHINE_METADATA_KEYS[number];

export function buildDaemonCapabilities() {
    return {
        type: 'daemon-capabilities',
        happyCliVersion: packageJson.version,
        capabilities: {
            agentPlaneSessionPrep: getAgentPlaneSessionPrepCapabilities(),
            agentPlaneImageReferences: {
                supported: true,
                sourceTypes: ['url'],
                maxImageBytes: 8 * 1024 * 1024,
                requiresSha256: true,
            },
            agentPlaneGoals: {
                supported: true,
                toolNames: ['create_goal', 'get_goal', 'update_goal'],
                nativeRuntimeGoals: {
                    supported: true,
                    transport: 'claude_stream_json',
                    reason: 'Claude stream-json advertises /goal and passes the real claude-goal-stream-json scenario.',
                    actions: ['start', 'view', 'pause', 'resume', 'clear'],
                    transports: {
                        codex_app_server: {
                            supported: false,
                            reason: 'Codex app-server accepts /goal as turn input but does not emit native goal lifecycle events.',
                            actions: [],
                        },
                        claude_stream_json: {
                            supported: true,
                            reason: 'Claude stream-json advertises /goal and passes the real claude-goal-stream-json scenario.',
                            actions: ['start', 'view', 'pause', 'resume', 'clear'],
                        },
                    },
                },
            },
        },
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function mergeDaemonManagedMachineMetadata(
    existing: MachineMetadata | null,
    current: MachineMetadata
): MachineMetadata {
    const merged: Record<string, unknown> = {
        ...(isRecord(existing) ? existing : {}),
    };
    for (const key of DAEMON_MANAGED_MACHINE_METADATA_KEYS) {
        const value = current[key];
        if (value === undefined) {
            delete merged[key];
        } else {
            merged[key] = value;
        }
    }
    return merged as MachineMetadata;
}

export function machineMetadataNeedsDaemonRefresh(
    existing: MachineMetadata | null,
    current: MachineMetadata
): boolean {
    if (!isRecord(existing)) return true;
    for (const key of DAEMON_MANAGED_MACHINE_METADATA_KEYS) {
        if ((existing as Record<DaemonManagedMachineMetadataKey, unknown>)[key] !== current[key]) {
            return true;
        }
    }
    return false;
}

function machineMetadataEqual(left: MachineMetadata | null, right: MachineMetadata): boolean {
    try {
        return JSON.stringify(left ?? null) === JSON.stringify(right);
    } catch {
        return false;
    }
}

export class ApiMachineClient {
    private socket!: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private rpcHandlerManager: RpcHandlerManager;

    constructor(
        private token: string,
        private machine: Machine,
        private currentMachineMetadata?: MachineMetadata
    ) {
        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            encryptionKey: this.machine.encryptionKey,
            encryptionVariant: this.machine.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });

        registerCommonHandlers(this.rpcHandlerManager, process.cwd());
        this.rpcHandlerManager.registerHandler<PrepareAgentPlaneSessionRequest, PrepareAgentPlaneSessionResponse>(
            'prepare-agent-plane-session',
            async (params) => prepareAgentPlaneSession(params)
        );
        this.rpcHandlerManager.registerHandler('daemon-capabilities', async () => buildDaemonCapabilities());
    }

    setRPCHandlers({
        spawnSession,
        stopSession,
        sessionStatusList,
        requestShutdown
    }: MachineRpcHandlers) {
        // Register spawn session handler
        this.rpcHandlerManager.registerHandler('spawn-happy-session', async (params: any) => {
            const {
                directory,
                sessionId,
                machineId,
                approvedNewDirectoryCreation,
                agent,
                token,
                environmentVariables,
                codexMcpServers,
                codexUseBuiltInHappyMcp,
            } = params || {};
            logger.debug(`[API MACHINE] Spawning session with params: ${JSON.stringify(params)}`);

            if (!directory) {
                throw new Error('Directory is required');
            }

            const result = await spawnSession({
                directory,
                sessionId,
                machineId,
                approvedNewDirectoryCreation,
                agent,
                token,
                environmentVariables,
                codexMcpServers,
                codexUseBuiltInHappyMcp,
            });

            switch (result.type) {
                case 'success':
                    logger.debug(`[API MACHINE] Spawned session ${result.sessionId}`);
                    return { type: 'success', sessionId: result.sessionId };

                case 'requestToApproveDirectoryCreation':
                    logger.debug(`[API MACHINE] Requesting directory creation approval for: ${result.directory}`);
                    return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

                case 'error':
                    throw new Error(result.errorMessage);
            }
        });

        // Register stop session handler  
        this.rpcHandlerManager.registerHandler('stop-session', (params: any) => {
            const { sessionId } = params || {};

            if (!sessionId) {
                throw new Error('Session ID is required');
            }

            const success = stopSession(sessionId);
            if (!success) {
                throw new Error('Session not found or failed to stop');
            }

            logger.debug(`[API MACHINE] Stopped session ${sessionId}`);
            return { message: 'Session stopped' };
        });

        this.rpcHandlerManager.registerHandler('session-status-list', async (params: any) => {
            const sessionIds = Array.isArray(params?.sessionIds)
                ? params.sessionIds.filter((item: unknown): item is string => typeof item === 'string' && item.length > 0)
                : [];
            return {
                success: true,
                sessions: await sessionStatusList(sessionIds),
            };
        });

        // Register stop daemon handler
        this.rpcHandlerManager.registerHandler('stop-daemon', () => {
            logger.debug('[API MACHINE] Received stop-daemon RPC request');

            // Trigger shutdown callback after a delay
            setTimeout(() => {
                logger.debug('[API MACHINE] Initiating daemon shutdown from RPC');
                requestShutdown();
            }, 100);

            return { message: 'Daemon stop request acknowledged, starting shutdown sequence...' };
        });
    }

    /**
     * Update machine metadata
     * Currently unused, changes from the mobile client are more likely
     * for example to set a custom name.
     */
    async updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.metadata);

            if (machineMetadataEqual(this.machine.metadata, updated)) {
                logger.debug('[API MACHINE] Metadata unchanged, skipping update');
                return;
            }

            const answer = await this.socket.emitWithAck('machine-update-metadata', {
                machineId: this.machine.id,
                metadata: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.metadataVersion
            });

            if (answer.result === 'success') {
                this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                this.machine.metadataVersion = answer.version;
                logger.debug('[API MACHINE] Metadata updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.metadataVersion) {
                    this.machine.metadataVersion = answer.version;
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                }
                throw new Error('Metadata version mismatch'); // Triggers retry
            }
        });
    }

    private async reconcileDaemonManagedMachineMetadata(): Promise<void> {
        if (!this.currentMachineMetadata) {
            return;
        }
        if (!machineMetadataNeedsDaemonRefresh(this.machine.metadata, this.currentMachineMetadata)) {
            logger.debug('[API MACHINE] Daemon-managed metadata already current');
            return;
        }
        await this.updateMachineMetadata((metadata) => (
            mergeDaemonManagedMachineMetadata(metadata, this.currentMachineMetadata!)
        ));
    }

    /**
     * Update daemon state (runtime info) - similar to session updateAgentState
     * Simplified without lock - relies on backoff for retry
     */
    async updateDaemonState(handler: (state: DaemonState | null) => DaemonState): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.daemonState);

            const answer = await this.socket.emitWithAck('machine-update-state', {
                machineId: this.machine.id,
                daemonState: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.daemonStateVersion
            });

            if (answer.result === 'success') {
                this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                this.machine.daemonStateVersion = answer.version;
                logger.debug('[API MACHINE] Daemon state updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.daemonStateVersion) {
                    this.machine.daemonStateVersion = answer.version;
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                }
                throw new Error('Daemon state version mismatch'); // Triggers retry
            }
        });
    }

    connect() {
        const serverUrl = configuration.serverUrl.replace(/^http/, 'ws');
        logger.debug(`[API MACHINE] Connecting to ${serverUrl}`);

        this.socket = io(serverUrl, {
            transports: ['websocket'],
            auth: {
                token: this.token,
                clientType: 'machine-scoped' as const,
                machineId: this.machine.id
            },
            path: '/v1/updates',
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000
        });

        this.socket.on('connect', () => {
            logger.debug('[API MACHINE] Connected to server');

            // Update daemon state to running
            // We need to override previous state because the daemon (this process)
            // has restarted with new PID & port
            this.updateDaemonState((state) => ({
                ...state,
                status: 'running',
                pid: process.pid,
                httpPort: this.machine.daemonState?.httpPort,
                startedAt: Date.now()
            })).catch((error) => logger.debug('[API MACHINE] Failed to update daemon state on connect', error));

            this.reconcileDaemonManagedMachineMetadata()
                .catch((error) => logger.debug('[API MACHINE] Failed to refresh daemon-managed machine metadata', error));


            // Register all handlers
            this.rpcHandlerManager.onSocketConnect(this.socket);

            // Start keep-alive
            this.startKeepAlive();
        });

        this.socket.on('disconnect', () => {
            logger.debug('[API MACHINE] Disconnected from server');
            this.rpcHandlerManager.onSocketDisconnect();
            this.stopKeepAlive();
        });

        // Single consolidated RPC handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            logger.debugLargeJson(`[API MACHINE] Received RPC request:`, data);
            callback(await this.rpcHandlerManager.handleRequest(data));
        });

        // Handle update events from server
        this.socket.on('update', (data: Update) => {
            // Machine clients should only care about machine updates
            if (data.body.t === 'update-machine' && (data.body as UpdateMachineBody).machineId === this.machine.id) {
                // Handle machine metadata or daemon state updates from other clients (e.g., mobile app)
                const update = data.body as UpdateMachineBody;

                if (update.metadata) {
                    logger.debug('[API MACHINE] Received external metadata update');
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.metadata.value));
                    this.machine.metadataVersion = update.metadata.version;
                }

                if (update.daemonState) {
                    logger.debug('[API MACHINE] Received external daemon state update');
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.daemonState.value));
                    this.machine.daemonStateVersion = update.daemonState.version;
                }
            } else {
                logger.debug(`[API MACHINE] Received unknown update type: ${(data.body as any).t}`);
            }
        });

        this.socket.on('connect_error', (error) => {
            logger.debug(`[API MACHINE] Connection error: ${error.message}`);
        });

        this.socket.io.on('error', (error: any) => {
            logger.debug('[API MACHINE] Socket error:', error);
        });
    }

    private startKeepAlive() {
        this.stopKeepAlive();
        this.keepAliveInterval = setInterval(() => {
            const payload = {
                machineId: this.machine.id,
                time: Date.now()
            };
            if (process.env.DEBUG) { // too verbose for production
                logger.debugLargeJson(`[API MACHINE] Emitting machine-alive`, payload);
            }
            this.socket.emit('machine-alive', payload);
        }, 20000);
        logger.debug('[API MACHINE] Keep-alive started (20s interval)');
    }

    private stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            logger.debug('[API MACHINE] Keep-alive stopped');
        }
    }

    shutdown() {
        logger.debug('[API MACHINE] Shutting down');
        this.stopKeepAlive();
        if (this.socket) {
            this.socket.close();
            logger.debug('[API MACHINE] Socket closed');
        }
    }
}

export const __testApiMachineClientInternals = {
    buildDaemonCapabilities,
    machineMetadataNeedsDaemonRefresh,
    mergeDaemonManagedMachineMetadata,
};
