import type { DatasetRow } from '@contentops/hub'
import { fakeRow } from '@contentops/hub/testing'
import { describe, expect, it } from 'vitest'
import { pageBlockers, postsCoverage } from './sync'

/**
 * Hub's proof of the coverage of posts (entry E7, SPEC §8.1): every read starts in 2020, so
 * Hub always reports the window starting before its record of the page — that gap alone must
 * not cancel the proof (05.11.2026: it did, on every page); the plan counts while Hub keeps
 * its head current.
 */

const floorGap = {
  kind: 'before_capture_floor',
  from: null,
  to: '2026-06-30T18:28:46.000Z',
  plane: 'creator_posts',
}
const BLOCKERS = ['claim_not_declared', 'gaps_present', 'window_before_capture_floor']

function plan(fields: Record<string, string | null>): DatasetRow<'capture_coverage'> {
  const row = fakeRow('capture_coverage', '10:posts:', {
    platform: 'fansly',
    plane: 'posts',
    scopeRef: '',
    status: 'provider_exhausted',
    acquisitionMode: 'retroactive',
    proof: 'empty_window',
    oldestCapturedAt: '2026-06-30T18:28:46.000Z',
    newestCapturedAt: '2026-11-05T16:06:06.000Z',
    observedUniqueCount: 132,
    reasonCode: 'timeline_exhausted',
    nextProbeAt: '2026-11-06T10:06:06.000Z',
    updatedAt: '2026-11-05T16:06:21.000Z',
    ...fields,
  })
  return { ...row, occurredAt: null } as DatasetRow<'capture_coverage'>
}

describe('the coverage of posts from Hub (E7)', () => {
  it('a gap before the floor of capture does not cancel the proof; any other gap does', () => {
    expect(pageBlockers({ blockers: BLOCKERS, capture: { gaps: [floorGap] } })).toEqual([
      'claim_not_declared',
      'window_before_capture_floor',
    ])
    const inside = { ...floorGap, kind: 'internal_capture_gap' }
    expect(pageBlockers({ blockers: BLOCKERS, capture: { gaps: [floorGap, inside] } })).toEqual(
      BLOCKERS,
    )
    expect(pageBlockers({ blockers: BLOCKERS, capture: null })).toEqual(BLOCKERS)
  })

  it('takes the posts plan only with a proof and while Hub keeps its head current', () => {
    const now = new Date('2026-11-05T21:00:00.000Z')
    expect(postsCoverage([plan({})], now)).toEqual({
      windowFrom: '2026-06-30T18:28:46.000Z',
      windowTo: '2026-11-05T16:06:06.000Z',
      expectedCount: null,
      observedCount: 132,
      stopReason: 'timeline_exhausted',
      provenCompleteAt: '2026-11-05T16:06:21.000Z',
    })
    expect(postsCoverage([plan({ nextProbeAt: '2026-11-05T20:59:59.000Z' })], now)).toBeNull()
    expect(postsCoverage([plan({ nextProbeAt: null })], now)).toBeNull()
    expect(postsCoverage([plan({ status: 'window_captured', proof: 'none' })], now)).toBeNull()
    expect(postsCoverage([plan({ plane: 'notifications' })], now)).toBeNull()
  })
})
