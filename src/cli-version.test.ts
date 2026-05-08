import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('CLI version command', () => {
  it('prints the Boujot/Happy version and exits without starting an agent session', () => {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const entrypoint = join(root, 'dist', 'index.mjs');

    const output = execFileSync(
      process.execPath,
      ['--no-warnings', '--no-deprecation', entrypoint, '--version'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HAPPY_SERVER_URL: process.env.HAPPY_SERVER_URL ?? 'https://server.invalid',
        },
        timeout: 2_000,
      },
    );

    expect(output.trim()).toMatch(/^(happy|boujot) version: \d+\.\d+\.\d+/);
  });
});
