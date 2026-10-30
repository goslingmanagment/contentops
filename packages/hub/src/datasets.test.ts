import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHubClient, type DatasetPage, type HubClient } from './client.ts'
import type { HubDataset } from './datasets.ts'
import { isHubError } from './errors.ts'
import type { RetryPolicy } from './retry.ts'
import { type FakeHub, fakePosts, fakeRow, recordingRetry, startFakeHub } from './testing/index.ts'

let hub: FakeHub
let retry: { policy: RetryPolicy; delays: number[] }
let client: HubClient

beforeEach(async () => {
  hub = await startFakeHub()
  retry = recordingRetry()
  client = createHubClient({
    baseUrl: hub.url,
    key: hub.key,
    retry: retry.policy,
    now: () => hub.now(),
  })
})

afterEach(async () => {
  await hub.close()
})

async function collect<D extends HubDataset>(
  it: AsyncIterable<DatasetPage<D>>,
): Promise<DatasetPage<D>[]> {
  const pages: DatasetPage<D>[] = []
  for await (const page of it) pages.push(page)
  return pages
}

describe('readDataset paging', () => {
  it('walks every page; later pages send only the cursor', async () => {
    hub.put('posts', 'page-a', fakePosts(450))
    const pages = await collect(client.readDataset('posts', { page: 'page-a' }))
    expect(pages.map((p) => p.rows.length)).toEqual([200, 200, 50])
    const keys = pages.flatMap((p) => p.rows.map((r) => r.key))
    expect(new Set(keys).size).toBe(450)
    expect(pages.at(-1)?.nextCursor).toBeNull()
    const bodies = hub.calls('dataset').map((r) => r.json as Record<string, unknown>)
    expect(bodies[0]).toMatchObject({ from: '2020-01-01T00:00:00.000Z', limit: 200, filters: [] })
    expect(bodies[1]).toEqual({ cursor: pages[0]?.nextCursor })
    expect(pages[0]?.blockers).toContain('delivery_not_exhausted')
  })

  it('ends on the empty page after an exact multiple of the limit', async () => {
    hub.put('posts', 'page-a', fakePosts(4))
    const pages = await collect(client.readDataset('posts', { page: 'page-a', limit: 2 }))
    expect(pages.map((p) => p.rows.length)).toEqual([2, 2, 0])
  })

  it('resumes from a saved cursor, and a rebuild makes the cursor invalid', async () => {
    hub.put(
      'raw_media',
      'page-a',
      [1, 2, 3, 4, 5].map((i) =>
        fakeRow('raw_media', `m-${i}`, {
          mediaRef: `m-${i}`,
          firstObservedAt: `2026-10-0${i}T00:00:00Z`,
        }),
      ),
    )
    const first = await client.readDataset('raw_media', { page: 'page-a', limit: 2 }).next()
    const cursor = first.value?.nextCursor as string
    const rest = await collect(client.readDataset('raw_media', { page: 'page-a', cursor }))
    expect(rest.flatMap((p) => p.rows.map((r) => r.key))).toEqual(['m-3', 'm-4', 'm-5'])

    hub.rebuild()
    const err = await collect(client.readDataset('raw_media', { page: 'page-a', cursor })).catch(
      (e) => e,
    )
    expect(isHubError(err, 'refused', 'agent_cursor_invalid')).toBe(true)
  })

  it('reads by rowUpdatedAt from the overlap, as a filter beside the window', async () => {
    hub.put('posts', 'page-a', fakePosts(3, '2026-10-01T10:00:00Z', 'old'))
    hub.advance(5 * 3_600_000)
    hub.put('posts', 'page-a', fakePosts(2, '2026-10-20T10:00:00Z', 'new'))
    const since = new Date(hub.now().getTime() - 3 * 3_600_000)
    const pages = await collect(
      client.readDataset('posts', { page: 'page-a', updatedSince: since }),
    )
    expect(pages.flatMap((p) => p.rows.map((r) => r.key))).toEqual(['new-1', 'new-2'])
    expect((hub.calls('dataset')[0]?.json as { filters?: unknown } | undefined)?.filters).toEqual([
      { field: 'rowUpdatedAt', op: 'gte', value: since.toISOString() },
    ])
  })

  it('refuses updatedSince on a dataset read whole', async () => {
    const it = client.readDataset('capture_coverage', {
      page: 'page-a',
      updatedSince: new Date() as never,
    })
    await expect(it.next()).rejects.toThrow(TypeError)
  })

  it('types the pinned fields, fills the absent ones with null and keeps extra ones', async () => {
    hub.put('vault_media', 'page-a', [
      {
        key: 'vm-1',
        fields: {
          mediaRef: 'm-1',
          albumTitle: 'PPV',
          durationMs: 12_345,
          firstObservedAt: '2026-10-05T00:00:00Z',
          somethingNew: 'kept',
        },
      },
    ])
    const [page] = await collect(client.readDataset('vault_media', { page: 'page-a' }))
    const row = page?.rows[0]
    expect(row?.fields.durationMs).toBe(12_345)
    expect(row?.fields.missingSince).toBeNull()
    expect(row?.fields.somethingNew).toBe('kept')
    expect(row?.occurredAt).toBe('2026-10-05T00:00:00.000Z')
  })

  it('stops on a pinned field of the wrong kind', async () => {
    hub.put('posts', 'page-a', [
      fakeRow('posts', 'p-1', { publishedAt: '2026-10-01T00:00:00Z', attachmentCount: '3' }),
    ])
    const err = await collect(client.readDataset('posts', { page: 'page-a' })).catch((e) => e)
    expect(isHubError(err, 'bad_response')).toBe(true)
    expect(String(err.message)).toContain('attachmentCount')
  })

  it('reads sync_streams whole, without a window column', async () => {
    hub.put('sync_streams', 'page-a', [
      fakeRow('sync_streams', 'posts', { stream: 'posts', succeededAt: '2026-11-02T08:30:00Z' }),
    ])
    const [page] = await collect(client.readDataset('sync_streams', { page: 'page-a' }))
    expect(page?.rows[0]?.fields.succeededAt).toBe('2026-11-02T08:30:00Z')
  })
})

describe('failures', () => {
  it('401 stops at once with the time the key was refused', async () => {
    hub.revokeKey()
    const err = await client.capabilities().catch((e) => e)
    expect(isHubError(err, 'auth_rejected')).toBe(true)
    expect(err.at.toISOString()).toBe(hub.now().toISOString())
    expect(hub.calls('capabilities')).toHaveLength(1)
    expect(retry.delays).toEqual([])
  })

  it('403 is auth_rejected too, without retries', async () => {
    hub.fail('forbidden', { endpoint: 'dataset' })
    const err = await collect(client.readDataset('posts', { page: 'page-a' })).catch((e) => e)
    expect(isHubError(err, 'auth_rejected')).toBe(true)
    expect(hub.calls('dataset')).toHaveLength(1)
  })

  it('429 waits at least Retry-After, then goes on', async () => {
    hub.put('posts', 'page-a', fakePosts(3))
    hub.fail('rate_limit', { endpoint: 'dataset', retryAfter: 2, times: 2 })
    const pages = await collect(client.readDataset('posts', { page: 'page-a' }))
    expect(pages[0]?.rows).toHaveLength(3)
    expect(retry.delays).toHaveLength(2)
    for (const d of retry.delays) expect(d).toBeGreaterThanOrEqual(2_000)
  })

  it('a Retry-After longer than the policy allows goes to the caller', async () => {
    hub.fail('rate_limit', { endpoint: 'capabilities', retryAfter: 3_600 })
    const err = await client.capabilities().catch((e) => e)
    expect(isHubError(err, 'rate_limited')).toBe(true)
    expect(err.retryAfterMs).toBe(3_600_000)
    expect(hub.calls('capabilities')).toHaveLength(1)
  })

  it('5xx and a cut answer are retried with growing pauses', async () => {
    hub.put('posts', 'page-a', fakePosts(5))
    hub.fail('server_error', { endpoint: 'dataset' }).fail('cut', { endpoint: 'dataset' })
    const pages = await collect(client.readDataset('posts', { page: 'page-a' }))
    expect(pages[0]?.rows).toHaveLength(5)
    expect(hub.calls('dataset')).toHaveLength(3)
    expect(retry.delays).toEqual([50, 100])
  })

  it('a cut on every attempt ends as transient after the bounded attempts', async () => {
    hub.fail('cut', { endpoint: 'dataset', times: 10 })
    const err = await collect(client.readDataset('posts', { page: 'page-a' })).catch((e) => e)
    expect(isHubError(err, 'transient')).toBe(true)
    expect(hub.calls('dataset')).toHaveLength(retry.policy.attempts)
  })

  it('a malformed answer is bad_response and is not repeated', async () => {
    hub.fail('malformed', { endpoint: 'dataset' })
    const err = await collect(client.readDataset('posts', { page: 'page-a' })).catch((e) => e)
    expect(isHubError(err, 'bad_response')).toBe(true)
    expect(hub.calls('dataset')).toHaveLength(1)
  })

  it('a page outside the grant is refused with Hub code', async () => {
    const err = await collect(client.readDataset('posts', { page: 'page-x' })).catch((e) => e)
    expect(isHubError(err, 'refused', 'not_found')).toBe(true)
  })
})
