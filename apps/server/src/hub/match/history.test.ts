import { randomBytes, randomUUID } from 'node:crypto'
import { type Db, enqueueWork, SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { type FakeHub, startFakeHub } from '@contentops/hub/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CreatedItem, createCatalogItems } from '../../testing/catalog-factory'
import { call, OWNER, signIn, type TestServer, testServer } from '../../testing/server'
import { hubSyncHandler } from '../sync'
import { fakeClient, type PageIds, pageIds, runHubWork, setHubPage, syncOnce } from '../testing'
import { enqueueHistory, hubHistoryHandler } from './auto'
import { pageOf } from './load'
import {
  evidenceOf,
  hubFiles,
  hubPost,
  placementsOf,
  setPolicy,
  setSwitch,
  vaultFile,
} from './testing'
import { addEvidence, publicationPlacement } from './write'

/**
 * The history pass on a fake Hub and a real database (SPEC §7, the audit of the catalog of
 * 05.11.2026): a candidate needs a name — length and size alone are a hint; the kind, the day of
 * shooting and a video's length check the name; RAW takes part; the vault card's caption does not
 * hide the uploaded file's name; a custom with a PPV's bytes is that PPV. A repeat reviews the
 * pass's own earlier candidates: one the rules no longer give is taken back, a person's decision
 * stays. All names, refs and captions are fictional.
 */

let server: TestServer
let db: Db
let hub: FakeHub
let owner: string
let lora1: PageIds
let items: Map<string, CreatedItem>

const day = (date: string, time = '12:00') => new Date(`${date}T${time}:00+03:00`).toISOString()
const SAME_BYTES = randomBytes(32)

beforeAll(async () => {
  server = await testServer({ secrets: { hub: true } })
  db = server.db
  hub = await startFakeHub()
  hub.setNow(new Date())
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  lora1 = await pageIds(db, 'lora-1')
  await setHubPage(db, 'lora-1', 'page-a')
  await setSwitch(db, lora1, 'hub.receive', true)
  await setSwitch(db, lora1, 'hub.auto_match', true)
  await setPolicy(db, 'hub_exact_duration_ms', 200)
  // Matching started five days ago: older posts belong to the history pass.
  await withActorTx(
    db,
    { actor: SYSTEM_ACTOR('test'), action: 'test', requestId: randomUUID() },
    (tx) =>
      enqueueWork(tx, {
        modelId: lora1.modelId,
        kind: 'hub_history',
        workKey: `history:${lora1.accountId}:first`,
        accountId: lora1.accountId,
        dataset: 'history',
        windowTo: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      }),
  )
  const photo = { role: 'ed' as const, width: 3024, height: 4032 }
  const made = await createCatalogItems(db, 'lora', [
    {
      type: 'set',
      number: 81,
      title: 'Окно',
      secondPerson: false,
      files: [{ ...photo, name: 'IMG_5001.JPG', shotAt: day('2026-03-01') }],
    },
    {
      // A namesake from a later shooting: a post of March cannot be it.
      type: 'life',
      number: 91,
      title: 'Кофе',
      secondPerson: false,
      files: [
        { role: 'pic', width: 3024, height: 4032, name: 'IMG_5001.JPG', shotAt: day('2026-04-10') },
      ],
    },
    {
      type: 'sexting',
      number: 31,
      title: 'Зелёное',
      secondPerson: false,
      files: [
        {
          role: 'clip',
          durationS: 20,
          width: 1080,
          height: 1920,
          name: 'IMG_5100.MOV',
          shotAt: day('2026-03-02'),
        },
        { role: 'pic', width: 3024, height: 4032, name: 'IMG_5101.JPG', shotAt: day('2026-03-02') },
      ],
    },
    {
      type: 'raw',
      number: 91,
      title: 'Без даты',
      shotOn: '2026-02-01',
      secondPerson: false,
      files: [
        { role: 'raw', width: 960, height: 1280, name: '0B8F3C2A-5D41-4E7B-9A6C-1F2E3D4C5B6A.JPG' },
      ],
    },
    {
      type: 'fyp',
      number: 891,
      title: 'Ни разу',
      secondPerson: false,
      files: [{ role: 'master', durationS: 6, width: 1440, height: 2560, name: 'Never again.mp4' }],
    },
    {
      type: 'fyp',
      number: 892,
      title: 'Без имени',
      secondPerson: false,
      files: [{ role: 'master', durationS: 9, width: 1080, height: 1920 }],
    },
    {
      type: 'custom',
      number: 91,
      title: 'Заказ',
      secondPerson: false,
      files: [
        {
          role: 'master',
          durationS: 300,
          width: 1080,
          height: 1920,
          name: 'IMG_5200.MOV',
          sha256: [SAME_BYTES],
        },
      ],
    },
    {
      type: 'ppv',
      number: 91,
      title: 'Из заказа',
      ppvKind: 'bundle',
      secondPerson: false,
      files: [{ role: 'master', durationS: 300, width: 1080, height: 1920, sha256: [SAME_BYTES] }],
    },
  ])
  items = new Map(made.map((item) => [item.id, item]))
})
afterAll(async () => {
  await hub?.close()
  await server?.close()
})

const options = () => ({ client: () => fakeClient(hub).client })
const uid = (id: string) => items.get(id)?.uid as string
function assetOf(id: string, handle: string) {
  const file = items.get(id)?.files.get(handle)
  if (!file) throw new Error(`no ${id}/${handle}`)
  return file
}

async function historyWork(id: string) {
  const outcome = await runHubWork(db, id, hubSyncHandler(options()), {
    extra: { hub_history: hubHistoryHandler() },
  })
  expect(outcome.state, JSON.stringify(outcome)).toBe('succeeded')
  return outcome.report as Record<string, unknown>
}

/** A candidate the pass of before 05.11.2026 left: by length alone, or on a namesake. */
async function oldCandidate(
  postRef: string,
  itemId: string,
  asset: { assetId: string; versionIds: string[] },
  extra?: 'outside',
) {
  const page = await pageOf(db, lora1.accountId)
  if (!page) throw new Error('page')
  const { rows } = await db.execute<{ observation: string; published_at: string }>(sql`
    SELECT t.current_observation_id AS observation, p.published_at::text AS published_at
      FROM hub_posts p JOIN hub_post_attachments t ON t.model_id = p.model_id AND t.post_id = p.id
     WHERE p.post_ref = ${postRef} AND t.role = 'main'`)
  const file = rows[0] as { observation: string; published_at: string }
  await withActorTx(
    db,
    { actor: SYSTEM_ACTOR('hub'), action: 'hub.history', requestId: randomUUID() },
    async (tx) => {
      const placementId = await publicationPlacement(tx, page, {
        surface: 'wall',
        surfaceSource: 'hub_hint',
        refs: { kind: 'post', postRef },
        itemId,
        planRowId: null,
        occurredAt: new Date(file.published_at).toISOString(),
        origin: 'hub',
      })
      await addEvidence(tx, page, {
        placementId,
        source: 'hub',
        kind: 'observed',
        strength: 'candidate',
        observationId: file.observation,
        externalRef: postRef,
        matchedAssetId: asset.assetId,
        matchedVersionId: asset.versionIds.at(-1) as string,
        payload: {
          kind: 'history',
          by: 'shape',
          post_ref: postRef,
          published_at: file.published_at,
        },
        dedupKey: `cand:hist:${asset.assetId}:${file.observation}`,
      })
      if (extra === 'outside') {
        // «Не наше» — a person decided: the pass leaves this placement alone.
        await addEvidence(tx, page, {
          placementId,
          source: 'manual',
          kind: 'outside_catalog',
          strength: null,
          payload: { post_ref: postRef },
          dedupKey: `outside:${postRef}`,
        })
      }
    },
  )
}

describe('проход по истории', () => {
  it('кандидат только по имени; повтор снимает свои прежние кандидаты, решение человека не трогает', async () => {
    const posts: [string, string, Parameters<typeof hubFiles>[2][number]][] = [
      [
        'h-name',
        day('2026-03-12'),
        { media: 'm-name', name: 'IMG_5001.jpeg', video: false, width: 3024, height: 4032 },
      ],
      [
        'h-kind',
        day('2026-03-13'),
        { media: 'm-kind', name: 'IMG_5100.jpeg', video: false, width: 3024, height: 4032 },
      ],
      [
        'h-early',
        day('2026-02-25'),
        { media: 'm-early', name: 'IMG_5100.mp4', durationMs: 20_000 },
      ],
      ['h-shape', day('2026-03-14'), { media: 'm-shape', name: 'reel(18).mp4', durationMs: 9_050 }],
      [
        'h-raw',
        day('2026-03-15'),
        {
          media: 'm-raw',
          name: '0B8F3C2A-5D41-4E7B-9A6C-1F2E3D4C5B6A.jpeg',
          video: false,
          width: 960,
          height: 1280,
        },
      ],
      [
        'h-lossy',
        day('2026-03-16'),
        {
          media: 'm-lossy',
          name: 'Never again (louder).mp4',
          durationMs: 6_050,
          width: 1440,
          height: 2560,
        },
      ],
      ['h-human', day('2026-03-17'), { media: 'm-human', name: 'reel(19).mp4', durationMs: 9_020 }],
    ]
    hub.setNow(new Date())
    hub.put(
      'posts',
      'page-a',
      posts.map(([ref, at]) => hubPost(ref, at, { fypFlags: 4 })),
    )
    hub.put(
      'post_attachments',
      'page-a',
      posts.flatMap(([ref, at, file]) => hubFiles(ref, at, [file])),
    )
    const walked = new Date().toISOString()
    hub.put('vault_media', 'page-a', [
      // The card's caption is a download name of another file; the uploaded file's name is right.
      vaultFile('alb-31', 'SXT-031 Зелёное', 'mem-pic', 'v-pic', {
        name: 'SXT-031_pic07.jpeg',
        uploadName: 'IMG_5101.jpeg',
        video: false,
        width: 3024,
        height: 4032,
        walkedAt: walked,
        membershipAt: day('2026-03-20'),
        createdAt: day('2026-03-20'),
      }),
      // A pack numbered otherwise: the one clip of SXT-031 of this length and size.
      vaultFile('alb-31', 'SXT-031 Зелёное', 'mem-clip', 'v-clip', {
        name: 'SXT-031_05_clip03.mp4',
        durationMs: 20_000,
        walkedAt: walked,
        membershipAt: day('2026-03-20'),
        createdAt: day('2026-03-20'),
      }),
      // The bytes of a custom are the PPV made from it.
      vaultFile('alb-long', "PPV's LONG VIDS", 'mem-long', 'v-long', {
        name: 'stretching #oil',
        uploadName: 'IMG_5200.mp4',
        durationMs: 300_000,
        walkedAt: walked,
        membershipAt: day('2026-03-21'),
        createdAt: day('2026-03-21'),
      }),
    ])
    for (const dataset of ['posts', 'vault_media']) {
      const outcome = await syncOnce(db, lora1, dataset, options())
      expect(outcome.state, JSON.stringify(outcome)).toBe('succeeded')
    }
    // What the pass of before left: h-shape by length alone, h-name on the later namesake, and
    // h-human by length, answered «Не наше» by a person.
    await oldCandidate('h-shape', uid('FYP-0892'), assetOf('FYP-0892', 'master'))
    await oldCandidate('h-name', uid('LIFE-091'), assetOf('LIFE-091', 'pic01'))
    await oldCandidate('h-human', uid('FYP-0892'), assetOf('FYP-0892', 'master'), 'outside')

    const { rows: first } = await db.execute<{ id: string }>(sql`
      SELECT id FROM work_operations WHERE kind = 'hub_history'
         AND work_key = ${`history:${lora1.accountId}:first`}`)
    const report = await historyWork(first[0]?.id as string)
    expect(report).toMatchObject({
      posts: 6,
      candidates: 3,
      shape_hints: 1,
      rejected: { kind: 1, date: 1, duration: 0 },
      vault_files: 3,
      vault_candidates: 3,
      retracted: 2,
      released: 1,
    })

    const placements = await placementsOf(db, lora1)
    const byRef = (ref: string) =>
      placements.find((placement) => placement.external_post_ref === ref)
    const byMedia = (media: string) =>
      placements.find((placement) => placement.external_media_ref === media)
    expect(byRef('h-name')?.item_id).toBe(uid('SET-081'))
    expect(byRef('h-raw')?.item_id).toBe(uid('RAW-0091'))
    expect(byRef('h-lossy')?.item_id).toBe(uid('FYP-0891'))
    expect(byRef('h-kind')).toBeUndefined()
    expect(byRef('h-early')).toBeUndefined()
    // Nothing of the pass stands on it any more: the post is free again.
    expect(byRef('h-shape')?.item_id).toBeNull()
    expect(byRef('h-human')?.item_id).toBe(uid('FYP-0892'))
    expect(byMedia('v-pic')?.item_id).toBe(uid('SXT-031'))
    expect(byMedia('v-clip')?.item_id).toBe(uid('SXT-031'))
    expect(byMedia('v-long')?.item_id).toBe(uid('PPV-091'))

    const evidence = await evidenceOf(
      db,
      placements.map((placement) => placement.id),
    )
    const on = (id: string | undefined) => evidence.filter((entry) => entry.placement_id === id)
    const retracts = evidence.filter((entry) => entry.kind === 'retract')
    expect(retracts).toHaveLength(2)
    expect(
      retracts.every(
        (entry) => entry.source === 'manual' && entry.payload.kind === 'history_retract',
      ),
    ).toBe(true)
    const retracted = new Set(retracts.map((entry) => entry.corrects_id))
    expect(
      on(byRef('h-shape')?.id)
        .filter((entry) => entry.kind === 'observed')
        .every((entry) => retracted.has(entry.id)),
    ).toBe(true)
    // The namesake taken back, the right object's candidate added to the same placement.
    const name = on(byRef('h-name')?.id).filter((entry) => entry.kind === 'observed')
    expect(name.map((entry) => retracted.has(entry.id))).toEqual([true, false])
    expect(name[1]?.payload).toMatchObject({ kind: 'history', by: 'name' })
    expect(on(byRef('h-human')?.id).some((entry) => retracted.has(entry.id))).toBe(false)
    expect(on(byMedia('v-clip')?.id)[0]?.payload).toMatchObject({ by: 'download_name' })

    const object = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/i/SET-081',
      as: owner,
    })
    expect(object.statusCode, object.body).toBe(200)
    expect(JSON.stringify(object.json().pages)).toContain('похоже, выходило')

    // Hub observes a file again (a length refined by 10 ms): the same file, the same candidate.
    hub.setNow(new Date(Date.now() + 60_000))
    const [, lossyAt, lossy] = posts.find(([ref]) => ref === 'h-lossy') as (typeof posts)[number]
    hub.put(
      'post_attachments',
      'page-a',
      hubFiles('h-lossy', lossyAt, [{ ...lossy, durationMs: 6_060 }]),
    )
    expect((await syncOnce(db, lora1, 'posts', options())).state).toBe('succeeded')
    // The pass again after a batch: the same rules give the same answer, nothing is written.
    const again = await withActorTx(
      db,
      { actor: SYSTEM_ACTOR('ops'), action: 'hub.history.enqueue', requestId: randomUUID() },
      (tx) => enqueueHistory(tx, lora1, 'batch-test'),
    )
    const repeat = await historyWork(again.id)
    expect(repeat).toMatchObject({ candidates: 3, vault_candidates: 3, retracted: 0, released: 0 })
    const after = await evidenceOf(
      db,
      (await placementsOf(db, lora1)).map((placement) => placement.id),
    )
    expect(after).toHaveLength(evidence.length)
  })
})
