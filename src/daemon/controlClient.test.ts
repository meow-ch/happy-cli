import { describe, expect, it } from 'vitest';
import { DEFAULT_DAEMON_PRUNE_TERMINATION_TIMEOUT_MS } from './sessionPruning';
import {
  DAEMON_PRUNE_HTTP_TIMEOUT_MARGIN_MS,
  DEFAULT_DAEMON_HTTP_TIMEOUT_MS,
  resolveDaemonHttpTimeout,
} from './controlClient';

describe('daemon control HTTP timeout policy', () => {
  it('uses the normal bounded request timeout for ordinary calls', () => {
    expect(resolveDaemonHttpTimeout(undefined)).toBe(DEFAULT_DAEMON_HTTP_TIMEOUT_MS);
    expect(resolveDaemonHttpTimeout('invalid')).toBe(DEFAULT_DAEMON_HTTP_TIMEOUT_MS);
    expect(resolveDaemonHttpTimeout('15000')).toBe(15_000);
  });

  it('cannot be configured below the prune execution window', () => {
    const minimum = DEFAULT_DAEMON_PRUNE_TERMINATION_TIMEOUT_MS
      + DAEMON_PRUNE_HTTP_TIMEOUT_MARGIN_MS;
    expect(resolveDaemonHttpTimeout('10000', minimum)).toBe(minimum);
    expect(minimum).toBeGreaterThan(DEFAULT_DAEMON_PRUNE_TERMINATION_TIMEOUT_MS);
  });
});
