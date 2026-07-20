import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { query } from './query';

describe('Claude SDK query arguments', () => {
    it('requests hook lifecycle events only when explicitly enabled', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'boujot-query-args-'));
        const executable = join(directory, 'fake-claude.cjs');
        await writeFile(executable, [
            "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'args', args: process.argv.slice(2) }) + '\\n');",
        ].join('\n'));

        try {
            const invoke = async (includeHookEvents: boolean) => {
                const messages: Array<Record<string, unknown>> = [];
                for await (const message of query({
                    prompt: 'test prompt',
                    options: {
                        cwd: directory,
                        pathToClaudeCodeExecutable: executable,
                        includeHookEvents,
                    },
                })) {
                    messages.push(message);
                }
                return messages[0]?.args as string[];
            };

            expect(await invoke(true)).toContain('--include-hook-events');
            expect(await invoke(false)).not.toContain('--include-hook-events');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
