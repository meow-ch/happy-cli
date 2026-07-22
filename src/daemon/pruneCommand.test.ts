import { describe, expect, it } from 'vitest';
import { parseDaemonPruneArguments } from './pruneCommand';
import { LEGACY_PRUNE_SAFETY_ATTESTATION } from './sessionPruning';

describe('daemon prune-sessions CLI arguments', () => {
  it('is a dry-run unless apply is explicit', () => {
    expect(parseDaemonPruneArguments([])).toEqual({
      apply: false,
      includeLegacy: false,
      protectedSessionIds: [],
    });
  });

  it('requires an explicit active-session accounting for legacy children', () => {
    expect(() => parseDaemonPruneArguments(['--include-legacy']))
      .toThrow('--attest-all-active-sessions-protected');
    expect(parseDaemonPruneArguments([
      '--include-legacy',
      '--protect-session',
      'current-session',
      '--attest-all-active-sessions-protected',
      '--apply',
      '--batch-size',
      '8',
    ])).toEqual({
      apply: true,
      includeLegacy: true,
      protectedSessionIds: ['current-session'],
      legacySafetyAttestation: LEGACY_PRUNE_SAFETY_ATTESTATION,
      batchSize: 8,
    });
  });

  it('accepts an explicit assertion that no sessions need protection', () => {
    expect(parseDaemonPruneArguments([
      '--include-legacy',
      '--confirm-no-active-sessions',
    ])).toEqual(expect.objectContaining({
      legacySafetyAttestation: LEGACY_PRUNE_SAFETY_ATTESTATION,
      confirmedNoActiveSessions: true,
    }));
  });

  it('rejects an empty all-active-sessions-protected attestation', () => {
    expect(() => parseDaemonPruneArguments([
      '--include-legacy',
      '--attest-all-active-sessions-protected',
    ])).toThrow('requires at least one --protect-session');
  });

  it('does not allow the safety grace period to be disabled', () => {
    expect(() => parseDaemonPruneArguments(['--min-age-ms', '0']))
      .toThrow('must be at least');
  });
});
