import { afterEach, describe, expect, it, vi } from 'vitest';

import { TrackedSession } from './types';
import { waitForSessionWebhook } from './sessionWebhookAwaiter';

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForSessionWebhook', () => {
  it('resolves a reported session without cleanup', async () => {
    vi.useFakeTimers();
    const awaiters = new Map<number, (session: TrackedSession) => void>();
    const onTimeout = vi.fn();
    const resultPromise = waitForSessionWebhook({
      pid: 123,
      timeoutMs: 15_000,
      awaiters,
      onTimeout,
    });
    const session: TrackedSession = { startedBy: 'daemon', pid: 123, happySessionId: 'session_123' };

    awaiters.get(123)?.(session);

    await expect(resultPromise).resolves.toEqual({ type: 'success', session });
    expect(onTimeout).not.toHaveBeenCalled();
    expect(awaiters.has(123)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up a child that misses the webhook deadline', async () => {
    vi.useFakeTimers();
    const awaiters = new Map<number, (session: TrackedSession) => void>();
    const onTimeout = vi.fn();
    const resultPromise = waitForSessionWebhook({
      pid: 456,
      timeoutMs: 15_000,
      awaiters,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(resultPromise).resolves.toEqual({ type: 'timeout' });
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onTimeout).toHaveBeenCalledWith(456);
    expect(awaiters.has(456)).toBe(false);
  });

  it('still resolves a timeout when cleanup reports an error', async () => {
    vi.useFakeTimers();
    const resultPromise = waitForSessionWebhook({
      pid: 789,
      timeoutMs: 15_000,
      awaiters: new Map(),
      onTimeout: () => {
        throw new Error('already exited');
      },
    });

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(resultPromise).resolves.toEqual({ type: 'timeout' });
  });
});
