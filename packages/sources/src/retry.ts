import { isSourceError, type SourceError } from './errors.ts'

/**
 * Bounded retries with exponential backoff and full jitter (SPEC §6.1: 429 → backoff).
 * Only `rate_limited` and `transient` are retried; a 429 waits at least its `Retry-After`.
 * When the server asks to wait longer than `maxDelayMs`, or the attempts run out, the
 * error goes to the caller: the background work then sleeps in `retry_wait` instead of
 * holding a worker (no infinite retries).
 */
export interface RetryPolicy {
  /** Total attempts including the first one. */
  attempts: number
  baseDelayMs: number
  maxDelayMs: number
  /** 0 ≤ x < 1; `Math.random` by default (tests pass a fixed one). */
  random?: () => number
  /** Injected in tests to skip real waiting. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  onRetry?: (error: SourceError, attempt: number, delayMs: number) => void
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000 }

/** Delay before retry number `attempt` (1-based): random in [0, min(max, base·2^(n-1))]. */
export function backoffDelay(
  attempt: number,
  policy: Pick<RetryPolicy, 'baseDelayMs' | 'maxDelayMs' | 'random'>,
  retryAfterMs?: number | null,
): number {
  const random = policy.random ?? Math.random
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1))
  const jittered = Math.floor(random() * cap)
  return retryAfterMs != null ? Math.max(retryAfterMs, jittered) : jittered
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function withRetry<T>(
  run: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY,
  signal?: AbortSignal,
): Promise<T> {
  const wait = policy.sleep ?? sleep
  for (let attempt = 1; ; attempt++) {
    try {
      return await run(attempt)
    } catch (e) {
      if (!isSourceError(e) || !e.retryable || attempt >= policy.attempts) throw e
      if (e.retryAfterMs != null && e.retryAfterMs > policy.maxDelayMs) throw e
      const delay = backoffDelay(attempt, policy, e.retryAfterMs)
      policy.onRetry?.(e, attempt, delay)
      await wait(delay, signal)
    }
  }
}
