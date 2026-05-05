import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeModelList } from '../claudeModelList';

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
        text: vi.fn(async () => JSON.stringify(body)),
    };
}

describe('claudeModelList', () => {
    beforeEach(() => {
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

    it('returns Claude Code aliases and pinned profile models without a gateway', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        const models = await claudeModelList({
            env: {
                ANTHROPIC_MODEL: 'GLM-4.6',
                ANTHROPIC_SMALL_FAST_MODEL: 'GLM-4.5-Air',
                ANTHROPIC_DEFAULT_SONNET_MODEL: 'GLM-4.6',
            },
        });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(models.map(m => m.model)).toEqual([
            'default',
            'opus',
            'sonnet',
            'haiku',
            'GLM-4.6',
            'GLM-4.5-Air',
        ]);
        expect(models.find(m => m.model === 'default')?.description).toContain('GLM-4.6');
        expect(models.find(m => m.model === 'sonnet')?.description).toContain('GLM-4.6');
    });

    it('discovers Claude models from an Anthropic-compatible gateway', async () => {
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

    it('falls back to aliases when gateway discovery fails', async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ error: 'nope' }, 500));
        vi.stubGlobal('fetch', fetchMock);

        const models = await claudeModelList({
            env: {
                ANTHROPIC_BASE_URL: 'https://gateway.example.test',
                ANTHROPIC_CUSTOM_MODEL_OPTION: 'custom-claude-model',
            },
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(models.map(m => m.model)).toEqual([
            'default',
            'opus',
            'sonnet',
            'haiku',
            'custom-claude-model',
        ]);
    });
});
