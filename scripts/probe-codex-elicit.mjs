#!/usr/bin/env node
// Self-test harness for codex 0.128 mcp_tool_call_approval bypass attempts.
//
// Spawns `codex mcp-server`, opens a session with a prompt that forces the
// model to call our happy MCP server's change_title tool, and reports whether
// the elicitation gets bypassed (task_complete with an agent_message) or hangs
// (no completion within timeout).
//
// Usage:
//   node scripts/probe-codex-elicit.mjs
//
// Exits 0 on success (bypass works), 1 on hang/error (bypass fails).

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// Per-MCP-server config knob to test. Codex told us the valid values are
// `auto`, `prompt`, `approve` — try them in turn.
const APPROVAL_MODE = process.argv[2] ?? 'auto';
const APPROVAL_POLICY = process.argv[3] ?? 'never';
const TIMEOUT_MS = 30_000;

const TITLE_INSTRUCTION =
    'Then call the MCP tool `mcp__happy__change__title` ' +
    '(or `mcp__happy__change_title` if that is what you see) ' +
    'with JSON: {"title": "Probe Test Title"}.';

console.log('--- probe config ---');
console.log('default_tools_approval_mode:', APPROVAL_MODE);
console.log('approval-policy:', APPROVAL_POLICY);
console.log();

// Minimal MCP stdio server that just registers change_title and returns a
// no-op. Lets the probe run without depending on the daemon's HTTP bridge.
const TINY_MCP_SCRIPT = join(REPO_ROOT, 'scripts', 'tiny-mcp-stub.mjs');

const codex = spawn('codex', ['mcp-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
});

let stderrBuf = '';
codex.stderr.on('data', (d) => { stderrBuf += d.toString(); });

const pending = new Map();
let nextId = 1;

const send = (req) => codex.stdin.write(JSON.stringify(req) + '\n');

const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
});

let elicitationSeen = false;
let agentMessageSeen = null;
let taskCompleteSeen = false;

const rl = createInterface({ input: codex.stdout, crlfDelay: Infinity });
rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    // Handle responses
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? 'rpc error'));
        else p.resolve(msg.result);
        return;
    }

    // Handle notifications. Codex emits codex/event with msg payloads.
    if (msg.method === 'codex/event' && msg.params?.msg) {
        const ev = msg.params.msg;
        if (ev.type === 'elicitation_request') {
            elicitationSeen = true;
            console.log('[event] elicitation_request kind=' +
                (ev.request?._meta?.codex_approval_kind ?? '?') + ' tool=' +
                (ev.request?._meta?.tool_title ?? '?'));
        } else if (ev.type === 'agent_message') {
            agentMessageSeen = ev.message;
            console.log('[event] agent_message:', JSON.stringify(ev.message).slice(0, 80));
        } else if (ev.type === 'task_complete') {
            taskCompleteSeen = true;
            console.log('[event] task_complete in ' + ev.duration_ms + 'ms');
        } else if (ev.type === 'mcp_tool_call_begin') {
            console.log('[event] mcp_tool_call_begin tool=' + ev.invocation?.tool);
        } else if (ev.type === 'mcp_tool_call_end') {
            console.log('[event] mcp_tool_call_end ok=' + (ev.success ?? '?'));
        } else if (ev.type === 'task_started') {
            console.log('[event] task_started turn=' + ev.turn_id);
        }
    }
});

(async () => {
    try {
        await call('initialize', {
            protocolVersion: '2024-11-05',
            clientInfo: { name: 'probe', version: '1' },
            capabilities: { elicitation: {} },
        });

        const sessionConfig = {
            prompt: 'Reply with exactly the word PONG. ' + TITLE_INSTRUCTION,
            sandbox: 'workspace-write',
            'approval-policy': APPROVAL_POLICY,
            model: 'gpt-5.5',
            config: {
                mcp_servers: {
                    happy: {
                        command: process.execPath,
                        args: [TINY_MCP_SCRIPT],
                        default_tools_approval_mode: APPROVAL_MODE,
                    },
                },
            },
        };

        const startPromise = call('tools/call', {
            name: 'codex',
            arguments: sessionConfig,
        });

        // Wait for either task_complete or timeout.
        const deadline = Date.now() + TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (taskCompleteSeen) break;
            await new Promise(r => setTimeout(r, 250));
        }

        if (!taskCompleteSeen) {
            console.log('--- HUNG (no task_complete in ' + TIMEOUT_MS + 'ms) ---');
            console.log('elicitation seen:', elicitationSeen);
            console.log('codex stderr (last 500):', stderrBuf.slice(-500));
            codex.kill('SIGTERM');
            process.exit(1);
        }

        try {
            const result = await Promise.race([
                startPromise,
                new Promise((_, rej) => setTimeout(() => rej(new Error('startPromise timeout')), 2_000)),
            ]);
            const text = result?.content?.[0]?.text ?? '<no content>';
            console.log('--- SUCCESS ---');
            console.log('content:', text.slice(0, 200));
            console.log('elicitation seen:', elicitationSeen);
            console.log('agent_message:', agentMessageSeen?.slice(0, 80));
        } catch (e) {
            console.log('--- task_complete fired but startPromise:', e.message);
        }

        codex.kill('SIGTERM');
        process.exit(0);
    } catch (e) {
        console.error('--- ERROR ---', e.message);
        console.error('codex stderr (last 500):', stderrBuf.slice(-500));
        codex.kill('SIGTERM');
        process.exit(1);
    }
})();
