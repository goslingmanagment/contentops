import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHubClient, type HubClient } from './client.ts'
import { isHubError } from './errors.ts'
import {
  canCancel,
  type DraftInput,
  draftBody,
  type HubPublication,
  parseMediaKey,
  publicationRowState,
} from './publications.ts'
import type { RetryPolicy } from './retry.ts'
import { type FakeHub, fakeRow, recordingRetry, startFakeHub } from './testing/index.ts'

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
  hub.put('vault_media', 'page-a', [
    fakeRow('vault_media', 'vm-1', {
      mediaRef: 'm-501',
      albumTitle: 'PPV',
      firstObservedAt: '2026-10-01T00:00:00Z',
    }),
  ])
})

afterEach(async () => {
  await hub.close()
})

const bytes = (seed: string, size = 4_096) => new Uint8Array(Buffer.alloc(size, seed))

const tomorrow = () => new Date(hub.now().getTime() + 24 * 3_600_000)

function wall(over: Partial<DraftInput> = {}): DraftInput {
  return {
    kind: 'subscriber_post',
    idempotencyKey: 'row-1:v1',
    publishAt: tomorrow(),
    caption: 'Test caption',
    media: ['vault:m-501'],
    ...over,
  }
}

async function allChanges(since: Date | null): Promise<HubPublication[]> {
  const out: HubPublication[] = []
  for await (const page of client.changesSince(since, { limit: 2 })) out.push(...page.publications)
  return out
}

describe('upload', () => {
  it('the same bytes answer the same file, created:false', async () => {
    const first = await client.uploadPublicationFile('page-a', {
      name: 'PPV-073_v1_platform.mp4',
      bytes: bytes('a'),
    })
    expect(first.created).toBe(true)
    expect(first.file.sha256).toBe(createHash('sha256').update(bytes('a')).digest('hex'))
    const again = await client.uploadPublicationFile('page-a', {
      name: 'PPV-073_v1_platform.mp4',
      bytes: bytes('a'),
    })
    expect(again).toMatchObject({ created: false, file: { id: first.file.id } })
    expect(hub.calls('publication-files')[0]?.query.get('name')).toBe('PPV-073_v1_platform.mp4')
  })

  it('a lost answer is sent again and lands on the same file', async () => {
    hub.fail('lost_answer', { endpoint: 'publication-files' })
    const result = await client.uploadPublicationFile('page-a', {
      name: 'f.mp4',
      bytes: bytes('b'),
    })
    expect(result.created).toBe(false)
    expect(hub.files.size).toBe(1)
    expect(hub.calls('publication-files')).toHaveLength(2)
  })

  it('streams a file opened anew for each attempt, with its size and SHA-256', async () => {
    const data = bytes('c', 100_000)
    const sha256 = createHash('sha256').update(data).digest('hex')
    let opened = 0
    const open = () => {
      opened++
      return new Blob([data]).stream()
    }
    hub.fail('server_error', { endpoint: 'publication-files' })
    const result = await client.uploadPublicationFile('page-a', {
      name: 'f.mp4',
      open,
      size: data.length,
      sha256,
    })
    expect(result.file.byteSize).toBe(100_000)
    expect(opened).toBe(2)
    expect(hub.calls('publication-files')[1]?.headers['content-length']).toBe('100000')
  })

  it('a SHA-256 that Hub does not confirm is bad_response', async () => {
    const data = bytes('d')
    const err = await client
      .uploadPublicationFile('page-a', {
        name: 'f.mp4',
        open: () => new Blob([data]).stream(),
        size: data.length,
        sha256: '0'.repeat(64),
      })
      .catch((e) => e)
    expect(isHubError(err, 'bad_response')).toBe(true)
  })

  it('Hub refusals pass through with their code', async () => {
    await hub.close()
    hub = await startFakeHub({ maxFileBytes: 10 })
    client = createHubClient({ baseUrl: hub.url, key: hub.key, retry: retry.policy })
    const err = await client
      .uploadPublicationFile('page-a', { name: 'f.mp4', bytes: bytes('e', 11) })
      .catch((e) => e)
    expect(isHubError(err, 'refused', 'publication_file_too_large')).toBe(true)
    expect(err.status).toBe(413)
  })
})

describe('draft, checks, approve', () => {
  it('drafts with an uploaded file and a vault file; Hub returns its checks', async () => {
    const { file } = await client.uploadPublicationFile('page-a', {
      name: 'f.jpg',
      bytes: bytes('f'),
    })
    const draft = await client.createDraft(
      'page-a',
      wall({ media: [`file:${file.id}`, 'vault:m-501'] }),
    )
    expect(draft).toMatchObject({ status: 'draft', version: 1, blocked: false, findings: [] })
    const sent = hub.calls('publications.create')[0]?.json as Record<string, unknown>
    expect(sent.media).toEqual([
      { source: 'file', fileId: file.id },
      { source: 'vault', mediaRef: 'm-501' },
    ])
    expect(sent).toMatchObject({
      text: 'Test caption',
      tierRefs: [],
      priceMills: null,
      repost: false,
    })
  })

  it('a lost answer of «Подготовить» makes no second draft (idempotency key)', async () => {
    hub.fail('lost_answer', { endpoint: 'publications.create' })
    const draft = await client.createDraft('page-a', wall())
    expect(hub.publications.size).toBe(1)
    expect(draft.id).toBe([...hub.publications.keys()][0])
    const err = await client
      .createDraft('page-a', wall({ caption: 'Another caption' }))
      .catch((e) => e)
    expect(isHubError(err, 'refused', 'idempotency_mismatch')).toBe(true)
  })

  it('a price without the page range blocks approval (price_range_not_set)', async () => {
    const draft = await client.createDraft(
      'page-a',
      wall({ kind: 'paid_post', priceMills: 15_000 }),
    )
    expect(draft.blocked).toBe(true)
    expect(draft.findings.map((f) => f.code)).toEqual(['price_range_not_set'])
    const [result] = await client.approve([{ id: draft.id, version: draft.version }])
    expect(result).toMatchObject({
      outcome: 'refused',
      reason: 'blocking_findings',
      approved: false,
    })

    hub.setPriceRange('page-a', { min: 5_000, max: 50_000 })
    const checks = await client.getDraftChecks(draft.id)
    expect(checks).toMatchObject({ status: 'draft', blocked: true })
    const [second] = await client.approve([{ id: draft.id, version: draft.version }])
    expect(second).toMatchObject({ outcome: 'approved', approved: true })
  })

  it('a vault file not on the page is a blocking finding', async () => {
    const draft = await client.createDraft('page-a', wall({ media: ['vault:m-999'] }))
    expect(draft.findings).toMatchObject([
      { code: 'media_not_on_page', severity: 'blocking', mediaKey: 'vault:m-999' },
    ])
  })

  it('approve after a lost answer: the repeat says it is approved already', async () => {
    const draft = await client.createDraft('page-a', wall())
    hub.fail('lost_answer', { endpoint: 'publications.approve' })
    const [result] = await client.approve([{ id: draft.id, version: draft.version }])
    expect(result).toMatchObject({ outcome: 'refused', reason: 'status_approved', approved: true })
    expect(hub.publication(draft.id).status).toBe('approved')
  })

  it('Fansly audience: tiers, or every subscriber', () => {
    expect(draftBody(wall({ audience: { kind: 'tiers', tierRefs: ['8001'] } })).tierRefs).toEqual([
      '8001',
    ])
    expect(draftBody(wall({ audience: { kind: 'subscribers' } })).tierRefs).toEqual([])
  })

  it('a vault album has a name, not a caption', () => {
    expect(
      draftBody(wall({ kind: 'vault_album', caption: undefined, albumName: 'PPV' })),
    ).toMatchObject({
      kind: 'vault_album',
      text: 'PPV',
    })
    expect(() => draftBody(wall({ kind: 'vault_album' }))).toThrow(/name, not a caption/)
    expect(() => draftBody(wall({ kind: 'vault_album', caption: undefined }))).toThrow(
      /needs its name/,
    )
    expect(() => parseMediaKey('vault:')).toThrow(TypeError)
    expect(() => parseMediaKey('file:0')).toThrow(TypeError)
  })

  it('a missing right is auth_rejected', async () => {
    await hub.close()
    hub = await startFakeHub({ grants: ['read:content', 'write:publication_drafts'] })
    client = createHubClient({
      baseUrl: hub.url,
      key: hub.key,
      retry: retry.policy,
      now: () => hub.now(),
    })
    const draft = await client.createDraft('page-a', wall({ media: [], caption: 'Text only' }))
    const err = await client.approve([{ id: draft.id, version: draft.version }]).catch((e) => e)
    expect(isHubError(err, 'auth_rejected')).toBe(true)
  })
})

describe('cancel and statuses', () => {
  async function approved(key: string): Promise<HubPublication> {
    const draft = await client.createDraft('page-a', wall({ idempotencyKey: key }))
    const [result] = await client.approve([{ id: draft.id, version: draft.version }])
    return result?.publication as HubPublication
  }

  it('cancels before the hand-off; a repeat answers the cancelled one', async () => {
    const p = await approved('row-2')
    expect(canCancel(p.status)).toBe(true)
    hub.fail('lost_answer', { endpoint: 'publications.cancel' })
    const cancelled = await client.cancel(p.id)
    expect(cancelled.status).toBe('cancelled')
    expect((await client.cancel(p.id)).status).toBe('cancelled')
    expect(publicationRowState(cancelled.status)).toBe('cancelled')
  })

  it('after the hand-off only the owner cancels, in Hub', async () => {
    const p = await approved('row-3')
    hub.handToPlatform(p.id)
    const err = await client.cancel(p.id).catch((e) => e)
    expect(isHubError(err, 'refused', 'publication_handed_to_platform')).toBe(true)
    expect(err.status).toBe(409)
    expect(hub.calls('publications.cancel')).toHaveLength(1)
    expect(canCancel('scheduled')).toBe(false)
  })

  it('the changes feed carries statuses, reasons and the platform post, page by page', async () => {
    const start = hub.now()
    const a = await approved('row-4')
    const b = await approved('row-5')
    const c = await approved('row-6')
    hub.advance(60_000)
    hub.handToPlatform(a.id)
    hub.publish(a.id, '990001')
    hub.handToPlatform(b.id)
    hub.notPublish(b.id, 'platform_refused')
    await client.cancel(c.id)

    const all = await allChanges(null)
    expect(all.map((p) => p.id)).toEqual([a.id, b.id, c.id])
    const latest = new Map(all.map((p) => [p.id, p]))
    expect(latest.get(a.id)).toMatchObject({ status: 'published', platformPostRef: '990001' })
    expect(latest.get(b.id)).toMatchObject({
      status: 'not_published',
      statusReason: 'platform_refused',
    })
    expect(hub.calls('publications.changes').length).toBeGreaterThan(1)
    expect(hub.calls('publications.changes')[1]?.query.get('since')).toBeNull()

    const since = new Date(start.getTime() + 30_000)
    expect((await allChanges(since)).map((p) => p.id)).toEqual([a.id, b.id, c.id])
    expect(publicationRowState('published')).toBe('published')
    expect(publicationRowState('not_published')).toBe('not_published')
    expect(publicationRowState('scheduled')).toBe('scheduled')
    expect(publicationRowState('unknown')).toBe('unverified')
  })

  it('walls and tiers of the page, without prices', async () => {
    const fansly = await client.publicationTargets('page-a')
    expect(fansly.walls).toEqual([
      { wallRef: '7001', name: 'Main wall', defaultWall: true, mainWall: true },
    ])
    expect(fansly.tiers.map((t) => t.tierRef)).toEqual(['8001', '8002'])
    const of = await client.publicationTargets('page-b')
    expect(of).toMatchObject({ platform: 'onlyfans', walls: [], tiers: [] })
  })
})
