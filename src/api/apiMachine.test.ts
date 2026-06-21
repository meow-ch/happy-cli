import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApiMachineClient } from './apiMachine';
import { __testAgentPlaneSessionPrep } from './agentPlaneSessionPrep';

describe('Agent Plane session preparation RPC', () => {
    it('writes session files under the local conversations temp root from conversationId', async () => {
        const conversationId = `conv_api_machine_test_${Date.now()}`;
        const directory = join(tmpdir(), 'conversations', conversationId);
        await rm(directory, { recursive: true, force: true });

        const result = await __testAgentPlaneSessionPrep.prepareAgentPlaneSession({
            conversationId,
            files: [
                { path: 'CLAUDE.md', content: 'primer' },
                { path: '.mcp.json', content: '{"ok":true}' },
            ],
        });

        expect(result).toEqual({ type: 'success', directory, filesWritten: 2 });
        await expect(readFile(join(directory, 'CLAUDE.md'), 'utf8')).resolves.toBe('primer');
        await expect(readFile(join(directory, '.mcp.json'), 'utf8')).resolves.toBe('{"ok":true}');

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
});

describe('machine session status RPC', () => {
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
            })),
            requestShutdown: () => {},
        });

        const manager = (client as any).rpcHandlerManager;
        expect(manager.hasHandler('session-status-list')).toBe(true);
        const handler = manager.handlers.get('machine_test:session-status-list');

        await expect(handler({ sessionIds: ['sid_live', '', 42, 'sid_missing'] })).resolves.toEqual({
            success: true,
            sessions: [
                { sessionId: 'sid_live', status: 'tracked_alive', pid: 123 },
                { sessionId: 'sid_missing', status: 'unknown', pid: undefined },
            ],
        });
    });
});
