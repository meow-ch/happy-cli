import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SESSION_HEARTBEAT_INTERVAL_MS,
  MAX_SESSION_HEARTBEAT_INTERVAL_MS,
  MIN_SESSION_HEARTBEAT_INTERVAL_MS,
  sessionHeartbeatIntervalFromEnvironment,
  startSessionHeartbeat,
} from './sessionHeartbeat';

describe('session heartbeat policy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a ten-second idle heartbeat by default', () => {
    expect(sessionHeartbeatIntervalFromEnvironment(undefined))
      .toBe(DEFAULT_SESSION_HEARTBEAT_INTERVAL_MS);
    expect(DEFAULT_SESSION_HEARTBEAT_INTERVAL_MS).toBe(10_000);
  });

  it('accepts a configured interval within the server-safe bounds', () => {
    expect(sessionHeartbeatIntervalFromEnvironment('15000')).toBe(15_000);
  });

  it('clamps amplification-prone and liveness-risking values', () => {
    expect(sessionHeartbeatIntervalFromEnvironment('1'))
      .toBe(MIN_SESSION_HEARTBEAT_INTERVAL_MS);
    expect(sessionHeartbeatIntervalFromEnvironment('900000'))
      .toBe(MAX_SESSION_HEARTBEAT_INTERVAL_MS);
    expect(sessionHeartbeatIntervalFromEnvironment('invalid'))
      .toBe(DEFAULT_SESSION_HEARTBEAT_INTERVAL_MS);
  });

  it('refreshes immediately and then only at the configured cadence', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const heartbeat = startSessionHeartbeat(refresh, 10_000);

    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(9_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);

    clearInterval(heartbeat);
  });
});
