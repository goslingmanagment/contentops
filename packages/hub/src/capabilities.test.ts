import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkCapabilities, describeProblem, parseCapabilities } from './capabilities.ts'
import { createHubClient, type HubClient } from './client.ts'
import { HUB_DATASETS } from './datasets.ts'
import { isHubError } from './errors.ts'
import { type FakeHub, startFakeHub } from './testing/index.ts'

let hub: FakeHub
let client: HubClient

beforeEach(async () => {
  hub = await startFakeHub()
  client = createHubClient({ baseUrl: hub.url, key: hub.key })
})

afterEach(async () => {
  await hub.close()
})

describe('checkCapabilities', () => {
  it('passes with extra fields, extra datasets and a new section of the answer', async () => {
    const caps = await client.capabilities()
    expect(caps.raw.futureSection).toBeDefined()
    expect(caps.datasets.get('posts')?.fields.get('inReplyToRef')).toBe('string')
    const check = checkCapabilities(caps)
    expect(check.ok).toBe(true)
    expect(check.publishing).toEqual({ ok: true, missing: [] })
    expect(caps.pages.map((p) => p.pageLabel)).toEqual(['page-a', 'page-b', 'page-c'])
  })

  it('a missing field stops only its dataset', async () => {
    hub.setField('post_attachments', 'linkState', null)
    const check = checkCapabilities(await client.capabilities())
    expect(check.ok).toBe(false)
    expect(check.datasets.post_attachments).toEqual({
      ok: false,
      problems: [{ kind: 'field_missing', field: 'linkState', expected: 'string' }],
    })
    for (const d of HUB_DATASETS)
      if (d !== 'post_attachments') expect(check.datasets[d].ok).toBe(true)
    expect(
      describeProblem('post_attachments', check.datasets.post_attachments.problems[0] as never),
    ).toBe('в наборе post_attachments пропало поле linkState')
  })

  it('a changed type is a problem; an unknown kind is reported as Hub sent it', async () => {
    hub.setField('posts', 'fypFlags', 'string')
    hub.setField('raw_media', 'durationMs', 'decimal')
    const check = checkCapabilities(await client.capabilities())
    expect(check.datasets.posts.problems).toEqual([
      { kind: 'field_type_changed', field: 'fypFlags', expected: 'int', actual: 'string' },
    ])
    expect(check.datasets.raw_media.problems).toEqual([
      { kind: 'field_type_changed', field: 'durationMs', expected: 'int', actual: 'decimal' },
    ])
  })

  it('a dataset gone or only planned is a problem', async () => {
    hub.setAvailability('top_media', null)
    hub.setAvailability('creator_stats_media_likes', 'planned')
    const check = checkCapabilities(await client.capabilities())
    expect(check.datasets.top_media.problems).toEqual([{ kind: 'dataset_missing' }])
    expect(check.datasets.creator_stats_media_likes.problems).toEqual([
      { kind: 'dataset_not_available', availability: 'planned' },
    ])
  })

  it('without read:content the own material needs the declared rights', async () => {
    await hub.close()
    hub = await startFakeHub({ grants: ['read:datasets', 'write:publication_drafts'] })
    client = createHubClient({ baseUrl: hub.url, key: hub.key })
    const check = checkCapabilities(await client.capabilities())
    expect(check.datasets.posts.problems).toEqual([
      { kind: 'not_granted', missing: ['read:content'] },
    ])
    expect(check.publishing).toEqual({ ok: false, missing: ['approve:publications'] })
  })

  it('the declared rights are enough without read:content', async () => {
    await hub.close()
    hub = await startFakeHub({ grants: ['read:datasets', 'read:messages'] })
    client = createHubClient({ baseUrl: hub.url, key: hub.key })
    expect(checkCapabilities(await client.capabilities()).ok).toBe(true)
  })
})

describe('parseCapabilities', () => {
  it('needs only the datasets list', () => {
    const caps = parseCapabilities({
      datasets: [{ dataset: 'posts', fields: [{ field: 'postRef', type: 'string' }] }],
    })
    expect(caps.grants).toBeNull()
    expect(caps.datasets.get('posts')?.availability).toBe('available')
    const check = checkCapabilities(caps)
    expect(check.datasets.posts.problems.some((p) => p.kind === 'not_granted')).toBe(false)
    expect(
      check.datasets.posts.problems.filter((p) => p.kind === 'field_missing').length,
    ).toBeGreaterThan(0)
  })

  it('an answer without datasets is bad_response', () => {
    expect(() => parseCapabilities({ contract: {} })).toThrow(/datasets/)
    try {
      parseCapabilities([])
    } catch (e) {
      expect(isHubError(e, 'bad_response')).toBe(true)
    }
  })
})
