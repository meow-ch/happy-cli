import { describe, expect, it, vi } from 'vitest';
import { onceAsync } from './onceAsync';

describe('onceAsync', () => {
  it('shares one execution across concurrent and repeated shutdown triggers', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = vi.fn(async () => {
      await wait;
      return 'closed';
    });
    const shutdown = onceAsync(operation);

    const first = shutdown();
    const second = shutdown();
    expect(second).toBe(first);
    expect(operation).toHaveBeenCalledTimes(0);

    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toBe('closed');
    await expect(shutdown()).resolves.toBe('closed');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
