/**
 * Coordinates the short-lived handshake between a daemon-spawned process and
 * the local daemon control server. A timed-out handshake must invoke cleanup:
 * callers have already been told that the spawn failed, so leaving the child
 * alive would create an untracked session if it reconnects later.
 */

import { TrackedSession } from './types';

export type SessionWebhookWaitResult =
  | { type: 'success'; session: TrackedSession }
  | { type: 'timeout' };

export function waitForSessionWebhook({
  pid,
  timeoutMs,
  awaiters,
  onTimeout,
}: {
  pid: number;
  timeoutMs: number;
  awaiters: Map<number, (session: TrackedSession) => void>;
  onTimeout: (pid: number) => void;
}): Promise<SessionWebhookWaitResult> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      awaiters.delete(pid);
      try {
        onTimeout(pid);
      } catch {
        // The spawn has already timed out. Cleanup is best-effort and must not
        // leave the caller's RPC unresolved if the process exited first.
      }
      resolve({ type: 'timeout' });
    }, timeoutMs);

    awaiters.set(pid, (session) => {
      clearTimeout(timeout);
      awaiters.delete(pid);
      resolve({ type: 'success', session });
    });
  });
}
