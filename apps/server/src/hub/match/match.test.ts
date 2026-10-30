import { randomUUID } from 'node:crypto'
import { addDays } from '@contentops/contracts/clock'
import type { PlanRow } from '@contentops/contracts/domain/plan'
import { type Db, enqueueWork, SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { type FakeHub, startFakeHub } from '@contentops/hub/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCatalogItems } from '../../testing/catalog-factory'
import { addPerson, call, OWNER, signIn, type TestServer, testServer } from '../../testing/server'
import { hubSyncHandler } from '../sync'
import { fakeClient, type PageIds, pageIds, runHubWork, setHubPage, syncOnce } from '../testing'
import { hubHistoryHandler } from './auto'
import {
  evidenceOf,
  forYou,
  hubFiles,
  hubPost,
  issue,
  placementsOf,
  putRows,
  rowFiles,
  setPolicy,
  setSwitch,
  vaultFile,
} from './testing'

/**
 * Matching after the Hub poll (SPEC §7, schema §9.6, PLAN 5) on a fake Hub and a real database:
 * exact by name needs an issued file, its size and duration; the surface by For You views, flag
 * 4 or no video, else the KM mark or «стена или фуп?»; candidates by window and count; repeats
 * write nothing. All refs, names and captions are fictional.
 */

let server: TestServer
let db: Db
let hub: FakeHub
let owner: string
let diana: { id: string; session: string }
let lora1: PageIds
let loraOf: PageIds
let modelId: string

const TODAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })
const YESTERDAY = addDays(TODAY, -1)
/** An instant of yesterday in Moscow. */
const at = (time: string, date = YESTERDAY) => new Date(`${date}T${time}:00+03:00`).toISOString()

beforeAll(async () => {
  server = await testServer({ secrets: { hub: true } })
  db = server.db
  hub = await startFakeHub()
  hub.setNow(new Date())
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  diana = await addPerson(server.app, owner, {
    name: 'Диана',
    login: 'diana',
    role: 'manager',
    models: ['lora'],
  })
  lora1 = await pageIds(db, 'lora-1')
  loraOf = await pageIds(db, 'lora-of')
  modelId = lora1.modelId
  await setHubPage(db, 'lora-1', 'page-a')
  await setHubPage(db, 'lora-of', 'page-b')
  for (const page of [lora1, loraOf]) {
    await setSwitch(db, page, 'hub.receive', true)
    await setSwitch(db, page, 'hub.auto_match', true)
    // Matching started five days ago: older posts belong to the history pass.
    await withActorTx(
      db,
      { actor: SYSTEM_ACTOR('test'), action: 'test', requestId: randomUUID() },
      (tx) =>
        enqueueWork(tx, {
          modelId: page.modelId,
          kind: 'hub_history',
          workKey: `history:${page.accountId}:first`,
          accountId: page.accountId,
          dataset: 'history',
          windowTo: new Date(Date.now() - 5 * 86_400_000).toISOString(),
        }),
    )
  }
  await setPolicy(db, 'hub_candidate_tolerance', 30)
  await setPolicy(db, 'hub_exact_duration_ms', 200)
  await createCatalogItems(db, 'lora', [
    {
      type: 'fyp',
      number: 801,
      title: 'Зеркало',
      secondPerson: false,
      files: [{ role: 'master', durationS: 9, width: 1080, height: 1920 }],
    },
    {
      type: 'fyp',
      number: 802,
      title: 'Окно',
      secondPerson: false,
      files: [{ role: 'master', durationS: 12, width: 1080, height: 1920 }],
    },
    {
      type: 'fyp',
      number: 803,
      title: 'Лестница',
      secondPerson: false,
      files: [{ role: 'master', durationS: 15, width: 720, height: 1280 }],
    },
    {
      type: 'ppv',
      number: 90,
      title: 'Лестница',
      ppvKind: 'bundle',
      secondPerson: false,
      files: [
        { role: 'master', durationS: 15, width: 720, height: 1280 },
        { role: 'teaser', durationS: 5, width: 720, height: 1280 },
      ],
    },
    {
      type: 'set',
      number: 76,
      title: 'Пледы',
      secondPerson: false,
      files: [
        { role: 'ed', selected: true, width: 1000, height: 1500 },
        { role: 'ed', selected: true, width: 1000, height: 1500 },
        { role: 'ed', selected: true, width: 1000, height: 1500 },
      ],
    },
    {
      type: 'set',
      number: 77,
      title: 'Утро',
      secondPerson: false,
      files: [{ role: 'ed', selected: true, width: 1300, height: 1950 }],
    },
    {
      type: 'sexting',
      number: 12,
      title: 'Розовое',
      secondPerson: false,
      files: [{ role: 'clip', durationS: 20, width: 1080, height: 1920 }],
    },
    {
      type: 'sexting',
      number: 13,
      title: 'Голубое',
      secondPerson: false,
      files: [{ role: 'clip', durationS: 21, width: 1080, height: 1920 }],
    },
    {
      type: 'sexting',
      number: 14,
      title: 'Зелёное',
      secondPerson: false,
      files: [{ role: 'clip', durationS: 22, width: 1080, height: 1920 }],
    },
    {
      type: 'set',
      number: 74,
      title: 'Кружево',
      secondPerson: false,
      files: [
        { role: 'ed', selected: true, width: 1200, height: 1800 },
        { role: 'ed', selected: true, width: 1200, height: 1800 },
        { role: 'ed', selected: true, width: 1200, height: 1800 },
      ],
    },
  ])
})
afterAll(async () => {
  await hub?.close()
  await server?.close()
})

const options = () => ({ client: () => fakeClient(hub).client })

async function poll(page: PageIds, dataset = 'posts') {
  const outcome = await syncOnce(db, page, dataset, options())
  expect(outcome.state, JSON.stringify(outcome)).toBe('succeeded')
  return outcome.report?.match as Record<string, unknown> | null
}

async function rowView(id: string): Promise<PlanRow> {
  const response = await call(server.app, {
    method: 'GET',
    url: `/api/v1/lora/plan/rows/${id}`,
    as: owner,
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

describe('точное по имени и поверхность', () => {
  it('файл с выданным именем, размером и длительностью — точное; поверхность ждёт просмотров For You', async () => {
    const [row] = await putRows(server, diana.session, [
      { item_id: 'FYP-0801', surface: 'fyp', date: YESTERDAY, time: '03:00' },
    ])
    const files = await rowFiles(db, row?.id as string)
    const master = files[0] as (typeof files)[number]
    const name = `FYP-0801_zerkalo_master__lora-1_${YESTERDAY}_0300.mp4`
    await issue(db, {
      modelId,
      principalId: diana.id,
      manifestId: master.manifestId,
      planRowId: row?.id ?? null,
      files: [{ ...master, name, durationMs: 9_000, width: 1080, height: 1920 }],
    })
    hub.setNow(new Date())
    hub.put('posts', 'page-a', [hubPost('p-fyp-1', at('03:06'))])
    hub.put(
      'post_attachments',
      'page-a',
      hubFiles('p-fyp-1', at('03:06'), [
        { media: 'm-fyp-1', name: name.toUpperCase(), durationMs: 9_100 },
      ]),
    )
    const report = await poll(lora1)
    expect(report?.files_exact).toBe(1)
    // An unmarked FYP row and no For You views yet: «стена или фуп?», no placement of the post.
    const before = await rowView(row?.id as string)
    expect(before.verdict.level).toBe('surface_unknown')
    const placements = (await placementsOf(db, lora1)).filter((p) => p.plan_row_id === row?.id)
    expect(placements.map((p) => p.external_post_ref)).toEqual([null])

    // For You views arrive the next day: the surface is proven, the row is exact.
    hub.setNow(new Date())
    hub.put('creator_stats_media_daily', 'page-a', [forYou('m-fyp-1', TODAY, 120)])
    await poll(lora1, 'creator_stats')
    const after = await rowView(row?.id as string)
    expect(after.verdict.level).toBe('confirmed_hub_unmarked')
    const linked = (await placementsOf(db, lora1)).filter((p) => p.plan_row_id === row?.id)
    expect(linked).toHaveLength(1)
    expect(linked[0]).toMatchObject({
      external_post_ref: 'p-fyp-1',
      surface: 'fyp',
      surface_source: 'hub',
      views: '120',
    })
    const evidence = await evidenceOf(
      db,
      linked.map((p) => p.id),
    )
    expect(evidence.filter((e) => e.strength === 'exact').map((e) => e.dedup_key)[0]).toMatch(
      /^exact:m-fyp-1:/,
    )

    // A repeat writes nothing.
    const count = evidence.length
    await poll(lora1)
    expect(
      await evidenceOf(
        db,
        linked.map((p) => p.id),
      ),
    ).toHaveLength(count)
  })
})

describe('кандидаты: окно, число файлов, пачки', () => {
  it('строка с одним файлом — только пост с одним файлом; одна пара — кандидат, две — варианты', async () => {
    const [single, other] = await putRows(server, diana.session, [
      { item_id: 'FYP-0802', surface: 'fyp', date: YESTERDAY, time: '06:00' },
      { item_id: 'FYP-0802', surface: 'fyp', date: YESTERDAY, time: '12:00' },
    ])
    hub.setNow(new Date())
    hub.put('posts', 'page-a', [
      hubPost('p-two-files', at('06:04'), { files: 2 }),
      hubPost('p-one-a', at('06:10')),
      hubPost('p-one-b', at('12:05')),
      hubPost('p-one-c', at('12:20')),
      // The same day outside the window: a hint, nothing written.
      hubPost('p-late', at('18:00')),
    ])
    hub.put('post_attachments', 'page-a', [
      ...hubFiles('p-two-files', at('06:04'), [{ media: 'm-2a' }, { media: 'm-2b' }]),
      ...hubFiles('p-one-a', at('06:10'), [{ media: 'm-1a', durationMs: 12_000 }]),
      ...hubFiles('p-one-b', at('12:05'), [{ media: 'm-1b', durationMs: 12_000 }]),
      ...hubFiles('p-one-c', at('12:20'), [{ media: 'm-1c', durationMs: 12_000 }]),
      ...hubFiles('p-late', at('18:00'), [{ media: 'm-late', durationMs: 12_000 }]),
    ])
    await poll(lora1)
    const first = await rowView(single?.id as string)
    expect(first.verdict.level).toBe('candidate')
    expect(first.verdict.reason).toContain('видео 0:12')
    const second = await rowView(other?.id as string)
    expect(second.verdict.level).toBe('candidates_multiple')
    expect(second.verdict.detail).toBe('2 варианта')
    const keys = (
      await evidenceOf(
        db,
        (await placementsOf(db, lora1)).map((p) => p.id),
      )
    ).map((e) => e.payload.post_ref)
    expect(keys).not.toContain('p-two-files')
    expect(keys).not.toContain('p-late')
  })

  it('пачка — пост с несколькими файлами, равно или ±1 с пометкой; на два больше — не пара', async () => {
    const [bundle] = await putRows(server, diana.session, [
      { item_id: 'SET-074', surface: 'wall', date: YESTERDAY, time: '20:00' },
    ])
    const photo = (media: string) => ({ media, video: false, width: 1200, height: 1800 })
    hub.setNow(new Date())
    hub.put('posts', 'page-a', [
      hubPost('p-set-4', at('20:03'), { fypFlags: 4 }),
      hubPost('p-set-5', at('20:10'), { fypFlags: 4 }),
    ])
    hub.put('post_attachments', 'page-a', [
      ...hubFiles('p-set-4', at('20:03'), [photo('s4a'), photo('s4b'), photo('s4c'), photo('s4d')]),
      ...hubFiles('p-set-5', at('20:10'), [
        photo('s5a'),
        photo('s5b'),
        photo('s5c'),
        photo('s5d'),
        photo('s5e'),
      ]),
    ])
    await poll(lora1)
    const view = await rowView(bundle?.id as string)
    expect(view.verdict.level).toBe('candidate')
    expect(view.verdict.reason).toContain('в посте 4 файлов из 3')
  })
})

describe('«не вышло» и выключенный Hub', () => {
  it('до E7 «не вышло» по постам не строится: после окна — «нет доказательства покрытия постов»', async () => {
    await setPolicy(db, 'hub_not_out_window', 24)
    const [row] = await putRows(server, diana.session, [
      { item_id: 'FYP-0802', surface: 'fyp', date: addDays(TODAY, -3), time: '09:00' },
    ])
    await call(server.app, {
      method: 'POST',
      url: `/api/v1/lora/plan/rows/${row?.id}:mark`,
      as: diana.session,
      key: `mark-${row?.id}`,
      body: { kind: 'posted', stated_occurred_at: null },
    })
    // The mark was three days ago: both windows are long past.
    await withActorTx(
      db,
      { actor: SYSTEM_ACTOR('test'), action: 'test', requestId: randomUUID() },
      (tx) =>
        tx.execute(
          sql`UPDATE posting_plan_rows SET marked_at = now() - interval '3 days' WHERE id = ${row?.id}::uuid`,
        ),
    )
    const view = await rowView(row?.id as string)
    expect(view.verdict.level).toBe('cannot_verify')
    expect(view.verdict.reason).toBe('Нет доказательства покрытия постов')
    expect(view.mark_button).toBe('mark')
  })

  it('выключенная автосверка не даёт «не вышло» и возвращает «Отметить и подтвердить»', async () => {
    await setSwitch(db, lora1, 'hub.auto_match', false)
    try {
      const [row] = await putRows(server, diana.session, [
        { item_id: 'FYP-0802', surface: 'fyp', date: addDays(TODAY, -4), time: '09:00' },
      ])
      const view = await rowView(row?.id as string)
      expect(view.verdict.level).not.toBe('not_published')
      expect(view.mark_button).toBe('mark_confirm')
      // Matching stands still while it is off: the poll writes no evidence.
      const before = (
        await evidenceOf(
          db,
          (await placementsOf(db, lora1)).map((p) => p.id),
        )
      ).length
      hub.setNow(new Date())
      hub.put('posts', 'page-a', [hubPost('p-off', at('09:02', addDays(TODAY, -4)))])
      hub.put(
        'post_attachments',
        'page-a',
        hubFiles('p-off', at('09:02', addDays(TODAY, -4)), [
          { media: 'm-off', durationMs: 12_000 },
        ]),
      )
      expect(await poll(lora1)).toBeNull()
      expect(
        (
          await evidenceOf(
            db,
            (await placementsOf(db, lora1)).map((p) => p.id),
          )
        ).length,
      ).toBe(before)
    } finally {
      await setSwitch(db, lora1, 'hub.auto_match', true)
    }
  })
})

describe('одна публикация — одно размещение', () => {
  it('стена и FYP одного поста — два размещения с общим внешним ID', async () => {
    const [row] = await putRows(server, diana.session, [
      { item_id: 'PPV-090', surface: 'wall', date: YESTERDAY, time: '15:00' },
    ])
    await call(server.app, {
      method: 'POST',
      url: `/api/v1/lora/plan/rows/${row?.id}:mark`,
      as: diana.session,
      key: `mark-wall-${row?.id}`,
      body: { kind: 'posted', stated_occurred_at: null },
    })
    const [master] = (await rowFiles(db, row?.id as string)).filter(
      (file) => file.role === 'master',
    )
    const name = `PPV-090_lestnitsa_master__lora-1_${YESTERDAY}_1500__0m15s.mp4`
    await issue(db, {
      modelId,
      principalId: diana.id,
      manifestId: master?.manifestId as string,
      files: [
        {
          ...(master as NonNullable<typeof master>),
          name,
          durationMs: 15_000,
          width: 720,
          height: 1280,
        },
      ],
    })
    hub.setNow(new Date())
    hub.put('posts', 'page-a', [hubPost('p-both', at('15:02'))])
    hub.put(
      'post_attachments',
      'page-a',
      hubFiles('p-both', at('15:02'), [
        { media: 'm-both', name, durationMs: 15_000, width: 720, height: 1280 },
        // The video preview carries the main file's name and gives no exact (V2 № 3).
        {
          media: 'm-both-preview',
          name,
          durationMs: 5_000,
          width: 720,
          height: 1280,
          role: 'offer_preview',
        },
      ]),
    )
    hub.put('creator_stats_media_daily', 'page-a', [forYou('m-both', TODAY, 0)])
    await poll(lora1)
    await poll(lora1, 'creator_stats')
    const both = (await placementsOf(db, lora1)).filter((p) => p.external_post_ref === 'p-both')
    expect(both.map((p) => [p.surface, p.plan_row_id === row?.id]).sort()).toEqual([['wall', true]])
    // For You views make it FYP too: a second placement with the same post.
    hub.setNow(new Date())
    hub.put('creator_stats_media_daily', 'page-a', [forYou('m-both', TODAY, 40)])
    await poll(lora1, 'creator_stats')
    const two = (await placementsOf(db, lora1)).filter((p) => p.external_post_ref === 'p-both')
    expect(two.map((p) => p.surface).sort()).toEqual(['fyp', 'wall'])
    expect(two.find((p) => p.surface === 'wall')?.manual_key).toBe(`row:${row?.id}`)
    expect((await rowView(row?.id as string)).verdict.level).toBe('confirmed_exact')
  })

  it('заявка легаси и найденный позже пост — одно размещение с дописанной уликой', async () => {
    const { rows } = await db.execute<{ id: string; type: string; surface_id: string }>(sql`
      SELECT i.id, i.type, s.id AS surface_id FROM content_items i, surfaces s
       WHERE i.model_id = ${modelId}::uuid AND i.type = 'SET' AND i.number = 77
         AND s.account_id = ${lora1.accountId}::uuid AND s.kind = 'wall'`)
    const item = rows[0] as { id: string; type: string; surface_id: string }
    const day = addDays(TODAY, -2)
    await withActorTx(
      db,
      { actor: SYSTEM_ACTOR('test'), action: 'test', requestId: randomUUID() },
      (tx) =>
        tx.execute(sql`
        INSERT INTO placements (model_id, account_id, surface_id, occurrence_kind, manual_key, item_id,
                                item_type, occurred_at, event_precision, occurred_source,
                                surface_source, origin)
        VALUES (${modelId}::uuid, ${lora1.accountId}::uuid, ${item.surface_id}::uuid, 'manual',
                ${`legacy:${item.id}:${day}`}, ${item.id}::uuid, 'SET',
                (${day}::date)::timestamp AT TIME ZONE 'Europe/Moscow', 'day', 'import', 'import', 'import')`),
    )
    const { rows: files } = await db.execute<{
      asset_id: string
      version_id: string
      manifest_id: string
    }>(sql`
      SELECT a.id AS asset_id, a.current_version_id AS version_id,
             (SELECT id FROM asset_manifests WHERE model_id = a.model_id LIMIT 1) AS manifest_id
        FROM assets a WHERE a.model_id = ${modelId}::uuid AND a.created_in_item_id = ${item.id}::uuid`)
    const file = files[0] as { asset_id: string; version_id: string; manifest_id: string }
    const name = 'SET-077_utro_ed01.jpg'
    await issue(db, {
      modelId,
      principalId: diana.id,
      manifestId: file.manifest_id,
      files: [
        {
          assetId: file.asset_id,
          versionId: file.version_id,
          name,
          durationMs: null,
          width: 1300,
          height: 1950,
        },
      ],
    })
    hub.setNow(new Date())
    hub.put('posts', 'page-a', [hubPost('p-legacy', at('11:00', day))])
    hub.put(
      'post_attachments',
      'page-a',
      hubFiles('p-legacy', at('11:00', day), [
        { media: 'm-legacy', name, video: false, width: 1950, height: 1300 },
      ]),
    )
    await poll(lora1)
    const mine = (await placementsOf(db, lora1)).filter((p) => p.item_id === item.id)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({
      manual_key: `legacy:${item.id}:${day}`,
      external_post_ref: 'p-legacy',
    })
    const evidence = await evidenceOf(db, [mine[0]?.id as string])
    expect(evidence.map((e) => [e.source, e.strength])).toEqual([['hub', 'exact']])
  })

  it('пост, связанный через публикацию Hub, не сопоставляется', async () => {
    const [row] = await putRows(server, diana.session, [
      { item_id: 'FYP-0802', surface: 'fyp', date: YESTERDAY, time: '22:00' },
    ])
    await withActorTx(
      db,
      { actor: SYSTEM_ACTOR('test'), action: 'test', requestId: randomUUID() },
      (tx) =>
        tx.execute(sql`UPDATE posting_plan_rows
                          SET hub_publication_id = 9001, hub_kind = 'fyp_post', hub_status = 'published',
                              hub_version = 1, hub_updated_at = now(), hub_prepared_at = now(),
                              platform_post_ref = 'p-pub'
                        WHERE id = ${row?.id}::uuid`),
    )
    hub.setNow(new Date())
    hub.put('posts', 'page-a', [hubPost('p-pub', at('22:01'))])
    hub.put(
      'post_attachments',
      'page-a',
      hubFiles('p-pub', at('22:01'), [{ media: 'm-pub', durationMs: 12_000 }]),
    )
    await poll(lora1)
    const evidence = await evidenceOf(
      db,
      (await placementsOf(db, lora1)).map((p) => p.id),
    )
    expect(evidence.some((e) => e.payload.post_ref === 'p-pub')).toBe(false)
    expect(evidence.some((e) => e.payload.plan_row_id === row?.id)).toBe(false)
  })
})

describe('совпало k из n, A→B→A, показатели', () => {
  it('часть файлов по имени — «совпало k из n», не точное', async () => {
    const [row] = await putRows(server, diana.session, [
      { item_id: 'SET-076', surface: 'wall', date: YESTERDAY, time: '17:00' },
    ])
    const files = await rowFiles(db, row?.id as string)
    const names = files.map((_, i) => `SET-076_pledy_ed0${i + 1}__lora-1_${YESTERDAY}_1700.jpg`)
    await issue(db, {
      modelId,
      principalId: diana.id,
      manifestId: files[0]?.manifestId as string,
      files: files.slice(0, 2).map((file, i) => ({
        ...file,
        name: names[i] as string,
        durationMs: null,
        width: 1000,
        height: 1500,
      })),
    })
    hub.setNow(new Date())
    hub.put('posts', 'page-a', [hubPost('p-kn', at('17:04'), { fypFlags: 4 })])
    hub.put(
      'post_attachments',
      'page-a',
      hubFiles('p-kn', at('17:04'), [
        { media: 'kn-1', name: names[0], video: false, width: 1000, height: 1500, member: 0 },
        { media: 'kn-2', name: names[1], video: false, width: 1000, height: 1500, member: 1 },
        // The third name has no issued file: the name alone is not exact.
        { media: 'kn-3', name: names[2], video: false, width: 1000, height: 1500, member: 2 },
      ]),
    )
    await poll(lora1)
    const view = await rowView(row?.id as string)
    expect(view.verdict.level).toBe('partial_match')
    expect(view.verdict.detail).toBe('совпало 2 из 3')
  })

  it('подпись A→B→A — три улики-кандидата, повтор без изменений — ни одной', async () => {
    const [row] = await putRows(server, diana.session, [
      { item_id: 'FYP-0802', surface: 'fyp', date: YESTERDAY, time: '23:30' },
    ])
    const post = (caption: string) => hubPost('p-aba', at('23:31'), { caption })
    hub.setNow(new Date())
    hub.put('posts', 'page-a', [post('A')])
    hub.put(
      'post_attachments',
      'page-a',
      hubFiles('p-aba', at('23:31'), [{ media: 'm-aba', durationMs: 12_000 }]),
    )
    const keys = async () =>
      (
        await evidenceOf(
          db,
          (await placementsOf(db, lora1)).filter((p) => p.plan_row_id === row?.id).map((p) => p.id),
        )
      ).map((e) => e.dedup_key)
    await poll(lora1)
    hub.setNow(new Date(Date.now() + 1000))
    hub.put('posts', 'page-a', [post('B')])
    await poll(lora1)
    hub.setNow(new Date(Date.now() + 2000))
    hub.put('posts', 'page-a', [post('A')])
    await poll(lora1)
    const three = await keys()
    expect(new Set(three).size).toBe(3)
    await poll(lora1)
    expect(await keys()).toHaveLength(3)
  })

  it('показатели: нет строк — «нет данных» (null), нулевые просмотры — 0', async () => {
    const placements = await placementsOf(db, lora1)
    expect(placements.find((p) => p.external_post_ref === 'p-legacy')?.views).toBeNull()
    hub.setNow(new Date())
    hub.put('creator_stats_media_daily', 'page-a', [forYou('m-legacy', TODAY, 0, 1)])
    await poll(lora1, 'creator_stats')
    const after = await placementsOf(db, lora1)
    expect(after.find((p) => p.external_post_ref === 'p-legacy')?.views).toBe('0')
    expect(after.find((p) => p.external_post_ref === 'p-fyp-1')?.views).toBe('120')
  })
})

describe('OnlyFans', () => {
  it('точного по имени нет: файл с именем скачивания — только кандидат', async () => {
    const [row] = await putRows(server, diana.session, [
      { item_id: 'SET-076', account: 'lora-of', surface: 'wall', date: YESTERDAY, time: '19:00' },
    ])
    const files = await rowFiles(db, row?.id as string)
    const names = files.map((_, i) => `SET-076_pledy_ed0${i + 1}__lora-of_${YESTERDAY}_1900.jpg`)
    await issue(db, {
      modelId,
      principalId: diana.id,
      manifestId: files[0]?.manifestId as string,
      files: files.map((file, i) => ({
        ...file,
        name: names[i] as string,
        durationMs: null,
        width: 1000,
        height: 1500,
      })),
    })
    hub.setNow(new Date())
    hub.put('posts', 'page-b', [hubPost('of-1', at('19:05'), { platform: 'onlyfans', files: 3 })])
    hub.put(
      'post_attachments',
      'page-b',
      hubFiles(
        'of-1',
        at('19:05'),
        names.map((name, i) => ({
          media: `of-1-${i}`,
          name,
          video: false,
          width: 1000,
          height: 1500,
        })),
        'onlyfans',
      ),
    )
    await poll(loraOf)
    const view = await rowView(row?.id as string)
    expect(view.verdict.level).toBe('candidate')
    const evidence = await evidenceOf(
      db,
      (await placementsOf(db, loraOf)).map((p) => p.id),
    )
    expect(evidence.some((e) => e.strength === 'exact')).toBe(false)
    expect(evidence.find((e) => e.payload.post_ref === 'of-1')?.payload.unambiguous).toBe(false)
  })

  it('длительность видео в пределах 1 с — кандидат, дальше — расхождение', async () => {
    const [near, far] = await putRows(server, diana.session, [
      {
        item_id: 'PPV-090',
        account: 'lora-of',
        surface: 'wall',
        date: addDays(TODAY, -2),
        time: '21:00',
      },
      {
        item_id: 'PPV-090',
        account: 'lora-of',
        surface: 'wall',
        date: addDays(TODAY, -3),
        time: '21:00',
      },
    ])
    const day2 = addDays(TODAY, -2)
    const day3 = addDays(TODAY, -3)
    hub.setNow(new Date())
    hub.put('posts', 'page-b', [
      hubPost('of-near', at('21:03', day2), { platform: 'onlyfans' }),
      hubPost('of-far', at('21:03', day3), { platform: 'onlyfans' }),
    ])
    hub.put('post_attachments', 'page-b', [
      ...hubFiles(
        'of-near',
        at('21:03', day2),
        [{ media: 'of-near-1', durationMs: 15_000, width: null, height: null }],
        'onlyfans',
      ),
      ...hubFiles(
        'of-far',
        at('21:03', day3),
        [{ media: 'of-far-1', durationMs: 17_000, width: null, height: null }],
        'onlyfans',
      ),
    ])
    await poll(loraOf)
    expect((await rowView(near?.id as string)).verdict.level).toBe('candidate')
    const mismatch = await rowView(far?.id as string)
    expect(mismatch.verdict.level).toBe('mismatch')
    expect(mismatch.verdict.detail).toBe('длительность 0:15 и 0:17')
  })
})

describe('vault', () => {
  it('«в альбоме нет файла» — только по полному обходу альбома после срока строки', async () => {
    const [row] = await putRows(server, diana.session, [
      { item_id: 'SXT-012', surface: 'vault', date: YESTERDAY, time: null },
    ])
    hub.setNow(new Date())
    hub.put('vault_media', 'page-a', [
      vaultFile('alb-12', 'SXT-012 Розовое', 'mem-12', 'm-12-other', {
        walkedAt: at('10:00'),
        durationMs: 5_000,
      }),
    ])
    await poll(lora1, 'vault_media')
    expect((await rowView(row?.id as string)).verdict.level).not.toBe('vault_missing')
    hub.setNow(new Date())
    hub.put('vault_media', 'page-a', [
      vaultFile('alb-12', 'SXT-012 Розовое', 'mem-12', 'm-12-other', {
        walkedAt: new Date().toISOString(),
        durationMs: 5_000,
      }),
    ])
    await poll(lora1, 'vault_media')
    const view = await rowView(row?.id as string)
    expect(view.verdict.level).toBe('vault_missing')
    expect(view.verdict.reason).toContain('Альбом «SXT-012 Розовое» обойдён')
  })

  it('файл в нужном альбоме по длительности и размерам — кандидат; по выданному имени — точное', async () => {
    const [candidate, exact] = await putRows(server, diana.session, [
      { item_id: 'SXT-013', surface: 'vault', date: YESTERDAY, time: null },
      { item_id: 'SXT-014', surface: 'vault', date: YESTERDAY, time: null },
    ])
    const [clip] = await rowFiles(db, exact?.id as string)
    const name = 'SXT-014_zelenoe_clip01__lora-1_2026-10-29.mp4'
    await issue(db, {
      modelId,
      principalId: diana.id,
      manifestId: clip?.manifestId as string,
      files: [
        {
          ...(clip as NonNullable<typeof clip>),
          name,
          durationMs: 22_000,
          width: 1080,
          height: 1920,
        },
      ],
    })
    hub.setNow(new Date())
    hub.put('vault_media', 'page-a', [
      vaultFile('alb-13', 'SXT-013 Голубое', 'mem-13', 'm-13', {
        walkedAt: new Date().toISOString(),
        durationMs: 21_100,
      }),
      // A bin album: only the issued name ties the file to its object.
      vaultFile('alb-bin', 'Sexting', 'mem-14', 'm-14', {
        name,
        walkedAt: new Date().toISOString(),
        durationMs: 22_050,
      }),
      // A system album without a title makes no placement.
      vaultFile('alb-all', '', 'mem-all', 'm-14', {
        name,
        walkedAt: new Date().toISOString(),
        durationMs: 22_050,
      }),
    ])
    await poll(lora1, 'vault_media')
    expect((await rowView(candidate?.id as string)).verdict.level).toBe('candidate')
    expect((await rowView(exact?.id as string)).verdict.level).toBe('confirmed_hub_unmarked')
    const vault = (await placementsOf(db, lora1)).filter((p) => p.surface === 'vault')
    expect(vault.some((p) => p.external_album_ref === 'alb-all')).toBe(false)
    expect(vault.find((p) => p.external_media_ref === 'm-14')?.plan_row_id).toBe(exact?.id)
  })
})

describe('без плана: реклама и проход по истории', () => {
  it('реклама чужой страницы скрыта, за сутки одно событие «скрыто как реклама»', async () => {
    await setPolicy(db, 'hub_ad_markers', { tags: ['#ads'], own_handles: ['loravie'] }, lora1)
    hub.setNow(new Date())
    hub.put('posts', 'page-a', [
      hubPost('p-ad', at('13:00'), { caption: 'Follow @someone_else #ads' }),
      hubPost('p-own', at('13:30'), { caption: 'Hi from @loravie' }),
    ])
    hub.put('post_attachments', 'page-a', [
      ...hubFiles('p-ad', at('13:00'), [{ media: 'm-ad', video: false, width: 640, height: 640 }]),
      ...hubFiles('p-own', at('13:30'), [
        { media: 'm-own', video: false, width: 641, height: 641 },
      ]),
    ])
    const report = await poll(lora1)
    expect(report?.ads_hidden).toBe(1)
    await poll(lora1)
    const { rows } = await db.execute<{ after: Record<string, unknown> }>(sql`
      SELECT after FROM action_log WHERE action = 'hub.ads_hidden' AND subject_id = ${lora1.accountId}::uuid`)
    expect(rows.map((row) => row.after)).toEqual([{ день: YESTERDAY, 'скрыто как реклама': 1 }])
  })

  it('история страницы: единственное совпадение — кандидат без плана, спорное и фото по размерам — «неизвестно»', async () => {
    const old = (day: string) => new Date(`${day}T12:00:00+03:00`).toISOString()
    hub.setNow(new Date())
    hub.put('posts', 'page-a', [
      hubPost('h-1', old('2026-03-12')),
      hubPost('h-2', old('2026-03-13')),
      hubPost('h-3', old('2026-03-14'), { fypFlags: 4 }),
      hubPost('h-4', old('2026-03-15')),
    ])
    hub.put('post_attachments', 'page-a', [
      ...hubFiles('h-1', old('2026-03-12'), [{ media: 'h-1', durationMs: 12_050 }]),
      ...hubFiles('h-2', old('2026-03-13'), [
        { media: 'h-2', durationMs: 15_000, width: 720, height: 1280 },
      ]),
      ...hubFiles('h-3', old('2026-03-14'), [
        { media: 'h-3', video: false, width: 1200, height: 1800 },
      ]),
      ...hubFiles('h-4', old('2026-03-15'), [{ media: 'h-4', durationMs: 99_000 }]),
    ])
    await poll(lora1)
    const { rows } = await db.execute<{ id: string }>(sql`
      SELECT id FROM work_operations WHERE kind = 'hub_history'
         AND work_key = ${`history:${lora1.accountId}:first`}`)
    const outcome = await runHubWork(db, rows[0]?.id as string, hubSyncHandler(options()), {
      extra: { hub_history: hubHistoryHandler() },
    })
    expect(outcome.state).toBe('succeeded')
    expect(outcome.report).toMatchObject({
      posts: 4,
      candidates: 1,
      disputed: 1,
      photo_hints: 1,
      unknown: 3,
    })
    const history = (await placementsOf(db, lora1)).find((p) => p.external_post_ref === 'h-1')
    expect(history).toMatchObject({ plan_row_id: null, surface_source: 'hub_hint', surface: 'fyp' })
    const evidence = await evidenceOf(db, [history?.id as string])
    expect(evidence.map((e) => e.dedup_key)[0]).toMatch(/^cand:hist:/)
    const object = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/objects/FYP-0802/placements',
      as: owner,
    })
    if (object.statusCode === 200) {
      expect(JSON.stringify(object.json())).toContain('похоже, выходило')
    }
  })
})
