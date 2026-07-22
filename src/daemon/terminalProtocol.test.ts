import { describe, expect, it } from 'vitest';

import { __testDaemonTerminalProtocol } from './run';

describe('daemon child terminal protocol attestation', () => {
  it('rejects a required protocol for a provider which does not support it', () => {
    expect(__testDaemonTerminalProtocol.validateRequiredTerminalProtocol({
      directory: '/tmp',
      agent: 'codex',
      requiredTerminalProtocol: 1,
    })).toContain('only for Claude');
  });

  it('fails closed when the exact spawned child omits the required proof', () => {
    expect(__testDaemonTerminalProtocol.attestedSpawnResult({
      startedBy: 'daemon',
      pid: 123,
      happySessionId: 'sid_legacy_child',
    }, 1)).toEqual({
      type: 'error',
      errorMessage: 'Spawned child did not attest required terminal protocol 1.',
    });
  });

  it('fails closed when a spawned child has no process-birth proof', () => {
    expect(__testDaemonTerminalProtocol.attestedSpawnResult({
      startedBy: 'daemon',
      pid: 321,
      happySessionId: 'sid_without_birth_proof',
      terminalProtocol: 1,
    }, 1)).toEqual({
      type: 'error',
      errorMessage: 'Spawned child process identity could not be verified.',
    });
  });

  it('returns exact child terminal and data-key proofs after its startup webhook', () => {
    expect(__testDaemonTerminalProtocol.attestedSpawnResult({
      startedBy: 'daemon',
      pid: 456,
      happySessionId: 'sid_v1_child',
      processBirthFingerprint: 'v1:test-process-birth',
      terminalProtocol: 1,
      sessionEncryption: {
        credentialMode: 'data_key',
        sessionMode: 'data_key',
      },
    }, 1)).toEqual({
      type: 'success',
      sessionId: 'sid_v1_child',
      terminalProtocol: 1,
      sessionEncryption: {
        credentialMode: 'data_key',
        sessionMode: 'data_key',
      },
    });
  });
});
