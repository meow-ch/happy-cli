import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    query: vi.fn(),
    execFile: vi.fn(),
}));

vi.mock('@/claude/sdk/query', () => ({
    query: mocks.query,
}));

vi.mock('node:child_process', () => ({
    execFile: mocks.execFile,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

import { __testClaudeModelListInternals, claudeModelList } from '../claudeModelList';

const envKeys = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'ANTHROPIC_CUSTOM_MODEL_OPTION',
];

const originalEnv = new Map<string, string | undefined>();

function jsonResponse(body: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: vi.fn(async () => body),
        text: vi.fn(async () => JSON.stringify(body)),
    };
}

function mockProbeResponses(responses: Record<string, string | null>) {
    mocks.query.mockImplementation(({ options }: { options: { model: string } }) => {
        const resolved = responses[options.model];
        return (async function* () {
            if (resolved === null) {
                throw new Error(`probe failed for ${options.model}`);
            }
            yield {
                type: 'system',
                subtype: 'init',
                model: resolved,
            } as any;
        })();
    });
}

describe('claudeModelList', () => {
    beforeEach(() => {
        mocks.query.mockReset();
        mocks.execFile.mockReset();
        mocks.execFile.mockImplementation((_command, _args, _options, callback) => {
            callback(null, [
                'Usage: claude [options]',
                '  --effort <level>  Effort level for the current session',
                '                    (low, medium, high, xhigh, max, ultra)',
                '  --help            Display help',
            ].join('\n'), '');
        });
        for (const key of envKeys) {
            originalEnv.set(key, process.env[key]);
            delete process.env[key];
        }
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        for (const key of envKeys) {
            const value = originalEnv.get(key);
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        originalEnv.clear();
    });

    it('builds the picker rows from SDK probes (matching `claude /model` shape)', async () => {
        mockProbeResponses({
            default: 'claude-opus-4-7[1m]',
            sonnet: 'claude-sonnet-4-6',
            haiku: 'claude-haiku-4-5',
        });

        const models = await claudeModelList();

        expect(mocks.query).toHaveBeenCalledTimes(3);
        expect(models.map(m => m.model)).toEqual(['default', 'sonnet', 'haiku']);

        const def = models.find(m => m.model === 'default');
        expect(def?.displayName).toBe('Default (recommended)');
        expect(def?.description).toBe('Opus 4.7 with 1M context · Most capable for complex work');
        expect(def?.isDefault).toBe(true);
        expect(def?.source).toBe('cli');

        const sonnet = models.find(m => m.model === 'sonnet');
        expect(sonnet?.description).toBe('Sonnet 4.6 · Best for everyday tasks');

        expect(def?.efforts?.map(e => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
        expect(def?.efforts?.find(e => e.isDefault)).toBeUndefined();
    });

    it('discovers Claude models from a configured gateway when probes fail', async () => {
        mockProbeResponses({ default: null, sonnet: null, haiku: null });

        const fetchMock = vi.fn(async () => jsonResponse({
            data: [
                { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7' },
                { id: 'anthropic.claude-sonnet-4-6-v1:0', display_name: 'Claude Sonnet 4.6' },
                { id: 'not-claude', display_name: 'Filtered' },
            ],
        }));
        vi.stubGlobal('fetch', fetchMock);

        const models = await claudeModelList({
            env: {
                ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic/',
                ANTHROPIC_AUTH_TOKEN: 'test-token',
            },
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, { headers: Record<string, string> }];
        expect(String(url)).toBe('https://gateway.example.test/anthropic/v1/models?limit=1000');
        expect(init.headers.authorization).toBe('Bearer test-token');
        expect(init.headers['anthropic-version']).toBe('2023-06-01');
        expect(models.map(m => m.model)).toContain('claude-opus-4-7');
        expect(models.map(m => m.model)).toContain('anthropic.claude-sonnet-4-6-v1:0');
        expect(models.map(m => m.model)).not.toContain('not-claude');
    });

    it('falls back to a static 3-row shape when probes and gateway both fail', async () => {
        mockProbeResponses({ default: null, sonnet: null, haiku: null });

        const fetchMock = vi.fn(async () => jsonResponse({ error: 'nope' }, 500));
        vi.stubGlobal('fetch', fetchMock);

        const models = await claudeModelList({
            env: {
                ANTHROPIC_BASE_URL: 'https://gateway.example.test',
            },
        });

        expect(models.map(m => m.model)).toEqual(['default', 'sonnet', 'haiku']);
        expect(models[0].efforts).toBeDefined();
        expect(models[0].source).toBe('builtin');
        expect(models[0].isDefault).toBe(true);
    });

    it('returns the static fallback (still 3 rows) when no probes succeed and no gateway is configured', async () => {
        mockProbeResponses({ default: null, sonnet: null, haiku: null });

        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        const models = await claudeModelList();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(models.map(m => m.model)).toEqual(['default', 'sonnet', 'haiku']);
        expect(models[0].efforts?.length).toBe(6);
    });

    it('returns no guessed effort values when native help discovery fails', async () => {
        mockProbeResponses({
            default: 'claude-opus-4-7',
            sonnet: 'claude-sonnet-4-6',
            haiku: 'claude-haiku-4-5',
        });
        mocks.execFile.mockImplementation((_command, _args, _options, callback) => {
            callback(new Error('claude unavailable'), '', '');
        });

        const models = await claudeModelList();

        expect(models.every((model) => model.efforts?.length === 0)).toBe(true);
    });
});

describe('Claude effort help parser', () => {
    it('extracts future values without a source-code allowlist', () => {
        expect(__testClaudeModelListInternals.parseClaudeEffortsFromHelp([
            '  --effort <level>  Effort level',
            '                    (tiny, regular, enormous)',
            '  --help            Display help',
        ].join('\n'))).toEqual([
            { id: 'tiny', label: 'Tiny' },
            { id: 'regular', label: 'Regular' },
            { id: 'enormous', label: 'Enormous' },
        ]);
    });
});
