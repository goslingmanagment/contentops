import type { RetryPolicy } from '../retry.ts'

/**
 * A retry policy that does not really wait: the pauses it would take are recorded, so a
 * test checks the backoff (and `Retry-After`) without sleeping.
 */
export function recordingRetry(
  o: Partial<Pick<RetryPolicy, 'attempts' | 'baseDelayMs' | 'maxDelayMs'>> = {},
): { policy: RetryPolicy; delays: number[] } {
  const delays: number[] = []
  const policy: RetryPolicy = {
    attempts: o.attempts ?? 4,
    baseDelayMs: o.baseDelayMs ?? 100,
    maxDelayMs: o.maxDelayMs ?? 10_000,
    random: () => 0.5,
    sleep: async (ms, signal) => {
      signal?.throwIfAborted()
      delays.push(ms)
    },
  }
  return { policy, delays }
}
