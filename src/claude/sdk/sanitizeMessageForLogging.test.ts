import { describe, expect, it } from 'vitest'

import { sanitizeClaudeMessageForLogging } from './sanitizeMessageForLogging'
import type { SDKMessage } from './types'

describe('sanitizeClaudeMessageForLogging', () => {
    it('omits all arbitrary provider result payloads while retaining safe telemetry', () => {
        const sanitized = sanitizeClaudeMessageForLogging({
            type: 'result',
            subtype: 'success',
            is_error: true,
            terminal_reason: 'api_error',
            stop_reason: null,
            api_error_status: 401,
            num_turns: 0,
            duration_ms: 12,
            duration_api_ms: 0,
            total_cost_usd: 0,
            session_id: 'session-secret',
            result: 'api_key=sk-ant-result-secret',
            error: 'Bearer error-secret',
            errors: ['oauth_token=errors-secret'],
            structured_output: { access_token: 'structured-secret' },
            permission_denials: [{ reason: 'permission-secret' }],
            usage: { input_tokens: 0, output_tokens: 0, secret: 'usage-secret' },
            modelUsage: { model: { secret: 'model-secret' } },
        } as SDKMessage)

        expect(sanitized).toEqual({
            type: 'result',
            providerPayloadOmitted: true,
            is_error: true,
            num_turns: 0,
            total_cost_usd: 0,
            duration_ms: 12,
            duration_api_ms: 0,
            api_error_status: 401,
            subtype: 'success',
            terminal_reason: 'api_error',
            stop_reason: null,
        })
        expect(JSON.stringify(sanitized)).not.toMatch(/secret|token|api_key|Bearer/i)
    })

    it('drops unbounded strings even when they occupy normally safe code fields', () => {
        const sanitized = sanitizeClaudeMessageForLogging({
            type: 'result',
            subtype: 'success api_key=sk-ant-subtype-secret',
            terminal_reason: 'api_error\nBearer terminal-secret',
            stop_reason: 'end_turn; oauth_token=stop-secret',
        })

        expect(sanitized).toEqual({
            type: 'result',
            providerPayloadOmitted: true,
        })
    })
})
