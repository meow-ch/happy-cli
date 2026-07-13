import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
    spawn: vi.fn(),
    processes: [] as FakeCodexProcess[],
    readFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    spawn: mockState.spawn,
}));

vi.mock('node:fs', () => ({
    promises: {
        readFile: mockState.readFile,
    },
}));

import { codexModelList } from '../codexModelList';

class FakeCodexProcess extends EventEmitter {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    requests: any[] = [];

    constructor() {
        super();

        let buffer = '';
        this.stdin.on('data', (chunk) => {
            buffer += chunk.toString();

            let newlineIndex = buffer.indexOf('\n');
            while (newlineIndex !== -1) {
                const line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                if (line.trim()) {
                    this.requests.push(JSON.parse(line));
                }
                newlineIndex = buffer.indexOf('\n');
            }
        });
    }

    respond(message: unknown) {
        this.stdout.write(`${JSON.stringify(message)}\n`);
    }

    kill(signal?: NodeJS.Signals) {
        this.emit('exit', null, signal ?? null);
        return true;
    }
}

async function waitForRequests(proc: FakeCodexProcess, count: number) {
    const deadline = Date.now() + 500;
    while (proc.requests.length < count) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${count} requests; received ${proc.requests.length}`);
        }
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

async function waitForSpawn(): Promise<FakeCodexProcess> {
    const deadline = Date.now() + 500;
    while (mockState.processes.length === 0) {
        if (Date.now() > deadline) {
            throw new Error('Timed out waiting for codex app-server spawn');
        }
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    return mockState.processes[0];
}

describe('codexModelList', () => {
    beforeEach(() => {
        mockState.processes.length = 0;
        mockState.spawn.mockImplementation(() => {
            const proc = new FakeCodexProcess();
            mockState.processes.push(proc);
            return proc;
        });
        // Default to a missing cache so app-server-only tests stay focused.
        mockState.readFile.mockReset();
        mockState.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    it('uses app-server fields as authoritative and supplements cache-only models', async () => {
        mockState.readFile.mockResolvedValueOnce(JSON.stringify({
            models: [
                {
                    slug: 'gpt-5.5',
                    display_name: 'GPT-5.5',
                    description: 'Frontier model',
                    priority: 0,
                    visibility: 'list',
                    default_reasoning_level: 'medium',
                    supported_reasoning_levels: [
                        { effort: 'low', description: 'Fast' },
                        { effort: 'medium', description: 'Balanced' },
                    ],
                },
                {
                    slug: 'cache-only-model',
                    display_name: 'Cache only',
                    priority: 2,
                    visibility: 'list',
                },
                {
                    slug: 'hidden-internal',
                    visibility: 'hidden',
                    priority: 1,
                },
            ],
        }));

        const resultPromise = codexModelList();
        const proc = await waitForSpawn();
        await waitForRequests(proc, 1);
        proc.respond({ id: 1, result: {} });
        await waitForRequests(proc, 2);
        proc.respond({
            id: 2,
            result: {
                data: [
                    {
                        model: 'gpt-5.5',
                        displayName: 'Native GPT-5.5',
                        isDefault: true,
                        defaultReasoningEffort: 'high',
                        supportedReasoningEfforts: [
                            { reasoningEffort: 'low', label: 'Low' },
                            { reasoningEffort: 'high', label: 'High' },
                            { reasoningEffort: 'future', label: 'Future' },
                        ],
                    },
                    { model: 'native-only-model' },
                ],
                nextCursor: null,
            },
        });

        const models = await resultPromise;

        expect(models.map(m => m.model)).toEqual(['gpt-5.5', 'native-only-model', 'cache-only-model']);
        expect(models[0].displayName).toBe('Native GPT-5.5');

        expect(models[0].isDefault).toBe(true);
        expect(models[1].isDefault).toBeUndefined();

        expect(models[0].defaultReasoningEffort).toBe('high');
        expect(models[0].supportedReasoningEfforts).toEqual([
            { reasoningEffort: 'low', label: 'Low' },
            { reasoningEffort: 'high', label: 'High' },
            { reasoningEffort: 'future', label: 'Future' },
        ]);
    });

    it('initializes app-server, paginates model/list, and merges env overrides', async () => {
        const resultPromise = codexModelList({
            timeoutMs: 1_000,
            env: { CODEX_MODEL_LIST_TEST: '1' },
        });

        const proc = await waitForSpawn();
        expect(mockState.spawn).toHaveBeenCalledWith(
            'codex',
            ['app-server', '--listen', 'stdio://'],
            expect.objectContaining({
                env: expect.objectContaining({ CODEX_MODEL_LIST_TEST: '1' }),
            })
        );

        await waitForRequests(proc, 1);
        expect(proc.requests[0].method).toBe('initialize');
        proc.respond({ id: 1, result: {} });

        await waitForRequests(proc, 2);
        expect(proc.requests[1]).toMatchObject({
            method: 'model/list',
            params: { limit: 200 },
        });
        proc.respond({
            id: 2,
            result: {
                data: [{ model: 'gpt-5.5', displayName: 'GPT-5.5' }],
                nextCursor: 'next-page',
            },
        });

        await waitForRequests(proc, 3);
        expect(proc.requests[2]).toMatchObject({
            method: 'model/list',
            params: { cursor: 'next-page', limit: 200 },
        });
        proc.respond({
            id: 3,
            result: {
                data: [{ model: 'gpt-5.4' }, { notAModel: true }],
                nextCursor: null,
            },
        });

        await expect(resultPromise).resolves.toEqual([
            { model: 'gpt-5.5', displayName: 'GPT-5.5' },
            { model: 'gpt-5.4' },
        ]);
    });

    it('rejects pending RPCs immediately when app-server exits early', async () => {
        const resultPromise = codexModelList({ timeoutMs: 1_000 });

        const proc = await waitForSpawn();
        await waitForRequests(proc, 1);
        proc.stderr.write('config missing');
        proc.emit('exit', 1, null);

        await expect(resultPromise).rejects.toThrow(
            /Codex app-server exited while listing models \(exit code 1\)\n\ncodex stderr:\nconfig missing/
        );
    });
});
