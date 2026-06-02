import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __testAgentPlaneSessionPrep } from './agentPlaneSessionPrep';

describe('Agent Plane session preparation RPC', () => {
    it('writes session files under the local conversations temp root', async () => {
        const directory = join(tmpdir(), 'conversations', `api-machine-test-${Date.now()}`);
        await rm(directory, { recursive: true, force: true });

        const result = await __testAgentPlaneSessionPrep.prepareAgentPlaneSession({
            directory,
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
