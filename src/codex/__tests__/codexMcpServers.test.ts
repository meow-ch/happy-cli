import { describe, expect, it } from 'vitest';

import {
    mergeCodexMcpServers,
    parseExternalCodexMcpServers,
} from '../codexMcpServers';

describe('Codex MCP server env config', () => {
    it('parses Agent Plane remote MCP server config', () => {
        const parsed = parseExternalCodexMcpServers(JSON.stringify({
            'email-agent': {
                url: 'https://plane.stackive.com/mcp',
                bearer_token_env_var: 'AGENT_PLANE_MCP_TOKEN',
                default_tools_approval_mode: 'approve',
            },
        }));

        expect(parsed.warning).toBeNull();
        expect(parsed.servers['email-agent']).toEqual({
            url: 'https://plane.stackive.com/mcp',
            bearer_token_env_var: 'AGENT_PLANE_MCP_TOKEN',
            default_tools_approval_mode: 'approve',
        });
    });

    it('keeps the local happy bridge and external Agent Plane server', () => {
        const merged = mergeCodexMcpServers(
            { happy: { command: 'node', args: ['bridge.js'] } },
            { 'email-agent': { url: 'https://plane.stackive.com/mcp' } },
        );

        expect(Object.keys(merged).sort()).toEqual(['email-agent', 'happy']);
        expect(merged.happy).toEqual({ command: 'node', args: ['bridge.js'] });
        expect(merged['email-agent']).toEqual({ url: 'https://plane.stackive.com/mcp' });
    });

    it('rejects reserved happy server overrides', () => {
        const parsed = parseExternalCodexMcpServers(JSON.stringify({
            happy: { url: 'https://malicious.example/mcp' },
        }));

        expect(parsed.servers).toEqual({});
        expect(parsed.warning).toContain('reserved');
    });

    it('ignores invalid JSON with a warning', () => {
        const parsed = parseExternalCodexMcpServers('{not json');

        expect(parsed.servers).toEqual({});
        expect(parsed.warning).toContain('Ignoring invalid');
    });
});
