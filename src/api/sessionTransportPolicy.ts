/** Shared rate and jitter policy for durable session transport recovery. */

export const DEFAULT_RECONNECT_RECOVERY_JITTER_MS = 5_000;
export const DEFAULT_OUTBOX_DRAIN_BATCH_SIZE = 25;
export const DEFAULT_INBOX_RECONCILE_INTERVAL_MS = 15_000;
export const DEFAULT_INBOX_PERIODIC_JITTER_MS = 5_000;
export const DEFAULT_INBOX_MAX_PAGES_PER_RECONCILE = 4;

function normalizedRandom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(0.999_999_999, value));
}

export function reconnectRecoveryDelay(
  jitterMaxMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.max(0, Math.floor(jitterMaxMs));
  return Math.floor(normalizedRandom(random) * (ceiling + 1));
}

/**
 * Exponential retry with equal jitter. The non-zero lower half prevents a
 * fleet of sessions from repeatedly selecting a zero-delay hot loop.
 */
export function boundedRetryDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const base = Math.max(1, Math.floor(baseMs));
  const maximum = Math.max(base, Math.floor(maxMs));
  const ceiling = Math.min(maximum, base * (2 ** Math.min(Math.max(0, attempt), 16)));
  const floor = Math.max(1, Math.floor(ceiling / 2));
  return floor + Math.floor(normalizedRandom(random) * (ceiling - floor + 1));
}

export function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

export function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! >= 0 ? value! : fallback;
}
