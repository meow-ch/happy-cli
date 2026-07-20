import { describe, expect, it, vi } from 'vitest';

import { buildAgentEnvironment } from './agentEnvironment';

describe('daemon agent environment construction', () => {
    it('preserves legacy replacement behavior when mode is omitted', async () => {
        const loadLocalProfileEnvironment = vi.fn(async () => ({
            ANTHROPIC_AUTH_TOKEN: 'local-profile-token',
            LOCAL_ONLY: 'yes',
        }));

        const built = await buildAgentEnvironment({
            agent: 'claude',
            environmentVariables: {
                MCP_TIMEOUT: '30000',
            },
            processEnvironment: { PATH: '/bin' },
            loadLocalProfileEnvironment,
            logExpansion: false,
        });

        expect(loadLocalProfileEnvironment).not.toHaveBeenCalled();
        expect(built.profileSource).toBe('request');
        expect(built.extraEnvironmentVariables).toEqual({ MCP_TIMEOUT: '30000' });
        expect(built.effectiveEnvironment).toEqual({ PATH: '/bin', MCP_TIMEOUT: '30000' });
    });

    it('overlays per-call values on the active local profile with auth last', async () => {
        const loadLocalProfileEnvironment = vi.fn(async () => ({
            ANTHROPIC_AUTH_TOKEN: '${LOCAL_ANTHROPIC_TOKEN}',
            CLAUDE_CODE_OAUTH_TOKEN: 'local-oauth-token',
            MCP_TIMEOUT: '5000',
            LOCAL_ONLY: 'yes',
        }));

        const options = {
            agent: 'claude' as const,
            environmentVariablesMode: 'overlay' as const,
            environmentVariables: {
                MCP_TIMEOUT: '30000',
                CLAUDE_CODE_OAUTH_TOKEN: 'request-oauth-token',
            },
            authenticationEnvironmentVariables: {
                CLAUDE_CODE_OAUTH_TOKEN: 'explicit-oauth-token',
            },
            processEnvironment: {
                PATH: '/bin',
                LOCAL_ANTHROPIC_TOKEN: 'expanded-anthropic-token',
            },
            loadLocalProfileEnvironment,
            logExpansion: false,
        };

        // Readiness and spawn call this same builder independently. Identical
        // inputs must therefore produce the same credential-bearing process
        // environment.
        const readinessEnvironment = await buildAgentEnvironment(options);
        const spawnEnvironment = await buildAgentEnvironment(options);

        expect(loadLocalProfileEnvironment).toHaveBeenCalledTimes(2);
        expect(readinessEnvironment).toEqual(spawnEnvironment);
        expect(readinessEnvironment.profileSource).toBe('local_overlay');
        expect(readinessEnvironment.extraEnvironmentVariables).toEqual({
            ANTHROPIC_AUTH_TOKEN: 'expanded-anthropic-token',
            CLAUDE_CODE_OAUTH_TOKEN: 'explicit-oauth-token',
            MCP_TIMEOUT: '30000',
            LOCAL_ONLY: 'yes',
        });
    });

    it('loads the local profile for an omitted or empty replacement environment', async () => {
        const loadLocalProfileEnvironment = vi.fn(async () => ({
            ANTHROPIC_AUTH_TOKEN: 'local-profile-token',
        }));

        const built = await buildAgentEnvironment({
            agent: 'claude',
            environmentVariables: {},
            environmentVariablesMode: 'replace',
            processEnvironment: {},
            loadLocalProfileEnvironment,
            logExpansion: false,
        });

        expect(loadLocalProfileEnvironment).toHaveBeenCalledOnce();
        expect(built.profileSource).toBe('local');
        expect(built.extraEnvironmentVariables).toEqual({
            ANTHROPIC_AUTH_TOKEN: 'local-profile-token',
        });
    });
});
