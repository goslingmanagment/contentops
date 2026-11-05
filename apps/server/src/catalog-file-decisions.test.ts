import { randomUUID } from 'node:crypto'
import { ItemDetailSchema } from '@contentops/contracts/domain/item'
import { SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CreatedItem, createCatalogItems } from './testing/catalog-factory'
import { call, newKey, OWNER, signIn, type TestServer, testServer } from './testing/server'

/**
 * Decisions about a file accepted before (the repair of the catalog of 05.11.2026 did them by SQL
 * with the trigger `inbox_drafts_transition` off): «Это копия <файл>» makes the draft a duplicate
 * alias of the original and every name of the copy finds it; «Не контент» refuses the draft with
 * its reason and «Вернуть в работу» brings it back; only these two commands may turn an accepted
 * draft. «Новая версия мастера из файла» takes the bytes of a FYP's copy that left with a merge.
 */

let server: TestServer
let owner: string
const made = new Map<string, CreatedItem>()
const arrived = '2026-10-28T12:00:00Z'

/** The accepted draft of a fixture file, as intake leaves it (the factory makes none). */
async function accepted(id: string, key: string): Promise<{ draft: string; group: string }> {
  const item = made.get(id) as CreatedItem
  const file = item.files.get(key)
  if (!file) throw new Error(`${id}/${key}: no file`)
  return withActorTx(
    server.db,
    { actor: SYSTEM_ACTOR('test'), action: 'test', requestId: randomUUID() },
    async (tx) => {
      const { rows } = await tx.execute<{ draft: string; group: string }>(sql`
        WITH v AS (
          SELECT v.id, v.model_id, v.master_sha256, v.source_revision_id, o.source_id
            FROM asset_versions v
            JOIN source_revisions r ON r.model_id = v.model_id AND r.id = v.source_revision_id
            JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
           WHERE v.id = ${file.versionIds.at(-1)}::uuid
        ), g AS (
          INSERT INTO inbox_groups (model_id, source_id, group_key, grouping, evidence)
          SELECT model_id, source_id, ${randomUUID()}, 'manual', '{}'::jsonb FROM v
          RETURNING id, model_id
        )
        INSERT INTO inbox_drafts (model_id, group_id, source_revision_id, origin, state, outcome,
                                  master_sha256, master_verified_at, applied_item_id,
                                  applied_version_id, decided_at)
        SELECT v.model_id, g.id, v.source_revision_id, 'disk_scan', 'resolved', 'new_item',
               v.master_sha256, now(), ${item.uid}::uuid, v.id, now()
          FROM v, g
        RETURNING id AS draft, group_id AS group`)
      return rows[0] as { draft: string; group: string }
    },
  )
}

async function draftOf(id: string) {
  const { rows } = await server.db.execute<{
    state: string
    outcome: string | null
    reason: string | null
    duplicate_of: string | null
  }>(sql`
    SELECT state, outcome, reject_reason AS reason, duplicate_of_version_id AS duplicate_of
      FROM inbox_drafts WHERE id = ${id}::uuid`)
  return rows[0]
}

beforeAll(async () => {
  server = await testServer()
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  const items = await createCatalogItems(server.db, 'lora', [
    { type: 'life', number: 5, title: 'Кофе', files: [{ role: 'pic', arrivedAt: arrived }] },
    {
      type: 'life',
      number: 20,
      title: 'Тыквы',
      files: [
        { role: 'pic', arrivedAt: arrived, name: 'IMG_0459.JPG' },
        { role: 'pic', arrivedAt: arrived },
        { role: 'pic' },
        { role: 'pic' },
      ],
    },
    {
      type: 'promo',
      number: 3,
      title: 'Reddit',
      references: [{ item: 'LIFE-020', handle: 'pic01' }],
    },
    { type: 'fyp', number: 16, title: 'Зеркало', files: [{ role: 'master', arrivedAt: arrived }] },
    {
      type: 'fyp',
      number: 36,
      title: 'Зеркало, монтажёр',
      files: [{ role: 'master', arrivedAt: arrived }],
    },
    { type: 'custom', number: 7, title: 'Танец', files: [{ role: 'master' }] },
  ])
  for (const item of items) made.set(item.id, item)
})
afterAll(() => server.close())

const get = (url: string) =>
  call(server.app, { method: 'GET', url: `/api/v1/lora${url}`, as: owner })
const page = async (id: string) => ItemDetailSchema.parse((await get(`/i/${id}`)).json())
const send = async (url: string, body: unknown, id: string) =>
  call(server.app, {
    method: 'POST',
    url: `/api/v1/lora${url}`,
    as: owner,
    key: newKey(),
    ifMatch: (await page(id)).version,
    body,
  })
const found = async (q: string) =>
  (await get(`/search?q=${encodeURIComponent(q)}`))
    .json()
    .groups.flatMap((group: { item_ids: string[] }) => group.item_ids)

describe('an accepted draft is decided again only by its commands', () => {
  it('refuses the turn of an accepted draft to any other action', async () => {
    const { draft } = await accepted('LIFE-005', 'pic01')
    const turn = withActorTx(
      server.db,
      { actor: SYSTEM_ACTOR('test'), action: 'objectFiles.remove', requestId: randomUUID() },
      (tx) =>
        tx.execute(sql`
          UPDATE inbox_drafts SET outcome = 'rejected', rejected_at = now()
           WHERE id = ${draft}::uuid`),
    )
    await expect(turn).rejects.toThrow()
    expect((await draftOf(draft))?.outcome).toBe('new_item')
  })
})

describe('«Это копия <файл>»', () => {
  it('sends every name of the copy and the promo link to the original', async () => {
    const { draft } = await accepted('LIFE-020', 'pic01')
    const response = await send(
      '/i/LIFE-020/files:copy-of',
      { files: [{ key: 'pic01', original: 'LIFE-005/pic01' }] },
      'LIFE-020',
    )
    expect(response.statusCode).toBe(200)
    expect(ItemDetailSchema.parse(response.json()).files.map((file) => file.key)).not.toContain(
      'pic01',
    )
    expect(await found('IMG_0459')).toEqual(['LIFE-005'])
    expect(await found('LIFE-020/pic01')).toEqual(['LIFE-005'])
    const original = made.get('LIFE-005')?.files.get('pic01')
    expect(await draftOf(draft)).toMatchObject({
      state: 'resolved',
      outcome: 'alias',
      duplicate_of: original?.versionIds.at(-1),
    })
    const promo = await page('PRM-003')
    expect(promo.files.map((file) => file.source)).toEqual([
      { item_id: 'LIFE-005', file_key: 'pic01' },
    ])
  })

  it('refuses a photo as a copy of a video and an original that is a copy itself', async () => {
    const kinds = await send(
      '/i/LIFE-020/files:copy-of',
      { files: [{ key: 'pic02', original: 'FYP-0016/master' }] },
      'LIFE-020',
    )
    expect(kinds.statusCode).toBe(400)
    const chain = await send(
      '/i/LIFE-020/files:copy-of',
      {
        files: [
          { key: 'pic02', original: 'LIFE-020/pic04' },
          { key: 'pic04', original: 'LIFE-005/pic01' },
        ],
      },
      'LIFE-020',
    )
    expect(chain.statusCode).toBe(400)
  })
})

describe('«Не контент»', () => {
  it('refuses the draft with its reason, and «Вернуть в работу» brings it back', async () => {
    const { draft, group } = await accepted('LIFE-020', 'pic02')
    const bare = await send(
      '/i/LIFE-020/files:not-content',
      { keys: ['pic04'], reason: 'скриншот' },
      'LIFE-020',
    )
    expect(bare.json().details).toEqual({ keys: ['pic04'] })
    const response = await send(
      '/i/LIFE-020/files:not-content',
      { keys: ['pic02'], reason: 'скриншот заказа' },
      'LIFE-020',
    )
    expect(response.statusCode).toBe(200)
    expect(await draftOf(draft)).toMatchObject({ outcome: 'rejected', reason: 'скриншот заказа' })
    const back = await call(server.app, {
      method: 'POST',
      url: `/api/v1/lora/inbox/drafts/${group}:restore`,
      as: owner,
      key: newKey(),
    })
    expect(back.statusCode).toBe(200)
    expect(await draftOf(draft)).toMatchObject({ state: 'ready', outcome: null })
  })
})

describe('«Новая версия мастера из файла»', () => {
  it('takes the bytes of a FYP that left with a merge; the master keeps its handle', async () => {
    await accepted('FYP-0036', 'master')
    const copy = await send(
      '/i/FYP-0036/files:copy-of',
      { files: [{ key: 'master', original: 'FYP-0016/master' }] },
      'FYP-0036',
    )
    expect(copy.statusCode).toBe(200)
    const merged = await send('/i/FYP-0036:merge', { into: 'FYP-0016' }, 'FYP-0036')
    expect(merged.json()).toEqual({ item_id: 'FYP-0016' })
    const response = await send(
      '/i/FYP-0016:master-version',
      { from: 'FYP-0036/master' },
      'FYP-0016',
    )
    expect(response.statusCode).toBe(200)
    const [master] = ItemDetailSchema.parse(response.json()).files
    expect(master).toMatchObject({ key: 'master', current_version: 2 })
    const again = await send('/i/FYP-0016:master-version', { from: 'FYP-0036/master' }, 'FYP-0016')
    expect(again.statusCode).toBe(400)
    const custom = await send('/i/CUS-007:master-version', { from: 'FYP-0036/master' }, 'CUS-007')
    expect(custom.statusCode).toBe(400)
  })
})
