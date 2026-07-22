/**
 * Session-presence heartbeat policy shared by provider runtimes.
 *
 * State transitions are still emitted immediately by each runtime. This
 * interval is only the idle/liveness refresh, so keeping it comfortably below
 * the server's presence timeout does not require waking every session every
 * two seconds.
 */

export const DEFAULT_SESSION_HEARTBEAT_INTERVAL_MS = 10_000;
export const MIN_SESSION_HEARTBEAT_INTERVAL_MS = 5_000;
export const MAX_SESSION_HEARTBEAT_INTERVAL_MS = 60_000;

export function sessionHeartbeatIntervalFromEnvironment(
  value = process.env.HAPPY_SESSION_HEARTBEAT_INTERVAL_MS,
): number {
  if (value === undefined) return DEFAULT_SESSION_HEARTBEAT_INTERVAL_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SESSION_HEARTBEAT_INTERVAL_MS;
  return Math.min(
    MAX_SESSION_HEARTBEAT_INTERVAL_MS,
    Math.max(MIN_SESSION_HEARTBEAT_INTERVAL_MS, Math.floor(parsed)),
  );
}

/** Starts one immediate presence refresh followed by the bounded idle cadence. */
export function startSessionHeartbeat(
  refresh: () => void,
  intervalMs = sessionHeartbeatIntervalFromEnvironment(),
): NodeJS.Timeout {
  refresh();
  return setInterval(refresh, intervalMs);
}
