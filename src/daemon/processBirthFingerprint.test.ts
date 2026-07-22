import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

import {
  __testProcessBirthFingerprint,
  processBirthFingerprintMatches,
  readProcessBirthFingerprint,
} from './processBirthFingerprint';

describe('process birth fingerprint', () => {
  it('is stable for the same live process incarnation', () => {
    const first = readProcessBirthFingerprint(process.pid);
    const second = readProcessBirthFingerprint(process.pid);

    expect(first).toMatch(/^v1:[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it('distinguishes two simultaneously live process incarnations', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      expect(child.pid).toBeTypeOf('number');
      const parentFingerprint = readProcessBirthFingerprint(process.pid);
      const childFingerprint = readProcessBirthFingerprint(child.pid!);

      expect(childFingerprint).toMatch(/^v1:[a-f0-9]{64}$/);
      expect(childFingerprint).not.toBe(parentFingerprint);
    } finally {
      child.kill('SIGTERM');
    }
  });

  it('fails closed for absent or mismatched identities', () => {
    expect(processBirthFingerprintMatches(undefined, 'v1:observed')).toBe(false);
    expect(processBirthFingerprintMatches('v1:expected', null)).toBe(false);
    expect(processBirthFingerprintMatches('v1:expected', 'v1:other')).toBe(false);
    expect(processBirthFingerprintMatches('v1:expected', 'v1:expected')).toBe(true);
  });

  it('parses Linux stat start ticks after commands containing spaces and parentheses', () => {
    const prefix = '123 (node worker (one))';
    const fieldsThreeThroughTwentyOne = [
      'S', '1', '2', '3', '4', '5', '6', '7', '8', '9',
      '10', '11', '12', '13', '14', '15', '16', '17', '18',
    ];
    const stat = `${prefix} ${fieldsThreeThroughTwentyOne.join(' ')} 987654 20 21`;

    expect(__testProcessBirthFingerprint.linuxStartTicks(stat)).toBe('987654');
  });
});
