import { describe, expect, it } from 'vitest';

import { __testCodexAppServerClientInternals } from '../codexAppServerClient';

describe('Codex app-server plan normalization', () => {
    it('normalizes plan steps and builds display text from native plan parts', () => {
        const steps = __testCodexAppServerClientInternals.normalizePlanSteps([
            { step: 'Inspect the code', status: 'complete' },
            { step: 'Patch the UI', status: 'pending' },
            { step: '' },
            null,
        ]);

        expect(steps).toEqual([
            { step: 'Inspect the code', status: 'complete' },
            { step: 'Patch the UI', status: 'pending' },
        ]);
        expect(__testCodexAppServerClientInternals.planTextFromParts('Need two actions.', steps))
            .toBe('Need two actions.\n\n- Inspect the code\n- Patch the UI');
    });
});

describe('Codex app-server turn lifecycle normalization', () => {
    it('maps native turn completions to provider-neutral task lifecycle events', () => {
        expect(__testCodexAppServerClientInternals.turnLifecycleEventFromCompletion({
            turn: { id: 'turn_complete_1', status: 'completed' },
        })).toEqual({ type: 'task_complete', turn_id: 'turn_complete_1' });

        expect(__testCodexAppServerClientInternals.turnLifecycleEventFromCompletion({
            turn: { id: 'turn_abort_1', status: 'interrupted' },
        })).toEqual({ type: 'turn_aborted', turn_id: 'turn_abort_1' });

        expect(__testCodexAppServerClientInternals.turnLifecycleEventFromCompletion({
            turn: { status: 'completed' },
        })).toEqual({ type: 'task_complete' });
    });

    it('maps failed turns to one structured terminal failure', () => {
        expect(__testCodexAppServerClientInternals.turnLifecycleEventFromCompletion({
            turn: {
                id: 'turn_failed_1',
                status: 'failed',
                error: {
                    error: {
                        message: "Invalid value: 'max'. Supported values are: 'low' and 'high'.",
                        code: 'invalid_value',
                        param: 'reasoning.effort',
                    },
                    status: 400,
                },
            },
        })).toEqual({
            type: 'task_failed',
            turn_id: 'turn_failed_1',
            message: "Invalid value: 'max'. Supported values are: 'low' and 'high'.",
            code: 'invalid_value',
            param: 'reasoning.effort',
            status: 400,
        });
    });
});

describe('Codex app-server MCP tool lifecycle normalization', () => {
    const item = {
        type: 'mcpToolCall',
        id: 'call_123',
        server: 'agent-plane',
        tool: 'billing_create_recurring_document',
        arguments: { period: '2026-07' },
        status: 'completed',
        durationMs: 41_250,
        result: { structuredContent: { artifact_id: 'art_123' } },
    };

    it('maps native MCP starts to tool activity', () => {
        expect(__testCodexAppServerClientInternals.mcpToolLifecycleEvent(item, 'started')).toEqual({
            type: 'mcp_tool_call_begin',
            call_id: 'call_123',
            server: 'agent-plane',
            tool: 'billing_create_recurring_document',
            arguments: { period: '2026-07' },
        });
    });

    it('maps native MCP completions with their result', () => {
        expect(__testCodexAppServerClientInternals.mcpToolLifecycleEvent(item, 'completed')).toEqual({
            type: 'mcp_tool_call_end',
            call_id: 'call_123',
            server: 'agent-plane',
            tool: 'billing_create_recurring_document',
            status: 'completed',
            duration_ms: 41_250,
            result: { structuredContent: { artifact_id: 'art_123' } },
        });
    });

    it('rejects malformed MCP items instead of emitting ambiguous activity', () => {
        expect(__testCodexAppServerClientInternals.mcpToolLifecycleEvent({
            type: 'mcpToolCall',
            id: 'call_without_tool',
        }, 'started')).toBeNull();
    });
});

describe('Codex app-server error normalization', () => {
    it('extracts nested provider details without coercing objects to strings', () => {
        expect(__testCodexAppServerClientInternals.normalizeCodexFailure({
            type: 'error',
            error: {
                type: 'invalid_request_error',
                code: 'invalid_value',
                message: "Invalid value: 'max'.",
                param: 'reasoning.effort',
            },
            status: 400,
        })).toEqual({
            message: "Invalid value: 'max'.",
            code: 'invalid_value',
            param: 'reasoning.effort',
            status: 400,
        });
    });

    it('parses JSON-encoded additional details', () => {
        expect(__testCodexAppServerClientInternals.normalizeCodexFailure({
            additionalDetails: JSON.stringify({
                error: { message: 'Upstream rejected the turn', code: 'upstream_error' },
                status: 502,
            }),
        })).toEqual({
            message: 'Upstream rejected the turn',
            code: 'upstream_error',
            status: 502,
        });
    });
});
