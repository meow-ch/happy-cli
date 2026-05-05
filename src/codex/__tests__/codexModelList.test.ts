import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
    spawn: vi.fn(),
    processes: [] as FakeCodexProcess[],
}));

vi.mock('node:child_process', () => ({
    spawn: mockState.spawn,
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

describe('codexModelList', () => {
    beforeEach(() => {
        mockState.processes.length = 0;
        mockState.spawn.mockImplementation(() => {
            const proc = new FakeCodexProcess();
            mockState.processes.push(proc);
            return proc;
        });
    });

    it('initializes app-server, paginates model/list, and merges env overrides', async () => {
        const resultPromise = codexModelList({
            timeoutMs: 1_000,
            env: { CODEX_MODEL_LIST_TEST: '1' },
        });

        const proc = mockState.processes[0];
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

        const proc = mockState.processes[0];
        await waitForRequests(proc, 1);
        proc.stderr.write('config missing');
        proc.emit('exit', 1, null);

        await expect(resultPromise).rejects.toThrow(
            /Codex app-server exited while listing models \(exit code 1\)\n\ncodex stderr:\nconfig missing/
        );
    });
});
