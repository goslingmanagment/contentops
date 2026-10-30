import { type HubDataset, type HubScalar, PINNED_FIELDS } from '../datasets.ts'
import type { FakeRow } from './fake-hub.ts'

/**
 * A row with every pinned field of the dataset — null unless given. Values are made up by
 * the test: fictional refs, no captions or names of real people.
 */
export function fakeRow(
  dataset: HubDataset,
  key: string,
  fields: Record<string, HubScalar> = {},
): FakeRow {
  const base: Record<string, HubScalar> = {}
  for (const field of Object.keys(PINNED_FIELDS[dataset])) base[field] = null
  return { key, fields: { ...base, ...fields } }
}

/** `n` fictional posts of one page, an hour apart from `start`. */
export function fakePosts(n: number, start = '2026-10-01T10:00:00Z', prefix = 'post'): FakeRow[] {
  const t0 = Date.parse(start)
  return Array.from({ length: n }, (_, i) =>
    fakeRow('posts', `${prefix}-${i + 1}`, {
      platform: 'fansly',
      postRef: `${prefix}-${i + 1}`,
      postText: `Test caption ${i + 1}`,
      publishedAt: new Date(t0 + i * 3_600_000).toISOString(),
      firstObservedAt: new Date(t0 + i * 3_600_000 + 7_200_000).toISOString(),
      attachmentCount: 1,
      fypFlags: 0,
      wallRefs: [],
    }),
  )
}
