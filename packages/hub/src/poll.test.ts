import { describe, expect, it } from 'vitest'
import { afterPoll, planPoll, publicationChangesSince } from './poll.ts'

const H = 3_600_000
const now = new Date('2026-11-02T12:00:00Z')
const ago = (ms: number) => new Date(now.getTime() - ms)

describe('planPoll', () => {
  it('the first poll is a full read', () => {
    expect(planPoll({ now, lastSuccessAt: null, lastDailyAt: null, lastFullAt: null })).toEqual({
      mode: 'full',
      reason: 'first',
      updatedSince: null,
    })
  })

  it('hourly: the last success minus 3 h', () => {
    const plan = planPoll({
      now,
      lastSuccessAt: ago(H),
      lastDailyAt: ago(5 * H),
      lastFullAt: ago(48 * H),
    })
    expect(plan).toEqual({ mode: 'hourly', updatedSince: new Date('2026-11-02T08:00:00Z') })
  })

  it('once a day: the last success minus a day', () => {
    const plan = planPoll({
      now,
      lastSuccessAt: ago(H),
      lastDailyAt: ago(24 * H),
      lastFullAt: ago(48 * H),
    })
    expect(plan).toEqual({ mode: 'daily', updatedSince: new Date('2026-11-01T11:00:00Z') })
  })

  it('a gap longer than a day, a month since the full read, a failure or a rebuild — full', () => {
    const base = { now, lastDailyAt: ago(2 * H), lastFullAt: ago(48 * H) }
    expect(planPoll({ ...base, lastSuccessAt: ago(25 * H) })).toMatchObject({
      mode: 'full',
      reason: 'gap',
    })
    expect(planPoll({ ...base, lastSuccessAt: ago(24 * H) })).toMatchObject({ mode: 'hourly' })
    expect(
      planPoll({ ...base, lastSuccessAt: ago(H), lastFullAt: ago(30 * 24 * H) }),
    ).toMatchObject({
      mode: 'full',
      reason: 'monthly',
    })
    expect(planPoll({ ...base, lastSuccessAt: ago(H), forceFull: 'failure' })).toMatchObject({
      mode: 'full',
      reason: 'failure',
    })
    expect(planPoll({ ...base, lastSuccessAt: ago(H), forceFull: 'rebuild' })).toMatchObject({
      mode: 'full',
      reason: 'rebuild',
    })
  })

  it('keeps the start of a successful run as the next base', () => {
    const state = { lastSuccessAt: ago(H), lastDailyAt: ago(5 * H), lastFullAt: ago(48 * H) }
    const hourly = afterPoll(state, planPoll({ ...state, now }), now)
    expect(hourly).toEqual({
      lastSuccessAt: now,
      lastDailyAt: state.lastDailyAt,
      lastFullAt: state.lastFullAt,
    })
    const full = afterPoll(state, { mode: 'full', reason: 'first', updatedSince: null }, now)
    expect(full).toEqual({ lastSuccessAt: now, lastDailyAt: now, lastFullAt: now })
    // The next run an hour later reads from 3 h before this start.
    expect(planPoll({ ...hourly, now: new Date(now.getTime() + H) })).toEqual({
      mode: 'hourly',
      updatedSince: ago(3 * H),
    })
  })
})

describe('publicationChangesSince', () => {
  it('the greatest updatedAt seen minus the overlap; null from the first one', () => {
    expect(publicationChangesSince(null)).toBeNull()
    expect(publicationChangesSince('2026-11-02T12:00:00Z')).toEqual(
      new Date('2026-11-02T09:00:00Z'),
    )
    expect(publicationChangesSince(now, 10 * 60_000)).toEqual(new Date('2026-11-02T11:50:00Z'))
  })
})
