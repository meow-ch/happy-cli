import { describe, expect, it } from 'vitest';

import {
    mergeCodexMcpServers,
    parseExternalCodexMcpServers,
    shouldUseBuiltInHappyMcp,
} from '../codexMcpServers';

describe('Codex MCP server env config', () => {
    it('parses external remote MCP server config', () => {
        const parsed = parseExternalCodexMcpServers(JSON.stringify({
            external: {
                url: 'https://tools.example.com/mcp',
                bearer_token_env_var: 'EXTERNAL_MCP_TOKEN',
                default_tools_approval_mode: 'approve',
            },
        }));

        expect(parsed.warning).toBeNull();
        expect(parsed.servers.external).toEqual({
            url: 'https://tools.example.com/mcp',
            bearer_token_env_var: 'EXTERNAL_MCP_TOKEN',
            default_tools_approval_mode: 'approve',
        });
    });

    it('keeps the local happy bridge and external server by default', () => {
        const merged = mergeCodexMcpServers(
            { happy: { command: 'node', args: ['bridge.js'] } },
            { external: { url: 'https://tools.example.com/mcp' } },
        );

        expect(Object.keys(merged).sort()).toEqual(['external', 'happy']);
        expect(merged.happy).toEqual({ command: 'node', args: ['bridge.js'] });
        expect(merged.external).toEqual({ url: 'https://tools.example.com/mcp' });
    });

    it('can disable the local happy bridge for externally owned MCP priming', () => {
        const merged = mergeCodexMcpServers(
            {},
            { external: { url: 'https://tools.example.com/mcp' } },
        );

        expect(Object.keys(merged)).toEqual(['external']);
        expect(merged.external).toEqual({ url: 'https://tools.example.com/mcp' });
    });

    it('defaults built-in happy MCP on unless explicitly disabled', () => {
        expect(shouldUseBuiltInHappyMcp(undefined)).toBe(true);
        expect(shouldUseBuiltInHappyMcp('')).toBe(true);
        expect(shouldUseBuiltInHappyMcp('1')).toBe(true);
        expect(shouldUseBuiltInHappyMcp('true')).toBe(true);
        expect(shouldUseBuiltInHappyMcp('0')).toBe(false);
        expect(shouldUseBuiltInHappyMcp('false')).toBe(false);
        expect(shouldUseBuiltInHappyMcp('no')).toBe(false);
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
