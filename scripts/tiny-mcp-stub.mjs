#!/usr/bin/env node
// Minimal stdio MCP server with a single change_title tool that no-ops.
// Used by probe-codex-elicit.mjs to test codex approval bypass without
// pulling in the full happy daemon plumbing.

import { createInterface } from 'node:readline';

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

const TOOL = {
    name: 'change_title',
    description: 'Change the title of the current chat session',
    inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
    },
};

// Register the same four name aliases as happyMcpStdioBridge.ts:112-118
// so a probe testing prompt-injected names matches as well.
const TOOLS = ['change_title', 'change__title', 'happy__change_title', 'happy__change__title']
    .map((name) => ({ ...TOOL, name }));

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg.method || typeof msg.id !== 'number') return;

    if (msg.method === 'initialize') {
        send({
            jsonrpc: '2.0', id: msg.id,
            result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'tiny-mcp-stub', version: '1.0.0' },
            },
        });
    } else if (msg.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === 'tools/call') {
        const name = msg.params?.name ?? '?';
        process.stderr.write(`[tiny-mcp-stub] tools/call ${name} args=${JSON.stringify(msg.params?.arguments ?? {})}\n`);
        send({
            jsonrpc: '2.0', id: msg.id,
            result: { content: [{ type: 'text', text: 'OK' }] },
        });
    } else {
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
});
