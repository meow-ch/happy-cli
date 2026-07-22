import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from './session';

describe('Claude session presence heartbeat', () => {
  const originalInterval = process.env.HAPPY_SESSION_HEARTBEAT_INTERVAL_MS;

  afterEach(() => {
    vi.useRealTimers();
    if (originalInterval === undefined) delete process.env.HAPPY_SESSION_HEARTBEAT_INTERVAL_MS;
    else process.env.HAPPY_SESSION_HEARTBEAT_INTERVAL_MS = originalInterval;
  });

  it('reports state changes immediately and idleness at the configured interval', () => {
    vi.useFakeTimers();
    process.env.HAPPY_SESSION_HEARTBEAT_INTERVAL_MS = '10000';
    const client = {
      keepAlive: vi.fn(),
      updateMetadata: vi.fn(),
    };
    const session = new Session({
      api: {} as never,
      client: client as never,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: null,
      mcpServers: {},
      messageQueue: {} as never,
      onModeChange: vi.fn(),
      hookSettingsPath: '/tmp/settings',
    });

    expect(client.keepAlive).toHaveBeenCalledTimes(1);
    expect(client.keepAlive).toHaveBeenLastCalledWith(false, 'local');
    session.onThinkingChange(true);
    expect(client.keepAlive).toHaveBeenCalledTimes(2);
    expect(client.keepAlive).toHaveBeenLastCalledWith(true, 'local');

    vi.advanceTimersByTime(9_999);
    expect(client.keepAlive).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(client.keepAlive).toHaveBeenCalledTimes(3);
    expect(client.keepAlive).toHaveBeenLastCalledWith(true, 'local');
    session.cleanup();
  });
});
