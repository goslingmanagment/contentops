import { describe, expect, it } from 'vitest'
import { SourceError, type SourceErrorKind } from './errors.ts'
import { backoffDelay, withRetry } from './retry.ts'
import { recordingRetry } from './testing/index.ts'

const err = (kind: SourceErrorKind, retryAfterMs?: number) =>
  new SourceError(kind, kind, {
    source: 'yandex_disk',
    endpoint: '/v1/disk',
    ...(retryAfterMs != null ? { retryAfterMs } : {}),
  })

describe('backoff', () => {
  it('grows exponentially under a cap, with full jitter, and respects Retry-After', () => {
    const policy = { baseDelayMs: 1000, maxDelayMs: 8000 }
    expect(backoffDelay(1, { ...policy, random: () => 0.999 })).toBe(999)
    expect(backoffDelay(3, { ...policy, random: () => 0.999 })).toBe(3996)
    expect(backoffDelay(10, { ...policy, random: () => 0.999 })).toBe(7992)
    expect(backoffDelay(10, { ...policy, random: () => 0 })).toBe(0)
    expect(backoffDelay(1, { ...policy, random: () => 0 }, 5000)).toBe(5000)
  })

  it('retries only rate limits and transient failures, a bounded number of times', async () => {
    const { policy, delays } = recordingRetry({ attempts: 3 })
    let n = 0
    await expect(
      withRetry(async () => {
        n++
        throw err('transient')
      }, policy),
    ).rejects.toMatchObject({ kind: 'transient' })
    expect(n).toBe(3)
    expect(delays).toHaveLength(2)

    for (const kind of ['auth_rejected', 'not_found', 'bad_response'] as const) {
      let calls = 0
      await expect(
        withRetry(async () => {
          calls++
          throw err(kind)
        }, policy),
      ).rejects.toMatchObject({ kind })
      expect(calls).toBe(1)
    }
  })

  it('gives a long Retry-After back to the caller instead of sleeping', async () => {
    const { policy, delays } = recordingRetry({ maxDelayMs: 1000 })
    let n = 0
    await expect(
      withRetry(async () => {
        n++
        throw err('rate_limited', 30_000)
      }, policy),
    ).rejects.toMatchObject({ retryAfterMs: 30_000 })
    expect(n).toBe(1)
    expect(delays).toEqual([])
  })

  it('stops waiting when aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const { policy } = recordingRetry()
    await expect(
      withRetry(
        async () => {
          throw err('transient')
        },
        policy,
        ac.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
