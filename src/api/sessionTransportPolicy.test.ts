import { describe, expect, it } from 'vitest';
import { boundedRetryDelay, reconnectRecoveryDelay } from './sessionTransportPolicy';

describe('session transport retry policy', () => {
  it('spreads reconnect recovery across the configured window', () => {
    expect(reconnectRecoveryDelay(5_000, () => 0)).toBe(0);
    expect(reconnectRecoveryDelay(5_000, () => 0.5)).toBe(2_500);
    expect(reconnectRecoveryDelay(5_000, () => 0.999999)).toBe(5_000);
  });

  it('uses capped equal jitter without zero-delay retry loops', () => {
    expect(boundedRetryDelay(0, 1_000, 60_000, () => 0)).toBe(500);
    expect(boundedRetryDelay(1, 1_000, 60_000, () => 0.999999)).toBe(2_000);
    expect(boundedRetryDelay(20, 1_000, 60_000, () => 0.999999)).toBe(60_000);
  });
});
