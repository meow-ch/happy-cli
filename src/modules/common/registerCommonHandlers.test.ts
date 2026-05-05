import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

const mockState = vi.hoisted(() => ({
    claudeModelList: vi.fn(),
    codexModelList: vi.fn(),
    expandEnvironmentVariables: vi.fn(),
}));

vi.mock('@/claude/claudeModelList', () => ({
    claudeModelList: mockState.claudeModelList,
}));

vi.mock('@/codex/codexModelList', () => ({
    codexModelList: mockState.codexModelList,
}));

vi.mock('@/utils/expandEnvVars', () => ({
    expandEnvironmentVariables: mockState.expandEnvironmentVariables,
}));

import { registerCommonHandlers } from './registerCommonHandlers';

type Handler = (params: unknown) => Promise<unknown>;

function registerHandlers() {
    const handlers = new Map<string, Handler>();
    const manager = {
        registerHandler: vi.fn((method: string, handler: Handler) => {
            handlers.set(method, handler);
        }),
    } as unknown as RpcHandlerManager;

    registerCommonHandlers(manager, process.cwd());

    return handlers;
}

describe('registerCommonHandlers codex-models-list', () => {
    beforeEach(() => {
        mockState.claudeModelList.mockReset();
        mockState.codexModelList.mockReset();
        mockState.expandEnvironmentVariables.mockReset();
    });

    it('expands profile environment variables before listing Codex models', async () => {
        const expandedEnv = { OPENAI_API_KEY: 'expanded-key' };
        mockState.expandEnvironmentVariables.mockReturnValue(expandedEnv);
        mockState.codexModelList.mockResolvedValue([{ model: 'gpt-5.5' }]);

        const handler = registerHandlers().get('codex-models-list');
        if (!handler) throw new Error('codex-models-list handler was not registered');
        const result = await handler({
            environmentVariables: { OPENAI_API_KEY: '${OPENAI_API_KEY}' },
        });

        expect(mockState.expandEnvironmentVariables).toHaveBeenCalledWith(
            { OPENAI_API_KEY: '${OPENAI_API_KEY}' },
            process.env
        );
        expect(mockState.codexModelList).toHaveBeenCalledWith({
            timeoutMs: 10_000,
            env: expandedEnv,
        });
        expect(result).toEqual({
            success: true,
            models: [{ model: 'gpt-5.5' }],
        });
    });

    it('preserves the existing no-profile behavior', async () => {
        mockState.codexModelList.mockResolvedValue([{ model: 'gpt-5.4' }]);

        const handler = registerHandlers().get('codex-models-list');
        if (!handler) throw new Error('codex-models-list handler was not registered');
        const result = await handler({});

        expect(mockState.expandEnvironmentVariables).not.toHaveBeenCalled();
        expect(mockState.codexModelList).toHaveBeenCalledWith({
            timeoutMs: 10_000,
            env: undefined,
        });
        expect(result).toEqual({
            success: true,
            models: [{ model: 'gpt-5.4' }],
        });
    });
});

describe('registerCommonHandlers claude-models-list', () => {
    beforeEach(() => {
        mockState.claudeModelList.mockReset();
        mockState.codexModelList.mockReset();
        mockState.expandEnvironmentVariables.mockReset();
    });

    it('expands profile environment variables before listing Claude models', async () => {
        const expandedEnv = { ANTHROPIC_AUTH_TOKEN: 'expanded-key' };
        mockState.expandEnvironmentVariables.mockReturnValue(expandedEnv);
        mockState.claudeModelList.mockResolvedValue([{ model: 'claude-opus-4-7' }]);

        const handler = registerHandlers().get('claude-models-list');
        if (!handler) throw new Error('claude-models-list handler was not registered');
        const result = await handler({
            environmentVariables: { ANTHROPIC_AUTH_TOKEN: '${ANTHROPIC_AUTH_TOKEN}' },
        });

        expect(mockState.expandEnvironmentVariables).toHaveBeenCalledWith(
            { ANTHROPIC_AUTH_TOKEN: '${ANTHROPIC_AUTH_TOKEN}' },
            process.env
        );
        expect(mockState.claudeModelList).toHaveBeenCalledWith({
            timeoutMs: 10_000,
            env: expandedEnv,
        });
        expect(result).toEqual({
            success: true,
            models: [{ model: 'claude-opus-4-7' }],
        });
    });

    it('preserves the existing no-profile behavior', async () => {
        mockState.claudeModelList.mockResolvedValue([{ model: 'sonnet' }]);

        const handler = registerHandlers().get('claude-models-list');
        if (!handler) throw new Error('claude-models-list handler was not registered');
        const result = await handler({});

        expect(mockState.expandEnvironmentVariables).not.toHaveBeenCalled();
        expect(mockState.claudeModelList).toHaveBeenCalledWith({
            timeoutMs: 10_000,
            env: undefined,
        });
        expect(result).toEqual({
            success: true,
            models: [{ model: 'sonnet' }],
        });
    });
});
