import { randomUUID } from 'node:crypto'
import { addDays } from '@contentops/contracts/clock'
import { IssuedTokenSchema } from '@contentops/contracts/domain/agents'
import {
  type CheckCase,
  CheckCaseSchema,
  CheckListSchema,
} from '@contentops/contracts/domain/check'
import type { PlanRow } from '@contentops/contracts/domain/plan'
import { type Db, enqueueWork, SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { type FakeHub, startFakeHub } from '@contentops/hub/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCatalogItems } from '../../testing/catalog-factory'
import {
  addPerson,
  call,
  newKey,
  OWNER,
  signIn,
  type TestServer,
  testServer,
} from '../../testing/server'
import {
  evidenceOf,
  hubFiles,
  hubPost,
  issue,
  placementsOf,
  putRows,
  rowFiles,
  setPolicy,
  setSwitch,
} from '../match/testing'
import { fakeClient, type PageIds, pageIds, setHubPage, syncOnce } from '../testing'

/**
 * «Сверить» on the server (DESIGN §4.15, SPEC §7): cases, «Это оно» with the basis «осмотренная
 * пара», «Не то» that is never exact, variants, «стена или фуп?», posts without plan with
 * «Привязать…» and «Не наше», «Отменить», «Подтвердить однозначные» only on Fansly, OnlyFans pairs
 * confirmed whole and reused later, agents marked, rights. Fictional refs and captions only.
 */

let server: TestServer
let db: Db
let hub: FakeHub
let owner: string
let diana: { id: string; session: string }
let reader: { id: string; session: string }
let agent: string
let lora1: PageIds
let loraOf: PageIds
let modelId: string

const TODAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })
const YESTERDAY = addDays(TODAY, -1)
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
  reader = await addPerson(server.app, owner, {
    name: 'Чтение',
    login: 'reader',
    role: 'reader',
    models: ['lora'],
  })
  await call(server.app, {
    method: 'PATCH',
    url: '/api/v1/admin/integrations/agents',
    as: owner,
    key: newKey(),
    body: { switches: { enabled: true } },
  })
  const added = await call(server.app, {
    method: 'POST',
    url: '/api/v1/admin/agents',
    as: owner,
    key: newKey(),
    body: { name: 'Сверка', role: 'manager', models: ['lora'] },
  })
  const agentId = added.json().id as string
  const token = await call(server.app, {
    method: 'POST',
    url: `/api/v1/admin/agents/${agentId}/tokens`,
    as: owner,
    key: newKey(),
    body: { agent_id: agentId, expires_in_days: null },
  })
  agent = `Bearer ${IssuedTokenSchema.parse(token.json()).secret}`
  lora1 = await pageIds(db, 'lora-1')
  loraOf = await pageIds(db, 'lora-of')
  modelId = lora1.modelId
  await setHubPage(db, 'lora-1', 'page-a')
  await setHubPage(db, 'lora-of', 'page-b')
  for (const page of [lora1, loraOf]) {
    await setSwitch(db, page, 'hub.receive', true)
    await setSwitch(db, page, 'hub.auto_match', true)
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
      files: [{ role: 'master', durationS: 9 }],
    },
    {
      type: 'fyp',
      number: 802,
      title: 'Окно',
      secondPerson: false,
      files: [{ role: 'master', durationS: 12 }],
    },
    {
      type: 'fyp',
      number: 803,
      title: 'Лестница',
      secondPerson: false,
      files: [{ role: 'master', durationS: 15 }],
    },
    {
      type: 'fyp',
      number: 804,
      title: 'Балкон',
      secondPerson: false,
      files: [{ role: 'master', durationS: 18 }],
    },
    {
      type: 'fyp',
      number: 805,
      title: 'Кухня',
      secondPerson: false,
      files: [{ role: 'master', durationS: 21 }],
    },
    {
      type: 'sexting',
      number: 20,
      title: 'Красное',
      secondPerson: false,
      files: [{ role: 'clip', durationS: 20 }],
    },
    {
      type: 'set',
      number: 76,
      title: 'Пледы',
      secondPerson: false,
      files: [
        { role: 'ed', selected: true, width: 1000, height: 1500 },
        { role: 'ed', selected: true, width: 1000, height: 1500 },
      ],
    },
  ])
  // Fansly: one clear pair, a row with two variants, a post without plan, an exact file
  // without a proven surface. OnlyFans: one pair of two photos.
  const [single, variants, , onlyfans] = await putRows(server, diana.session, [
    { item_id: 'FYP-0801', surface: 'fyp', date: YESTERDAY, time: '03:00' },
    { item_id: 'FYP-0802', surface: 'fyp', date: YESTERDAY, time: '09:00' },
    { item_id: 'FYP-0804', surface: 'fyp', date: YESTERDAY, time: '15:00' },
    { item_id: 'SET-076', account: 'lora-of', surface: 'wall', date: YESTERDAY, time: '19:00' },
  ])
  rows.single = single as PlanRow
  rows.variants = variants as PlanRow
  rows.onlyfans = onlyfans as PlanRow
  const [exactFile] = await rowFiles(db, rows.variants.id)
  const surfaceName = `FYP-0803_lestnitsa_master__lora-1_${YESTERDAY}.mp4`
  const { rows: fyp803 } = await db.execute<{ asset_id: string; version_id: string }>(sql`
    SELECT a.id AS asset_id, a.current_version_id AS version_id FROM assets a
      JOIN content_items i ON i.model_id = a.model_id AND i.id = a.created_in_item_id
     WHERE i.model_id = ${modelId}::uuid AND i.type = 'FYP' AND i.number = 803`)
  await issue(db, {
    modelId,
    principalId: diana.id,
    manifestId: exactFile?.manifestId as string,
    files: [
      {
        assetId: fyp803[0]?.asset_id as string,
        versionId: fyp803[0]?.version_id as string,
        name: surfaceName,
        durationMs: 15_000,
        width: 1080,
        height: 1920,
      },
    ],
  })
  hub.setNow(new Date())
  hub.put('posts', 'page-a', [
    hubPost('p-single', at('03:04')),
    hubPost('p-var-a', at('09:02')),
    hubPost('p-var-b', at('09:20')),
    hubPost('p-loose', at('11:00')),
    hubPost('p-loose-2', at('11:30')),
    hubPost('p-surface', at('13:00')),
    hubPost('p-other', at('15:05')),
  ])
  hub.put('post_attachments', 'page-a', [
    ...hubFiles('p-single', at('03:04'), [{ media: 'm-single', durationMs: 9_050 }]),
    ...hubFiles('p-var-a', at('09:02'), [{ media: 'm-var-a', durationMs: 12_000 }]),
    ...hubFiles('p-var-b', at('09:20'), [{ media: 'm-var-b', durationMs: 12_000 }]),
    ...hubFiles('p-loose', at('11:00'), [{ media: 'm-loose', durationMs: 7_000 }]),
    ...hubFiles('p-loose-2', at('11:30'), [
      { media: 'm-loose-2', video: false, width: 800, height: 800 },
    ]),
    ...hubFiles('p-surface', at('13:00'), [
      { media: 'm-surface', name: surfaceName, durationMs: 15_000 },
    ]),
    ...hubFiles('p-other', at('15:05'), [{ media: 'm-other', durationMs: 18_000 }]),
  ])
  hub.put('posts', 'page-b', [hubPost('of-pair', at('19:04'), { platform: 'onlyfans', files: 2 })])
  hub.put(
    'post_attachments',
    'page-b',
    hubFiles(
      'of-pair',
      at('19:04'),
      [
        { media: 'of-1', video: false, width: 1000, height: 1500 },
        { media: 'of-2', video: false, width: 1500, height: 1000 },
      ],
      'onlyfans',
    ),
  )
  for (const page of [lora1, loraOf]) {
    const outcome = await syncOnce(db, page, 'posts', { client: () => fakeClient(hub).client })
    expect(outcome.state).toBe('succeeded')
  }
})
afterAll(async () => {
  await hub?.close()
  await server?.close()
})

const rows = {} as { single: PlanRow; variants: PlanRow; onlyfans: PlanRow }

async function list(as = owner) {
  const response = await call(server.app, { method: 'GET', url: '/api/v1/lora/reconcile', as })
  expect(response.statusCode, response.body).toBe(200)
  return CheckListSchema.parse(response.json())
}

async function caseOf(id: string): Promise<CheckCase> {
  const found = (await list()).items.find((item) => item.id === id)
  if (!found) throw new Error(`no case ${id}`)
  return found
}

const caseOfRow = (row: PlanRow) => caseOf(`r-${row.id}`)

async function decide(as: string, id: string, verb: string, body?: unknown) {
  return call(server.app, {
    method: 'POST',
    url: `/api/v1/lora/reconcile/${id}:${verb}`,
    as,
    key: newKey(),
    body: body ?? null,
  })
}

describe('список «Сверить»', () => {
  it('кандидат, варианты, пост без плана и «стена или фуп?» — каждый своим случаем', async () => {
    const view = await list()
    const kinds = Object.fromEntries(view.items.map((item) => [item.id, item.kind]))
    expect(kinds[`r-${rows.single.id}`]).toBe('candidate')
    expect(kinds[`r-${rows.variants.id}`]).toBe('variants')
    expect(
      view.items.filter((item) => item.kind === 'unplanned').map((item) => item.posts[0]?.url),
    ).toContain('https://fansly.com/post/p-loose')
    const surface = view.items.find((item) => item.kind === 'surface')
    expect(surface?.item_id).toBe('FYP-0803')
    const single = await caseOfRow(rows.single)
    expect(single.unambiguous).toBe(true)
    expect(single.pair_phrase).toBe('Пост 03:04 (+4 мин) · видео 0:09 — совпадает')
    expect(view.unambiguous_ids).toContain(`r-${rows.single.id}`)
    expect(view.unambiguous_ids).not.toContain(`r-${rows.onlyfans.id}`)
    // OnlyFans pairs are never in «Подтвердить однозначные».
    expect((await caseOfRow(rows.onlyfans)).unambiguous).toBe(false)
    expect(
      CheckCaseSchema.parse(
        await (
          await call(server.app, {
            method: 'GET',
            url: `/api/v1/lora/reconcile/r-${rows.variants.id}`,
            as: reader.session,
          })
        ).json(),
      ).posts,
    ).toHaveLength(2)
  })

  it('права: чтение видит, но не решает; чужая модель — 403', async () => {
    expect(
      (await decide(reader.session, `r-${rows.single.id}`, 'confirm-pair', { evidence_id: null }))
        .statusCode,
    ).toBe(403)
    const other = await call(server.app, {
      method: 'GET',
      url: '/api/v1/ari/reconcile',
      as: diana.session,
    })
    expect(other.statusCode).toBe(403)
  })
})

describe('решения', () => {
  it('два варианта: без выбора — 400; «Это оно» на одном — второй отклонён, отмена возвращает оба', async () => {
    const id = `r-${rows.variants.id}`
    const variants = await caseOf(id)
    expect(
      (await decide(diana.session, id, 'confirm-pair', { evidence_id: null })).statusCode,
    ).toBe(400)
    const chosen = variants.posts[1]?.evidence_id as string
    const confirmed = await decide(diana.session, id, 'confirm-pair', { evidence_id: chosen })
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    expect(confirmed.json().verdict.level).toBe('confirmed_manual')
    expect((await list()).items.some((item) => item.id === id)).toBe(false)
    // A second decision on the same case finds it closed.
    expect(
      (await decide(diana.session, id, 'confirm-pair', { evidence_id: chosen })).statusCode,
    ).toBe(422)
    const resolved = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/reconcile/resolved',
      as: owner,
    })
    expect(
      resolved.json().items.find((item: { case_id: string }) => item.case_id === id)?.how,
    ).toBe('осмотренная пара')
    const undone = await decide(diana.session, id, 'undo')
    expect(undone.statusCode, undone.body).toBe(200)
    const back = await caseOf(id)
    expect(back.kind).toBe('variants')
    expect(back.posts).toHaveLength(2)
  })

  it('«Не то» — отказ без силы, никогда не точное; пост уходит в «пост без плана»', async () => {
    const id = `r-${rows.variants.id}`
    const variants = await caseOf(id)
    for (const post of variants.posts) {
      const answer = await decide(diana.session, id, 'reject', { evidence_id: post.evidence_id })
      if (answer.statusCode !== 200) expect(answer.statusCode).toBe(422)
    }
    const evidence = await evidenceOf(
      db,
      (await placementsOf(db, lora1)).map((p) => p.id),
    )
    const rejects = evidence.filter((e) => e.kind === 'manual_reject')
    expect(rejects.length).toBeGreaterThan(0)
    expect(rejects.every((e) => e.strength === null && e.source === 'manual')).toBe(true)
    const loose = (await list()).items
      .filter((item) => item.kind === 'unplanned')
      .map((item) => item.posts[0]?.url)
    expect(loose).toContain('https://fansly.com/post/p-var-a')
  })

  it('«Стена или фуп?»: без ответа — 400, с ответом — подтверждено', async () => {
    const surface = (await list()).items.find((item) => item.kind === 'surface') as CheckCase
    expect(
      (await decide(diana.session, surface.id, 'confirm-pair', { evidence_id: null })).statusCode,
    ).toBe(400)
    const answer = await decide(diana.session, surface.id, 'confirm-pair', {
      evidence_id: null,
      surface: 'fyp',
    })
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.json().verdict.sign).toBe('done')
    const placement = (await placementsOf(db, lora1)).find(
      (p) => p.external_post_ref === 'p-surface',
    )
    expect(placement).toMatchObject({ surface: 'fyp', surface_source: 'km' })
  })

  it('пост без плана: «Привязать…», отмена, «Не наше»', async () => {
    const loose = (await list()).items.find((item) =>
      item.posts[0]?.url.endsWith('/p-loose'),
    ) as CheckCase
    const bound = await decide(diana.session, loose.id, 'bind', { item_id: 'FYP-0802' })
    expect(bound.statusCode, bound.body).toBe(200)
    expect(bound.json().verdict.sign).toBe('done')
    const undone = await decide(diana.session, loose.id, 'undo')
    expect(undone.json().verdict.detail).toBe('пост без плана')
    expect((await caseOf(loose.id)).item_id).toBeNull()
    const outside = await decide(diana.session, loose.id, 'outside')
    expect(outside.statusCode, outside.body).toBe(200)
    expect(outside.json().verdict.level).toBe('outside_catalog')
    const notOurs = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/reconcile/not-ours',
      as: owner,
    })
    expect(notOurs.json().items.map((item: { case_id: string }) => item.case_id)).toContain(
      loose.id,
    )
  })
})

describe('массовое подтверждение и OnlyFans', () => {
  it('«Подтвердить однозначные» берёт только однозначные пары Fansly, по каждой — своё состояние', async () => {
    const answer = await call(server.app, {
      method: 'POST',
      url: '/api/v1/lora/reconcile:confirm-unambiguous',
      as: diana.session,
      key: newKey(),
      body: { case_ids: [`r-${rows.single.id}`, `r-${rows.onlyfans.id}`] },
    })
    expect(answer.statusCode, answer.body).toBe(200)
    const results = answer.json().results as {
      id: string
      ok: boolean
      code: string | null
      verdict: { word: string } | null
    }[]
    expect(results.map((result) => [result.ok, result.code])).toEqual([
      [true, null],
      [false, 'case_resolved'],
    ])
    expect(results[0]?.verdict?.word).toBe('подтверждено')
  })

  it('OnlyFans: один клик подтверждает весь состав поста, агент помечен, повтор файла — «ранее агентом»', async () => {
    const pair = await caseOfRow(rows.onlyfans)
    const answer = await decide(agent, pair.id, 'confirm-pair', {
      evidence_id: pair.posts[0]?.evidence_id,
    })
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.json().verdict.word).toBe('подтверждено агентом')
    const { rows: assets } = await db.execute<{
      matched_media_ref: string
      match_strength: string
    }>(sql`
      SELECT a.matched_media_ref, a.match_strength FROM placement_assets a
        JOIN placements p ON p.model_id = a.model_id AND p.id = a.placement_id
       WHERE p.plan_row_id = ${rows.onlyfans.id}::uuid`)
    expect(assets.map((asset) => asset.matched_media_ref).sort()).toEqual(['of-1', 'of-2'])
    expect(assets.every((asset) => asset.match_strength === 'exact')).toBe(true)

    // The same files in a later post without plan: «подтверждено ранее агентом», no question.
    hub.setNow(new Date())
    hub.put('posts', 'page-b', [
      hubPost('of-repeat', at('10:00', TODAY), { platform: 'onlyfans', files: 2 }),
    ])
    hub.put(
      'post_attachments',
      'page-b',
      hubFiles(
        'of-repeat',
        at('10:00', TODAY),
        [
          { media: 'of-1', video: false, width: 1000, height: 1500 },
          { media: 'of-2', video: false, width: 1500, height: 1000 },
        ],
        'onlyfans',
      ),
    )
    await syncOnce(db, loraOf, 'posts', { client: () => fakeClient(hub).client })
    const repeat = (await placementsOf(db, loraOf)).find((p) => p.external_post_ref === 'of-repeat')
    const evidence = await evidenceOf(db, [repeat?.id as string])
    expect(evidence.map((e) => [e.source, e.kind, e.strength])).toEqual([
      ['manual', 'reused_pair', 'exact'],
      ['manual', 'reused_pair', 'exact'],
    ])
    expect((await list()).items.some((item) => item.posts[0]?.url.includes('of-repeat'))).toBe(
      false,
    )
  })

  it('«Отметить и подтвердить» — только где автосверки нет: vault OnlyFans да, стена Fansly нет', async () => {
    const created = await putRows(server, diana.session, [
      { item_id: 'FYP-0805', surface: 'fyp', date: TODAY, time: '23:00' },
      { item_id: 'SXT-020', account: 'lora-of', surface: 'vault', date: TODAY, time: null },
    ])
    expect(created.map((row) => row.mark_button)).toEqual(['mark', 'mark_confirm'])
  })
})
