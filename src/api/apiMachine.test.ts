import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApiMachineClient, __testApiMachineClientInternals } from './apiMachine';
import { __testAgentPlaneSessionPrep } from './agentPlaneSessionPrep';
import packageJson from '../../package.json';
import { RpcResultLedger } from './rpc/RpcResultLedger';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';

describe('Agent Plane session preparation RPC', () => {
    it('accepts the full Agent Plane session prep bundle from conversationId', async () => {
        const conversationId = `conv_api_machine_test_${Date.now()}`;
        const directory = join(tmpdir(), 'conversations', conversationId);
        await rm(directory, { recursive: true, force: true });

        const result = await __testAgentPlaneSessionPrep.prepareAgentPlaneSession({
            conversationId,
            files: [
                { path: 'AGENTS.md', content: 'codex primer' },
                { path: 'CLAUDE.md', content: 'primer' },
                { path: '.mcp.json', content: '{"ok":true}' },
                { path: '.claude/settings.local.json', content: '{"enabledMcpjsonServers":["stackive"]}' },
                { path: 'conversation-history.md', content: '# Conversation History\n\nhello' },
            ],
        });

        expect(result).toEqual({ type: 'success', directory, filesWritten: 5 });
        await expect(readFile(join(directory, 'AGENTS.md'), 'utf8')).resolves.toBe('codex primer');
        await expect(readFile(join(directory, 'CLAUDE.md'), 'utf8')).resolves.toBe('primer');
        await expect(readFile(join(directory, '.mcp.json'), 'utf8')).resolves.toBe('{"ok":true}');
        await expect(readFile(join(directory, '.claude', 'settings.local.json'), 'utf8'))
            .resolves.toBe('{"enabledMcpjsonServers":["stackive"]}');
        await expect(readFile(join(directory, 'conversation-history.md'), 'utf8')).resolves.toBe('# Conversation History\n\nhello');

        await rm(directory, { recursive: true, force: true });
    });

    it('keeps legacy directory support only under the local conversations temp root', async () => {
        const directory = join(tmpdir(), 'conversations', `api-machine-test-${Date.now()}`);
        await rm(directory, { recursive: true, force: true });

        const result = await __testAgentPlaneSessionPrep.prepareAgentPlaneSession({
            directory,
            files: [{ path: 'CLAUDE.md', content: 'primer' }],
        });

        expect(result).toEqual({ type: 'success', directory, filesWritten: 1 });
        await expect(readFile(join(directory, 'CLAUDE.md'), 'utf8')).resolves.toBe('primer');

        await rm(directory, { recursive: true, force: true });
    });

    it('rejects invalid conversation IDs', async () => {
        await expect(__testAgentPlaneSessionPrep.prepareAgentPlaneSession({
            conversationId: '../conv_escape',
            files: [{ path: 'CLAUDE.md', content: 'primer' }],
        })).rejects.toThrow(/Invalid Agent Plane conversation ID/);

        await expect(__testAgentPlaneSessionPrep.prepareAgentPlaneSession({
            conversationId: 'not-a-conversation',
            files: [{ path: 'CLAUDE.md', content: 'primer' }],
        })).rejects.toThrow(/Invalid Agent Plane conversation ID/);
    });

    it('rejects directories outside the local conversations temp root', async () => {
        const outside = await mkdtemp(join(tmpdir(), 'api-machine-outside-'));

        await expect(__testAgentPlaneSessionPrep.prepareAgentPlaneSession({
            directory: outside,
            files: [{ path: 'CLAUDE.md', content: 'primer' }],
        })).rejects.toThrow(/must be under/);

        await rm(outside, { recursive: true, force: true });
    });

    it('rejects absolute and escaping file paths', async () => {
        const directory = join(tmpdir(), 'conversations', `api-machine-test-${Date.now()}`);

        await expect(__testAgentPlaneSessionPrep.prepareAgentPlaneSession({
            directory,
            files: [{ path: '/tmp/escape', content: 'bad' }],
        })).rejects.toThrow(/Invalid Agent Plane session file path/);

        await expect(__testAgentPlaneSessionPrep.prepareAgentPlaneSession({
            directory,
            files: [{ path: '../escape', content: 'bad' }],
        })).rejects.toThrow(/Invalid Agent Plane session file path/);

        await rm(directory, { recursive: true, force: true });
    });

    it('rejects unsupported session file paths', async () => {
        const directory = join(tmpdir(), 'conversations', `api-machine-test-${Date.now()}`);

        await expect(__testAgentPlaneSessionPrep.prepareAgentPlaneSession({
            directory,
            files: [{ path: 'profile.sh', content: 'bad' }],
        })).rejects.toThrow(/Unsupported Agent Plane session file path/);

        await rm(directory, { recursive: true, force: true });
    });

    it('does not follow pre-existing file symlinks', async () => {
        const directory = join(tmpdir(), 'conversations', `api-machine-test-${Date.now()}`);
        const outside = join(tmpdir(), `api-machine-outside-${Date.now()}`);
        await rm(directory, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
        await __testAgentPlaneSessionPrep.prepareAgentPlaneSession({
            directory,
            files: [{ path: 'CLAUDE.md', content: 'primer' }],
        });
        await rm(join(directory, 'CLAUDE.md'), { force: true });
        await symlink(outside, join(directory, 'CLAUDE.md'));

        await expect(__testAgentPlaneSessionPrep.prepareAgentPlaneSession({
            directory,
            files: [{ path: 'CLAUDE.md', content: 'bad' }],
        })).rejects.toThrow();

        await rm(directory, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    });

    it('does not follow a pre-existing .claude directory symlink', async () => {
        const directory = join(tmpdir(), 'conversations', `api-machine-test-${Date.now()}`);
        const outside = await mkdtemp(join(tmpdir(), 'api-machine-outside-'));
        await rm(directory, { recursive: true, force: true });
        await __testAgentPlaneSessionPrep.prepareAgentPlaneSession({
            directory,
            files: [{ path: 'CLAUDE.md', content: 'primer' }],
        });
        await symlink(outside, join(directory, '.claude'));

        await expect(__testAgentPlaneSessionPrep.prepareAgentPlaneSession({
            directory,
            files: [{ path: '.claude/settings.local.json', content: '{}' }],
        })).rejects.toThrow(/not a plain directory/);

        await rm(directory, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    });
});

describe('machine session status RPC', () => {
    it('ledgers prepare/spawn/stop but not explicitly registered machine probes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'boujot-machine-rpc-policy-'));
        try {
            const encryptionKey = new Uint8Array(32);
            const client = new ApiMachineClient('token', {
                id: 'machine_policy',
                name: 'machine_policy',
                encryptionKey,
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            } as any);
            const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'sid_policy' }));
            const stopSession = vi.fn(() => true);
            client.setRPCHandlers({
                spawnSession,
                stopSession,
                sessionStatusList: async () => [],
                providerReadiness: async () => ({
                    type: 'provider-readiness',
                    provider: 'claude',
                    checkedAt: 1,
                    ready: true,
                    executable: { status: 'ready' },
                    authentication: {
                        status: 'ready',
                        verification: 'claude_auth_status',
                        reason: 'authenticated',
                    },
                }),
                requestShutdown: () => {},
            });

            const manager = (client as any).rpcHandlerManager;
            manager.resultLedger = new RpcResultLedger({ directory });
            const request = (method: string, callId: string, params: unknown) => manager.handleRequest({
                callId,
                method: `machine_policy:${method}`,
                params: encodeBase64(encrypt(encryptionKey, 'legacy', params)),
            });
            const records = async () => (await readdir(directory))
                .filter((name) => /^[a-f0-9]{64}\.json$/.test(name));

            await request('daemon-capabilities', '16b0039a-fe45-4038-aa13-cee85e9e898d', {});
            await request('provider-readiness', '533b25d3-c6fd-4cd4-8af5-10b320d85487', { provider: 'claude' });
            await request('session-status-list', 'f06751c8-1242-4326-a7a6-45c1ebd84fca', { sessionIds: [] });
            expect(await records()).toEqual([]);

            const prepareResponse = await request('prepare-agent-plane-session', 'd8cd09e1-93a6-4f79-a907-53707c43461f', {
                conversationId: 'invalid',
                files: [],
            });
            expect(decrypt(encryptionKey, 'legacy', decodeBase64(prepareResponse))).toEqual({
                type: 'prepare_rejected',
                error: 'Invalid Agent Plane conversation ID: invalid',
                retryable: true,
            });
            await request('spawn-agent-plane-session', '7b21bb64-f9ca-4d49-952a-891483b178a4', {
                directory: '/tmp/conversations/conv_policy',
                agent: 'claude',
            });
            const stopResponse = await request('stop-agent-plane-session', 'ab84c091-81f1-462f-9fec-f282509c819a', {
                sessionId: 'sid_policy',
            });
            expect(decrypt(encryptionKey, 'legacy', decodeBase64(stopResponse))).toEqual({
                type: 'stop_requested',
                sessionId: 'sid_policy',
                stopRequestAccepted: true,
                trackingReleased: true,
                processExitConfirmed: false,
            });

            expect(await records()).toHaveLength(3);
            expect(spawnSession).toHaveBeenCalledOnce();
            expect(stopSession).toHaveBeenCalledOnce();

            await request('acknowledge-rpc-result', '690874a5-2219-437e-ad9d-0ec96e03cf35', {
                callId: '7b21bb64-f9ca-4d49-952a-891483b178a4',
                method: 'spawn-agent-plane-session',
            });
            expect(await records()).toHaveLength(3);
            const persisted = await Promise.all((await records()).map(async (name) => (
                JSON.parse(await readFile(join(directory, name), 'utf8')) as { status?: string; method?: string }
            )));
            expect(persisted).toContainEqual(expect.objectContaining({
                status: 'tombstone',
                method: 'machine_policy:spawn-agent-plane-session',
            }));
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('treats an already-absent Agent Plane session stop as an idempotent success', async () => {
        const client = new ApiMachineClient('token', {
            id: 'machine_absent_stop',
            name: 'machine_absent_stop',
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        } as any);
        const stopSession = vi.fn(() => false);
        const sessionStatusList = vi.fn(async () => ([{
            sessionId: 'sid_already_gone',
            status: 'unknown' as const,
        }]));
        client.setRPCHandlers({
            spawnSession: async () => ({ type: 'error', errorMessage: 'not used' }),
            stopSession,
            sessionStatusList,
            providerReadiness: async () => ({
                type: 'provider-readiness',
                provider: 'claude',
                checkedAt: 1,
                ready: true,
                executable: { status: 'ready' },
                authentication: {
                    status: 'ready',
                    verification: 'claude_auth_status',
                    reason: 'authenticated',
                },
            }),
            requestShutdown: () => {},
        });

        const manager = (client as any).rpcHandlerManager;
        const handler = manager.handlers.get('machine_absent_stop:stop-agent-plane-session');
        await expect(handler({ sessionId: 'sid_already_gone' })).resolves.toEqual({
            type: 'stop_requested',
            sessionId: 'sid_already_gone',
            stopRequestAccepted: true,
            trackingReleased: true,
            processExitConfirmed: false,
        });
        expect(stopSession).toHaveBeenCalledOnce();
        expect(sessionStatusList).toHaveBeenCalledWith(['sid_already_gone']);
    });

    it('keeps a rejected stop retryable while the session remains tracked', async () => {
        const client = new ApiMachineClient('token', {
            id: 'machine_tracked_stop',
            name: 'machine_tracked_stop',
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        } as any);
        const stopSession = vi.fn(() => false);
        const sessionStatusList = vi.fn(async () => ([{
            sessionId: 'sid_still_tracked',
            status: 'tracked_alive' as const,
        }]));
        client.setRPCHandlers({
            spawnSession: async () => ({ type: 'error', errorMessage: 'not used' }),
            stopSession,
            sessionStatusList,
            providerReadiness: async () => ({
                type: 'provider-readiness',
                provider: 'claude',
                checkedAt: 1,
                ready: true,
                executable: { status: 'ready' },
                authentication: {
                    status: 'ready',
                    verification: 'claude_auth_status',
                    reason: 'authenticated',
                },
            }),
            requestShutdown: () => {},
        });

        const manager = (client as any).rpcHandlerManager;
        const handler = manager.handlers.get('machine_tracked_stop:stop-agent-plane-session');
        await expect(handler({ sessionId: 'sid_still_tracked' })).resolves.toEqual({
            type: 'stop_rejected',
            sessionId: 'sid_still_tracked',
            reason: 'still_tracked',
            retryable: true,
            stopRequestAccepted: false,
            trackingReleased: false,
            processExitConfirmed: false,
        });
        await expect(handler({})).resolves.toEqual({
            type: 'stop_rejected',
            sessionId: '',
            reason: 'invalid_request',
            retryable: false,
            stopRequestAccepted: false,
            trackingReleased: false,
            processExitConfirmed: false,
        });

        stopSession.mockImplementationOnce(() => {
            throw new Error('signal failure');
        });
        await expect(handler({ sessionId: 'sid_stop_failed' })).resolves.toEqual({
            type: 'stop_rejected',
            sessionId: 'sid_stop_failed',
            reason: 'stop_failed',
            retryable: true,
            stopRequestAccepted: false,
            trackingReleased: false,
            processExitConfirmed: false,
        });

        sessionStatusList.mockRejectedValueOnce(new Error('registry unavailable'));
        await expect(handler({ sessionId: 'sid_status_unavailable' })).resolves.toEqual({
            type: 'stop_rejected',
            sessionId: 'sid_status_unavailable',
            reason: 'status_unavailable',
            retryable: true,
            stopRequestAccepted: false,
            trackingReleased: false,
            processExitConfirmed: false,
        });
    });

    it('returns Agent Plane spawn failures as ACKable outcomes while preserving the legacy RPC', async () => {
        const client = new ApiMachineClient('token', {
            id: 'machine_spawn_rejection',
            name: 'machine_spawn_rejection',
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        } as any);
        let approvalRequired = false;
        const spawnSession = vi.fn(async () => approvalRequired
            ? {
                type: 'requestToApproveDirectoryCreation' as const,
                directory: '/tmp/conversations/conv_spawn_rejection',
            }
            : {
                type: 'error' as const,
                errorMessage: 'provider executable unavailable',
            });
        client.setRPCHandlers({
            spawnSession,
            stopSession: () => false,
            sessionStatusList: async () => [],
            providerReadiness: async () => ({
                type: 'provider-readiness',
                provider: 'claude',
                checkedAt: 1,
                ready: true,
                executable: { status: 'ready' },
                authentication: {
                    status: 'ready',
                    verification: 'claude_auth_status',
                    reason: 'authenticated',
                },
            }),
            requestShutdown: () => {},
        });

        const manager = (client as any).rpcHandlerManager;
        const agentPlaneHandler = manager.handlers.get(
            'machine_spawn_rejection:spawn-agent-plane-session',
        );
        const legacyHandler = manager.handlers.get('machine_spawn_rejection:spawn-happy-session');

        await expect(agentPlaneHandler({ directory: '/tmp/conversations/conv_spawn_rejection' }))
            .resolves.toEqual({
                type: 'spawn_rejected',
                error: 'provider executable unavailable',
                retryable: true,
            });
        await expect(legacyHandler({ directory: '/tmp/conversations/conv_spawn_rejection' }))
            .rejects.toThrow('provider executable unavailable');

        approvalRequired = true;
        await expect(agentPlaneHandler({ directory: '/tmp/conversations/conv_spawn_rejection' }))
            .resolves.toEqual({
                type: 'requestToApproveDirectoryCreation',
                directory: '/tmp/conversations/conv_spawn_rejection',
            });
    });

    it('reports daemon capabilities from the live daemon package', async () => {
        const client = new ApiMachineClient('token', {
            id: 'machine_test',
            name: 'machine_test',
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        } as any);

        const manager = (client as any).rpcHandlerManager;
        expect(manager.hasHandler('daemon-capabilities')).toBe(true);
        const handler = manager.handlers.get('machine_test:daemon-capabilities');

        await expect(handler({})).resolves.toEqual({
            type: 'daemon-capabilities',
            happyCliVersion: packageJson.version,
            capabilities: {
                agentPlaneSessionPrep: {
                    supported: true,
                    allowedFiles: ['AGENTS.md', 'CLAUDE.md', '.mcp.json', '.claude/settings.local.json', 'conversation-history.md'],
                    maxFiles: 5,
                    maxFileBytes: 2 * 1024 * 1024,
                },
                agentPlaneImageReferences: {
                    supported: true,
                    sourceTypes: ['url'],
                    maxImageBytes: 8 * 1024 * 1024,
                    requiresSha256: true,
                },
                agentPlaneAuthoritativeTerminals: {
                    supported: true,
                    protocolVersion: 1,
                    providers: ['claude'],
                    transport: 'acp',
                    terminalTypes: ['task_complete', 'task_failed', 'turn_aborted'],
                    legacyReady: 'ui_idle_only',
                },
                agentPlaneProviderReadiness: {
                    supported: true,
                    rpcMethod: 'provider-readiness',
                    providers: ['claude'],
                    verification: 'claude_auth_status',
                    environmentVariablesModes: ['replace', 'overlay'],
                },
                agentPlaneRpcResultAcknowledgement: {
                    supported: true,
                    rpcMethod: 'acknowledge-rpc-result',
                    acknowledgeAfter: 'authoritative_caller_commit',
                    callerAcknowledgedMethods: [
                        'prepare-agent-plane-session',
                        'spawn-agent-plane-session',
                        'stop-agent-plane-session',
                    ],
                },
                agentPlaneSessionSpawn: {
                    supported: true,
                    rpcMethod: 'spawn-agent-plane-session',
                    requestShape: 'spawn-happy-session-v1',
                    responseShape: 'spawn-happy-session-v1',
                    resultRetention: 'caller_acknowledged',
                },
                agentPlaneSessionStop: {
                    supported: true,
                    rpcMethod: 'stop-agent-plane-session',
                    requestShape: 'stop-session-v1',
                    responseShape: 'stop-agent-plane-session-v1',
                    resultRetention: 'caller_acknowledged',
                    processExitSemantics: 'not_confirmed',
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
        });
    });

    it('delegates provider readiness and returns only the structured probe response', async () => {
        const client = new ApiMachineClient('token', {
            id: 'machine_test',
            name: 'machine_test',
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        } as any);
        const calls: unknown[] = [];
        const response = {
            type: 'provider-readiness' as const,
            provider: 'claude' as const,
            checkedAt: 9_876,
            ready: false,
            executable: { status: 'ready' as const },
            authentication: {
                status: 'required' as const,
                verification: 'claude_auth_status' as const,
                reason: 'authentication_required' as const,
                authMethod: 'none',
                apiProvider: 'firstParty',
            },
        };

        client.setRPCHandlers({
            spawnSession: async () => ({ type: 'error', errorMessage: 'not used' }),
            stopSession: () => false,
            sessionStatusList: () => [],
            providerReadiness: async (request) => {
                calls.push(request);
                return response;
            },
            requestShutdown: () => {},
        });

        const manager = (client as any).rpcHandlerManager;
        expect(manager.hasHandler('provider-readiness')).toBe(true);
        const handler = manager.handlers.get('machine_test:provider-readiness');
        await expect(handler({
            provider: 'claude',
            environmentVariables: { MCP_TIMEOUT: '30000' },
            environmentVariablesMode: 'overlay',
        })).resolves.toEqual(response);
        expect(calls).toEqual([{
            provider: 'claude',
            environmentVariables: { MCP_TIMEOUT: '30000' },
            environmentVariablesMode: 'overlay',
        }]);
        expect(JSON.stringify(response)).not.toMatch(/token|credential/i);

        await expect(handler({
            provider: 'claude',
            environmentVariablesMode: 'merge',
        })).rejects.toThrow('Invalid provider readiness environmentVariablesMode');
    });

    it('refreshes stale daemon-managed metadata while preserving custom metadata', () => {
        const {
            machineMetadataNeedsDaemonRefresh,
            mergeDaemonManagedMachineMetadata,
        } = __testApiMachineClientInternals;
        const current = {
            host: 'new-host',
            platform: 'darwin',
            happyCliVersion: packageJson.version,
            homeDir: '/Users/g',
            happyHomeDir: '/Users/g/.boujot',
            happyLibDir: '/opt/boujot',
            claudeCodeVersion: '1.2.3',
        };
        const existing = {
            ...current,
            host: 'old-host',
            happyCliVersion: '0.14.14',
            customName: 'Desk Mini',
        };

        expect(machineMetadataNeedsDaemonRefresh(existing, current)).toBe(true);
        expect(mergeDaemonManagedMachineMetadata(existing, current)).toEqual({
            ...current,
            customName: 'Desk Mini',
        });
        expect(machineMetadataNeedsDaemonRefresh(current, current)).toBe(false);
    });

    it('forwards Codex MCP spawn options to the daemon spawn handler', async () => {
        const client = new ApiMachineClient('token', {
            id: 'machine_test',
            name: 'machine_test',
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        } as any);
        const calls: unknown[] = [];

        client.setRPCHandlers({
            spawnSession: async (options) => {
                calls.push(options);
                return { type: 'success', sessionId: 'sid_codex' };
            },
            stopSession: () => false,
            sessionStatusList: () => [],
            providerReadiness: async () => ({
                type: 'provider-readiness',
                provider: 'claude',
                checkedAt: 1,
                ready: true,
                executable: { status: 'ready' },
                authentication: {
                    status: 'ready',
                    verification: 'claude_auth_status',
                    reason: 'authenticated',
                },
            }),
            requestShutdown: () => {},
        });

        const manager = (client as any).rpcHandlerManager;
        const handler = manager.handlers.get('machine_test:spawn-happy-session');
        await expect(handler({
            directory: '/tmp/conversations/conv_x',
            agent: 'codex',
            environmentVariables: { EXTERNAL_MCP_TOKEN: 'session-token' },
            environmentVariablesMode: 'overlay',
            codexMcpServers: {
                external: {
                    url: 'http://127.0.0.1:3100/mcp',
                    bearer_token_env_var: 'EXTERNAL_MCP_TOKEN',
                },
            },
            codexUseBuiltInHappyMcp: false,
        })).resolves.toEqual({ type: 'success', sessionId: 'sid_codex' });

        expect(calls).toEqual([{
            directory: '/tmp/conversations/conv_x',
            sessionId: undefined,
            machineId: undefined,
            approvedNewDirectoryCreation: undefined,
            agent: 'codex',
            token: undefined,
            environmentVariables: { EXTERNAL_MCP_TOKEN: 'session-token' },
            environmentVariablesMode: 'overlay',
            codexMcpServers: {
                external: {
                    url: 'http://127.0.0.1:3100/mcp',
                    bearer_token_env_var: 'EXTERNAL_MCP_TOKEN',
                },
            },
            codexUseBuiltInHappyMcp: false,
            requiredTerminalProtocol: undefined,
        }]);

        await expect(handler({
            directory: '/tmp/conversations/conv_x',
            agent: 'claude',
            environmentVariablesMode: 'merge',
        })).rejects.toThrow('Invalid environmentVariablesMode');
        expect(calls).toHaveLength(1);
    });

    it('forwards and returns the exact child terminal-protocol attestation', async () => {
        const client = new ApiMachineClient('token', {
            id: 'machine_test',
            name: 'machine_test',
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        } as any);
        const calls: unknown[] = [];

        client.setRPCHandlers({
            spawnSession: async (options) => {
                calls.push(options);
                return { type: 'success', sessionId: 'sid_claude_v1', terminalProtocol: 1 };
            },
            stopSession: () => false,
            sessionStatusList: () => [],
            providerReadiness: async () => ({
                type: 'provider-readiness',
                provider: 'claude',
                checkedAt: 1,
                ready: true,
                executable: { status: 'ready' },
                authentication: {
                    status: 'ready',
                    verification: 'claude_auth_status',
                    reason: 'authenticated',
                },
            }),
            requestShutdown: () => {},
        });

        const manager = (client as any).rpcHandlerManager;
        const handler = manager.handlers.get('machine_test:spawn-happy-session');
        await expect(handler({
            directory: '/tmp/conversations/conv_v1',
            agent: 'claude',
            requiredTerminalProtocol: 1,
        })).resolves.toEqual({
            type: 'success',
            sessionId: 'sid_claude_v1',
            terminalProtocol: 1,
        });
        expect(calls).toEqual([expect.objectContaining({
            directory: '/tmp/conversations/conv_v1',
            agent: 'claude',
            requiredTerminalProtocol: 1,
        })]);
    });

    it('registers session-status-list and delegates to daemon session tracking', async () => {
        const client = new ApiMachineClient('token', {
            id: 'machine_test',
            name: 'machine_test',
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        } as any);

        client.setRPCHandlers({
            spawnSession: async () => ({ type: 'error', errorMessage: 'not used' }),
            stopSession: () => false,
            sessionStatusList: (sessionIds) => sessionIds.map((sessionId) => ({
                sessionId,
                status: sessionId === 'sid_live' ? 'tracked_alive' : 'unknown',
                pid: sessionId === 'sid_live' ? 123 : undefined,
                terminalProtocol: sessionId === 'sid_live' ? 1 : undefined,
            })),
            providerReadiness: async () => ({
                type: 'provider-readiness',
                provider: 'claude',
                checkedAt: 1,
                ready: true,
                executable: { status: 'ready' },
                authentication: {
                    status: 'ready',
                    verification: 'claude_auth_status',
                    reason: 'authenticated',
                },
            }),
            requestShutdown: () => {},
        });

        const manager = (client as any).rpcHandlerManager;
        expect(manager.hasHandler('session-status-list')).toBe(true);
        const handler = manager.handlers.get('machine_test:session-status-list');

        await expect(handler({ sessionIds: ['sid_live', '', 42, 'sid_missing'] })).resolves.toEqual({
            success: true,
            sessions: [
                { sessionId: 'sid_live', status: 'tracked_alive', pid: 123, terminalProtocol: 1 },
                { sessionId: 'sid_missing', status: 'unknown', pid: undefined, terminalProtocol: undefined },
            ],
        });
    });
});
