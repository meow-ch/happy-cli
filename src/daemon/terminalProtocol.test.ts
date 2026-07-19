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

  it('returns the exact child proof after its startup webhook attests v1', () => {
    expect(__testDaemonTerminalProtocol.attestedSpawnResult({
      startedBy: 'daemon',
      pid: 456,
      happySessionId: 'sid_v1_child',
      terminalProtocol: 1,
    }, 1)).toEqual({
      type: 'success',
      sessionId: 'sid_v1_child',
      terminalProtocol: 1,
    });
  });
});
