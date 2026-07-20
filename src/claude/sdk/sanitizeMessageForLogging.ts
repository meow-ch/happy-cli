import type { SDKMessage } from './types'

const SAFE_RESULT_CODE = /^[A-Za-z0-9_.-]{1,80}$/
const SAFE_RESULT_NUMBER_FIELDS = [
    'num_turns',
    'total_cost_usd',
    'duration_ms',
    'duration_api_ms',
    'api_error_status',
] as const
const SAFE_RESULT_CODE_FIELDS = [
    'subtype',
    'terminal_reason',
    'stop_reason',
] as const

/**
 * Return a log-safe representation of a Claude SDK message.
 *
 * Result payloads can contain provider authentication diagnostics and other
 * arbitrary text. Keep only an allowlist of bounded scalar telemetry rather
 * than trying to identify every possible credential format after the fact.
 */
export function sanitizeClaudeMessageForLogging(message: SDKMessage): unknown {
    if (message.type !== 'result') return message

    const sanitized: Record<string, unknown> = {
        type: 'result',
        providerPayloadOmitted: true,
    }

    if (typeof message.is_error === 'boolean') {
        sanitized.is_error = message.is_error
    }

    for (const field of SAFE_RESULT_NUMBER_FIELDS) {
        const value = message[field]
        if (typeof value === 'number' && Number.isFinite(value)) {
            sanitized[field] = value
        }
    }

    for (const field of SAFE_RESULT_CODE_FIELDS) {
        const value = message[field]
        if (value === null && field === 'stop_reason') {
            sanitized[field] = null
        } else if (typeof value === 'string' && SAFE_RESULT_CODE.test(value)) {
            sanitized[field] = value
        }
    }

    return sanitized
}
