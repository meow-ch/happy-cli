import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

const mockState = vi.hoisted(() => ({
    claudeModelList: vi.fn(),
    codexModelList: vi.fn(),
    codexConnect: vi.fn(),
    codexDisconnect: vi.fn(),
    codexListCollaborationModes: vi.fn(),
    codexListPermissionProfiles: vi.fn(),
    expandEnvironmentVariables: vi.fn(),
    exec: vi.fn(),
}));

vi.mock('child_process', () => ({
    exec: mockState.exec,
}));

vi.mock('@/claude/claudeModelList', () => ({
    claudeModelList: mockState.claudeModelList,
}));

vi.mock('@/codex/codexModelList', () => ({
    codexModelList: mockState.codexModelList,
}));

vi.mock('@/codex/codexAppServerClient', () => ({
    CodexAppServerClient: vi.fn().mockImplementation(() => ({
        connect: mockState.codexConnect,
        disconnect: mockState.codexDisconnect,
        listCollaborationModes: mockState.codexListCollaborationModes,
        listPermissionProfiles: mockState.codexListPermissionProfiles,
    })),
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
        mockState.codexConnect.mockReset();
        mockState.codexDisconnect.mockReset();
        mockState.codexListCollaborationModes.mockReset();
        mockState.codexListPermissionProfiles.mockReset();
        mockState.expandEnvironmentVariables.mockReset();
        mockState.exec.mockReset();
        mockState.exec.mockImplementation((_command: string, _options: unknown, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
            callback?.(null, 'mock-version\n', '');
            return {};
        });
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
        mockState.codexConnect.mockReset();
        mockState.codexDisconnect.mockReset();
        mockState.codexListCollaborationModes.mockReset();
        mockState.codexListPermissionProfiles.mockReset();
        mockState.expandEnvironmentVariables.mockReset();
        mockState.exec.mockReset();
        mockState.exec.mockImplementation((_command: string, _options: unknown, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
            callback?.(null, 'mock-version\n', '');
            return {};
        });
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

describe('registerCommonHandlers agent-capabilities-list', () => {
    beforeEach(() => {
        mockState.claudeModelList.mockReset();
        mockState.codexModelList.mockReset();
        mockState.codexConnect.mockReset();
        mockState.codexDisconnect.mockReset();
        mockState.codexListCollaborationModes.mockReset();
        mockState.codexListPermissionProfiles.mockReset();
        mockState.expandEnvironmentVariables.mockReset();
        mockState.codexConnect.mockResolvedValue(undefined);
        mockState.codexDisconnect.mockResolvedValue(undefined);
        mockState.codexListCollaborationModes.mockResolvedValue([
            { name: 'Default', mode: 'default' },
            { name: 'Plan', mode: 'plan' },
        ]);
        mockState.codexListPermissionProfiles.mockResolvedValue([
            { id: ':read-only' },
            { id: ':workspace' },
            { id: ':danger-full-access' },
        ]);
        mockState.exec.mockReset();
        mockState.exec.mockImplementation((_command: string, _options: unknown, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
            callback?.(null, 'mock-version\n', '');
            return {};
        });
    });

    it('returns provider-neutral Codex capabilities from local model metadata', async () => {
        mockState.codexModelList.mockResolvedValue([{
            model: 'gpt-5.5',
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
                { reasoningEffort: 'low' },
                { reasoningEffort: 'medium' },
            ],
        }]);

        const handler = registerHandlers().get('agent-capabilities-list');
        if (!handler) throw new Error('agent-capabilities-list handler was not registered');
        const result = await handler({ agent: 'codex' });

        expect(result).toMatchObject({
            success: true,
            capabilities: [{
                provider: 'codex',
                defaultModel: 'gpt-5.5',
                runtimeModes: ['default', 'plan'],
                reasoningEfforts: ['low', 'medium'],
                defaultReasoningEffort: 'medium',
                accessModes: ['read-only', 'workspace-write', 'danger-full-access'],
                codexCollaborationModes: ['default', 'plan'],
                codexPermissionProfiles: [':read-only', ':workspace', ':danger-full-access'],
                permissionModes: ['default', 'plan', 'read-only', 'safe-yolo', 'yolo', 'acceptEdits', 'bypassPermissions'],
                approvalPolicies: ['untrusted', 'on-request', 'on-failure', 'never'],
                sandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
                supportsPlanMode: true,
                supportsTurnInterrupt: true,
                supportsApprovalRequests: true,
            }],
        });
    });

    it('returns Claude plan-mode support and model efforts', async () => {
        mockState.claudeModelList.mockResolvedValue([{
            model: 'default',
            isDefault: true,
            efforts: [
                { id: 'low' },
                { id: 'xhigh', isDefault: true },
            ],
        }]);

        const handler = registerHandlers().get('agent-capabilities-list');
        if (!handler) throw new Error('agent-capabilities-list handler was not registered');
        const result = await handler({ agent: 'claude' });

        expect(result).toMatchObject({
            success: true,
            capabilities: [{
                provider: 'claude',
                defaultModel: 'default',
                runtimeModes: ['default', 'plan'],
                reasoningEfforts: ['low', 'xhigh'],
                defaultReasoningEffort: 'xhigh',
                claudePermissionModes: ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk'],
                permissionModes: ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan'],
                supportsPlanMode: true,
                supportsTurnInterrupt: true,
                supportsApprovalRequests: true,
            }],
        });
    });
});
