/**
 * Reconnect backoff, extracted so it is unit-testable in isolation
 * (Node tests transpile this dependency-free module directly).
 */

/**
 * Reconnect delay (ms) for the n-th failed attempt. Capped backoff:
 * 1.5s → 3.75s → 6s → … max 6s. Exported and tested.
 */
export function wsBackoffDelay(attempt: number): number {
  const base = 1500;
  const max = 6000;
  return Math.min(max, Math.round(base * (1 + attempt * 1.5)));
}
