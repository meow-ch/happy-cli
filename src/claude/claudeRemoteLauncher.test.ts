import { describe, expect, it } from 'vitest';
import type { SDKResultMessage } from './sdk';

import { claudeRemote, __testClaudeRemoteInternals } from './claudeRemote';
import { __testClaudeRemoteLauncherInternals } from './claudeRemoteLauncher';
import { __testRunClaudeInternals } from './runClaude';

describe('Claude plan extraction', () => {
    it('extracts plan text from native ExitPlanMode tool input shapes', () => {
        expect(__testClaudeRemoteLauncherInternals.extractClaudePlanText({
            plan: 'Read the code, then patch it.',
        })).toBe('Read the code, then patch it.');

        expect(__testClaudeRemoteLauncherInternals.extractClaudePlanText([
            { text: 'First step.' },
            { message: 'Second step.' },
        ])).toBe('First step.\n\nSecond step.');

        expect(__testClaudeRemoteLauncherInternals.extractClaudePlanText({
            actions: ['fallback'],
        })).toBe('{\n  "actions": [\n    "fallback"\n  ]\n}');
    });
});

function resultMessage(overrides: Partial<SDKResultMessage> = {}): SDKResultMessage {
    return {
        type: 'result',
        subtype: 'success',
        result: 'Finished safely.',
        num_turns: 1,
        total_cost_usd: 0.01,
        duration_ms: 100,
        duration_api_ms: 90,
        is_error: false,
        session_id: 'claude_session_test',
        ...overrides,
    };
}

describe('Claude authoritative terminal normalization', () => {
    const normalize = __testClaudeRemoteLauncherInternals.normalizeClaudeResultTerminal;

    it('emits a versioned ACP success with a bounded fallback result', () => {
        expect(normalize({
            result: resultMessage(),
            turnId: 'turn_success',
            terminalProtocol: 1,
            assistantStopReason: 'end_turn',
        })).toEqual({
            type: 'task_complete',
            id: 'turn_success',
            terminal_protocol: 1,
            subtype: 'success',
            reason: 'end_turn',
            is_error: false,
            result: 'Finished safely.',
        });
    });

    it('does not let subtype=success hide an is_error API failure', () => {
        expect(normalize({
            result: resultMessage({
                subtype: 'success',
                is_error: true,
                terminal_reason: 'api_error',
                result: 'API Error: upstream connection closed',
            }),
            turnId: 'turn_api_error',
            terminalProtocol: 1,
            assistantStopReason: 'max_tokens',
        })).toEqual({
            type: 'task_failed',
            id: 'turn_api_error',
            terminal_protocol: 1,
            subtype: 'success',
            reason: 'api_error',
            is_error: true,
            code: 'api_error',
            message: 'Claude reported an API error before completing the turn.',
            result: 'API Error: upstream connection closed',
        });
    });

    it('fails closed on authoritative result.stop_reason=max_tokens while retaining partial output only as result', () => {
        expect(normalize({
            result: resultMessage({
                terminal_reason: 'completed',
                stop_reason: 'max_tokens',
                result: "I'll publish the artifact next…",
            }),
            turnId: 'turn_result_max_tokens',
            terminalProtocol: 1,
            assistantStopReason: null,
        })).toEqual({
            type: 'task_failed',
            id: 'turn_result_max_tokens',
            terminal_protocol: 1,
            subtype: 'success',
            reason: 'max_tokens',
            is_error: true,
            code: 'max_tokens',
            message: 'Claude reached its output token limit before completing the turn.',
            result: "I'll publish the artifact next…",
        });
    });

    it('fails closed when a nominal success omits the runtime is_error attestation', () => {
        const malformed = {
            ...resultMessage(),
            terminal_reason: 'completed',
        } as Partial<SDKResultMessage>;
        delete malformed.is_error;

        expect(normalize({
            result: malformed as SDKResultMessage,
            turnId: 'turn_missing_is_error',
            terminalProtocol: 1,
        })).toEqual({
            type: 'task_failed',
            id: 'turn_missing_is_error',
            terminal_protocol: 1,
            subtype: 'success',
            reason: 'invalid_is_error',
            is_error: true,
            code: 'invalid_is_error',
            message: 'Claude result did not explicitly attest is_error=false; the turn was treated as failed.',
            result: 'Finished safely.',
        });
    });

    it('fails a nominally successful result after max_tokens', () => {
        const terminal = normalize({
            result: resultMessage({ result: undefined }),
            turnId: 'turn_max_tokens',
            terminalProtocol: 1,
            assistantStopReason: 'max_tokens',
        });

        expect(terminal).toMatchObject({
            type: 'task_failed',
            id: 'turn_max_tokens',
            terminal_protocol: 1,
            subtype: 'success',
            reason: 'max_tokens',
            is_error: true,
            code: 'max_tokens',
        });
        expect(terminal.type === 'task_failed' ? terminal.message : '').toContain('output token limit');
    });

    it('fails success when the provider terminates with unresolved tool calls', () => {
        expect(normalize({
            result: resultMessage({ result: undefined }),
            turnId: 'turn_pending_tool',
            terminalProtocol: 1,
            assistantStopReason: 'end_turn',
            pendingToolCallCount: 1,
        })).toMatchObject({
            type: 'task_failed',
            reason: 'pending_tool_calls',
            is_error: true,
        });
    });

    it('normalizes a no-result abort as an explicit v1 turn_aborted terminal', () => {
        expect(__testClaudeRemoteLauncherInternals.normalizeClaudeExitTerminal({
            turn: { id: 'turn_abort', terminalProtocol: 1 },
            kind: 'aborted',
            reason: 'user_abort',
        })).toEqual({
            type: 'turn_aborted',
            id: 'turn_abort',
            terminal_protocol: 1,
            subtype: 'aborted',
            reason: 'user_abort',
            is_error: true,
        });
    });

    it('normalizes a no-result provider exit as an explicit v1 failure', () => {
        expect(__testClaudeRemoteLauncherInternals.normalizeClaudeExitTerminal({
            turn: { id: 'turn_exit', terminalProtocol: 1 },
            kind: 'failed',
            reason: 'claude_runtime_error',
            message: 'provider process exited',
        })).toEqual({
            type: 'task_failed',
            id: 'turn_exit',
            terminal_protocol: 1,
            subtype: 'error',
            reason: 'claude_runtime_error',
            is_error: true,
            code: 'claude_runtime_error',
            message: 'provider process exited',
        });
    });

    it('enqueues and flushes synthetic tool results before terminal, then emits legacy ready', async () => {
        const order: string[] = [];
        await __testClaudeRemoteLauncherInternals.emitClaudeTerminalAfterToolCleanup({
            pendingToolCalls: ['tool_a', 'tool_b'],
            interruptedResult: (toolId) => ({ toolId } as never),
            enqueueInterruptedResult: (result) => {
                order.push(`enqueue:${String((result as unknown as { toolId: string }).toolId)}`);
            },
            flushQueuedOutput: async () => {
                order.push('flush');
            },
            emitTerminal: () => {
                order.push('terminal');
            },
            emitLegacyReady: () => {
                order.push('ready');
            },
        });

        expect(order).toEqual(['enqueue:tool_a', 'enqueue:tool_b', 'flush', 'terminal', 'ready']);
    });
});

describe('Claude authoritative turn correlation', () => {
    it('uses the durable prompt local id as the ACP turn id', () => {
        expect(__testClaudeRemoteInternals.createClaudeTurn({
            permissionMode: 'default',
            terminalProtocol: 1,
            promptLocalId: 'prompt_local_123',
        })).toEqual({
            id: 'prompt_local_123',
            terminalProtocol: 1,
        });
    });

    it('uses a random id only for a legacy prompt without a durable local id', () => {
        const turn = __testClaudeRemoteInternals.createClaudeTurn({
            permissionMode: 'default',
        });

        expect(turn.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        expect(turn.terminalProtocol).toBeUndefined();
    });
});

describe('Claude local command terminals', () => {
    it('emits a correlated start and success terminal for /clear without querying the SDK', async () => {
        const order: string[] = [];
        const turns: Array<{ id: string; terminalProtocol?: 1 }> = [];

        await claudeRemote({
            sessionId: 'claude_session_clear',
            path: '/tmp',
            allowedTools: [],
            hookSettingsPath: '/tmp/unused-settings.json',
            canCallTool: async () => ({ behavior: 'deny', message: 'unused' }),
            nextMessage: async () => ({
                message: '/clear',
                mode: {
                    permissionMode: 'default',
                    terminalProtocol: 1,
                    promptLocalId: 'prompt_clear_123',
                },
            }),
            onTurnStarted: (turn) => {
                turns.push(turn);
                order.push('started');
            },
            onResult: (result, turn) => {
                expect(turn).toEqual(turns[0]);
                expect(result).toMatchObject({
                    type: 'result',
                    subtype: 'success',
                    terminal_reason: 'completed',
                    result: 'Context was reset.',
                    is_error: false,
                });
                order.push('terminal');
            },
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: () => {
                throw new Error('/clear must not query or stream SDK output');
            },
            onSessionReset: () => order.push('reset'),
        });

        expect(turns).toEqual([{ id: 'prompt_clear_123', terminalProtocol: 1 }]);
        expect(order).toEqual(['started', 'reset', 'terminal']);
    });
});

describe('Claude top-level stop reason tracking', () => {
    const nextReason = __testClaudeRemoteLauncherInternals.nextTopLevelAssistantStopReason;

    it('ignores incomplete sidechain stop reasons', () => {
        expect(nextReason('end_turn', {
            type: 'assistant',
            parent_tool_use_id: 'parent_tool',
            message: {
                role: 'assistant',
                stop_reason: 'max_tokens',
                content: [],
            },
        })).toBe('end_turn');
    });

    it('captures an incomplete top-level stop reason as a fail-closed fallback', () => {
        expect(nextReason(null, {
            type: 'assistant',
            message: {
                role: 'assistant',
                stop_reason: 'max_tokens',
                content: [],
            },
        })).toBe('max_tokens');
    });
});

describe('Claude prompt batching compatibility', () => {
    const modeHash = __testRunClaudeInternals.hashClaudeMessageQueueMode;

    it('retains legacy same-mode batching despite injected prompt local ids', () => {
        const first = modeHash({
            permissionMode: 'default',
            promptLocalId: 'legacy_prompt_a',
        });
        const second = modeHash({
            permissionMode: 'default',
            promptLocalId: 'legacy_prompt_b',
        });

        expect(first).toBe(second);
    });

    it('isolates protocol-v1 prompts by durable prompt local id', () => {
        const first = modeHash({
            permissionMode: 'default',
            terminalProtocol: 1,
            promptLocalId: 'v1_prompt_a',
        });
        const second = modeHash({
            permissionMode: 'default',
            terminalProtocol: 1,
            promptLocalId: 'v1_prompt_b',
        });

        expect(first).not.toBe(second);
    });
});
