import { describe, expect, it } from 'vitest';

import { probeClaudeAuthReadiness } from './claudeAuthReadiness';

describe('Claude provider readiness', () => {
    it('reports locally authenticated Claude without returning unrecognized fields', async () => {
        const readiness = await probeClaudeAuthReadiness({
            now: () => 1_234,
            env: { CLAUDE_CODE_OAUTH_TOKEN: 'must-not-be-returned' },
            runAuthStatus: async (env, timeoutMs) => {
                expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('must-not-be-returned');
                expect(timeoutMs).toBe(5_000);
                return {
                    kind: 'completed',
                    exitCode: 0,
                    stdout: JSON.stringify({
                        loggedIn: true,
                        authMethod: 'oauth_token',
                        apiProvider: 'firstParty',
                        apiKeySource: 'CLAUDE_CODE_OAUTH_TOKEN',
                        futureCredentialField: 'must-not-be-returned',
                    }),
                };
            },
        });

        expect(readiness).toEqual({
            type: 'provider-readiness',
            provider: 'claude',
            checkedAt: 1_234,
            ready: true,
            executable: { status: 'ready' },
            authentication: {
                status: 'ready',
                verification: 'claude_auth_status',
                reason: 'authenticated',
                authMethod: 'oauth_token',
                apiProvider: 'firstParty',
            },
        });
        expect(JSON.stringify(readiness)).not.toContain('must-not-be-returned');
        expect(JSON.stringify(readiness)).not.toContain('apiKeySource');
    });

    it('distinguishes an installed but logged-out Claude CLI', async () => {
        await expect(probeClaudeAuthReadiness({
            now: () => 2_345,
            runAuthStatus: async () => ({
                kind: 'completed',
                // Claude uses exit code 1 for a valid logged-out status.
                exitCode: 1,
                stdout: JSON.stringify({
                    loggedIn: false,
                    authMethod: 'none',
                    apiProvider: 'firstParty',
                }),
            }),
        })).resolves.toEqual({
            type: 'provider-readiness',
            provider: 'claude',
            checkedAt: 2_345,
            ready: false,
            executable: { status: 'ready' },
            authentication: {
                status: 'required',
                verification: 'claude_auth_status',
                reason: 'authentication_required',
                authMethod: 'none',
                apiProvider: 'firstParty',
            },
        });
    });

    it('fails closed when the executable is missing or output is malformed', async () => {
        const missing = await probeClaudeAuthReadiness({
            now: () => 3_456,
            runAuthStatus: async () => ({ kind: 'missing' }),
        });
        expect(missing).toMatchObject({
            ready: false,
            executable: { status: 'missing' },
            authentication: { status: 'unknown', reason: 'probe_failed' },
        });

        const malformed = await probeClaudeAuthReadiness({
            now: () => 4_567,
            runAuthStatus: async () => ({
                kind: 'completed',
                exitCode: 0,
                stdout: '{not-json',
            }),
        });
        expect(malformed).toMatchObject({
            ready: false,
            executable: { status: 'unknown' },
            authentication: { status: 'unknown', reason: 'invalid_response' },
        });
    });

    it('does not relay arbitrary strings from Claude auth output', async () => {
        const readiness = await probeClaudeAuthReadiness({
            runAuthStatus: async () => ({
                kind: 'completed',
                exitCode: 0,
                stdout: JSON.stringify({
                    loggedIn: true,
                    authMethod: 'Bearer secret-value',
                    apiProvider: 'provider\nsecret-value',
                }),
            }),
        });
        expect(readiness.ready).toBe(true);
        expect(readiness.authentication).not.toHaveProperty('authMethod');
        expect(readiness.authentication).not.toHaveProperty('apiProvider');
    });
});
