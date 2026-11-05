import { randomBytes, randomUUID } from 'node:crypto'
import { ItemDetailSchema } from '@contentops/contracts/domain/item'
import { enqueueWork, SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CreatedItem, createCatalogItems, linkCatalogItems } from './testing/catalog-factory'
import { call, newKey, OWNER, signIn, type TestServer, testServer } from './testing/server'

/**
 * What follows an object when it lives on in another one (SPEC §4.1, the repair of the catalog of
 * 05.11.2026: «Сменить тип» and «Слить» copied the links and left the old ones on the tombstone, a
 * candidate of the history pass of Hub held a type change). Links, claims of old names and
 * placements move, nothing stays on the tombstone but «Слит в»; candidates are taken back as the
 * pass takes back its own; a file that comes back to an object gets its own handle again.
 */

let server: TestServer
let owner: string
const made = new Map<string, CreatedItem>()

const DAY = '2026-03-01'

beforeAll(async () => {
  server = await testServer()
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  const arrived = '2026-03-01T12:00:00Z'
  const items = await createCatalogItems(server.db, 'lora', [
    { type: 'raw', number: 63, title: 'Съёмка у окна', files: [{ role: 'raw' }] },
    { type: 'set', number: 81, title: 'Окно', files: [{ role: 'raw' }, { role: 'raw' }] },
    {
      type: 'set',
      number: 82,
      title: 'Окно, второй заход',
      files: [
        { role: 'raw', arrivedAt: arrived },
        { role: 'ed', ordinal: 1 },
      ],
    },
    { type: 'ppv', number: 90, title: 'Окно', files: [{ role: 'master', arrivedAt: arrived }] },
    { type: 'set', number: 83, title: 'Лестница', files: [{ role: 'raw', arrivedAt: arrived }] },
    { type: 'set', number: 84, title: 'Кухня', files: [{ role: 'raw' }] },
    { type: 'custom', number: 10, title: 'Танец', files: [{ role: 'master', durationS: 300 }] },
    { type: 'custom', number: 11, title: 'Танец, часть 2', files: [{ role: 'master' }] },
    { type: 'fyp', number: 4, title: 'Зеркало', files: [{ role: 'master' }] },
    { type: 'fyp', number: 17, title: 'Зеркало, копия', files: [{ role: 'master' }] },
    {
      type: 'life',
      number: 95,
      title: 'Кофе',
      files: [{ role: 'pic' }, { role: 'pic' }, { role: 'clip' }],
    },
    { type: 'life', number: 96, title: 'Завтрак', files: [{ role: 'pic' }] },
  ])
  for (const item of items) made.set(item.id, item)
  await linkCatalogItems(server.db, 'lora', [
    { child: 'SET-081', parent: 'RAW-0063', relation: 'montage_from' },
    { child: 'SET-082', parent: 'RAW-0063', relation: 'montage_from' },
    { child: 'PPV-090', parent: 'SET-082', relation: 'montage_from', suggested: true },
  ])
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

const uid = (id: string) => made.get(id)?.uid as string
const links = async (id: string) =>
  (await page(id)).provenance.map((link) => `${link.relation}:${link.direction}:${link.item_id}`)

/** A placement of the object on `lora-1` as the import, the history pass or a person leaves it. */
async function place(id: string, kind: 'claim' | 'candidate' | 'exact'): Promise<string> {
  const item = made.get(id) as CreatedItem
  const file = [...item.files.values()][0]
  if (!file) throw new Error(`${id} has no files`)
  const version = file.versionIds.at(-1) as string
  return withActorTx(
    server.db,
    { actor: SYSTEM_ACTOR('test'), action: 'test', requestId: randomUUID() },
    async (tx) => {
      const { rows } = await tx.execute<{ model_id: string; account_id: string; surface: string }>(
        sql`SELECT a.model_id, a.id AS account_id, s.id AS surface FROM accounts a
              JOIN surfaces s ON s.model_id = a.model_id AND s.account_id = a.id AND s.kind = 'wall'
             WHERE a.code = 'lora-1'`,
      )
      const at = rows[0] as { model_id: string; account_id: string; surface: string }
      const placement = randomUUID()
      const post = kind === 'candidate' ? randomUUID() : null
      const key =
        kind === 'claim' ? `legacy:${item.uid}:${DAY}` : kind === 'exact' ? `manual:${post}` : null
      await tx.execute(sql`
        INSERT INTO placements (model_id, id, account_id, surface_id, occurrence_kind,
                                external_post_ref, manual_key, item_id, item_type, occurred_at,
                                event_precision, occurred_source, surface_source, origin)
        VALUES (${at.model_id}::uuid, ${placement}::uuid, ${at.account_id}::uuid,
                ${at.surface}::uuid, ${post ? 'post' : 'manual'}, ${post}, ${key},
                ${item.uid}::uuid, (SELECT type FROM content_items WHERE id = ${item.uid}::uuid),
                ${`${DAY}T12:00:00Z`}::timestamptz, 'day', ${post ? 'hub' : 'import'},
                ${post ? 'hub' : 'import'}, ${post ? 'hub' : 'import'})`)
      if (kind === 'claim') {
        const { work } = await enqueueWork(tx, {
          modelId: at.model_id,
          kind: 'import_parse',
          workKey: randomUUID(),
        })
        const { rows: claims } = await tx.execute<{ id: string }>(sql`
          INSERT INTO legacy_claims (model_id, source_object_id, parser_version, claim_key,
                                     raw_fragment, claim_kind, parse_work_id)
          SELECT ${at.model_id}::uuid, r.source_object_id, 'test', ${randomUUID()}, 'used2',
                 'used', ${work.id}::uuid
            FROM asset_versions v JOIN source_revisions r ON r.id = v.source_revision_id
           WHERE v.id = ${version}::uuid
          RETURNING id`)
        await tx.execute(sql`
          INSERT INTO placement_evidence (model_id, placement_id, source, kind, strength,
                                          legacy_claim_id, dedup_key)
          VALUES (${at.model_id}::uuid, ${placement}::uuid, 'import', 'legacy_claim', 'claim',
                  ${claims[0]?.id}::uuid, ${`claim:${randomUUID()}`})`)
      } else if (kind === 'candidate') {
        const { work } = await enqueueWork(tx, {
          modelId: at.model_id,
          kind: 'hub_sync',
          workKey: randomUUID(),
          accountId: at.account_id,
        })
        const { rows: observed } = await tx.execute<{ id: string }>(sql`
          INSERT INTO hub_observations (model_id, account_id, dataset, external_key, sequence_no,
                                        semantic_hash, payload, run_id, run_attempt)
          VALUES (${at.model_id}::uuid, ${at.account_id}::uuid, 'posts', ${randomUUID()}, 1,
                  ${randomBytes(32)}, '{}'::jsonb, ${work.id}::uuid, 1)
          RETURNING id`)
        const observation = observed[0]?.id as string
        await tx.execute(sql`
          INSERT INTO placement_evidence (model_id, placement_id, source, kind, strength,
                                          hub_observation_id, matched_asset_id, matched_version_id,
                                          payload, dedup_key)
          VALUES (${at.model_id}::uuid, ${placement}::uuid, 'hub', 'observed', 'candidate',
                  ${observation}::uuid, ${file.assetId}::uuid, ${version}::uuid,
                  ${JSON.stringify({ kind: 'history', post_ref: post })}::jsonb,
                  ${`cand:hist:${file.assetId}:${observation}`})`)
      } else {
        await tx.execute(sql`
          INSERT INTO placement_evidence (model_id, placement_id, source, kind, strength, payload,
                                          dedup_key)
          VALUES (${at.model_id}::uuid, ${placement}::uuid, 'manual', 'manual_confirm', 'exact',
                  '{"basis": "execution_report"}'::jsonb, ${`manual:${randomUUID()}`})`)
      }
      return placement
    },
  )
}

async function placementOf(id: string) {
  const { rows } = await server.db.execute<{
    item: string | null
    manual_key: string | null
    retracts: number
  }>(sql`
    SELECT public_item_id(i.type, i.number) AS item, p.manual_key,
           (SELECT count(*)::int FROM placement_evidence e
             WHERE e.placement_id = p.id AND e.kind = 'retract'
               AND e.payload ->> 'kind' = 'history_retract') AS retracts
      FROM placements p LEFT JOIN content_items i ON i.id = p.item_id
     WHERE p.id = ${id}::uuid`)
  return rows[0]
}

describe('merge of any type', () => {
  it('moves files, links, claims and placements; the tombstone keeps only «Слит в»', async () => {
    const claim = await place('SET-082', 'claim')
    const candidate = await place('SET-082', 'candidate')
    const response = await send('/i/SET-082:merge', { into: 'SET-081' }, 'SET-082')
    expect(response.json()).toEqual({ item_id: 'SET-081' })
    const survivor = await page('SET-081')
    expect(survivor.files.map((file) => file.key)).toEqual(['raw01', 'raw02', 'raw03', 'ed01'])
    expect(await links('SET-081')).toEqual([
      'made_from:out:RAW-0063',
      'made_from:in:PPV-090',
      'merged_from:out:SET-082',
    ])
    expect(survivor.provenance.find((link) => link.item_id === 'PPV-090')?.confirmed).toBe(false)
    expect(await links('SET-082')).toEqual(['merged_from:in:SET-081'])
    expect(await links('RAW-0063')).toEqual(['made_from:in:SET-081'])
    expect(await links('PPV-090')).toEqual(['made_from:out:SET-081'])
    expect(await placementOf(claim)).toEqual({
      item: 'SET-081',
      manual_key: `legacy:${uid('SET-081')}:${DAY}`,
      retracts: 0,
    })
    expect(await placementOf(candidate)).toEqual({ item: null, manual_key: null, retracts: 1 })
    const events = (await get(`/journal?item=SET-081`)).json().items
    expect(events[0]).toMatchObject({ action: 'objectFiles.merge', item_id: 'SET-081' })
    expect((await get(`/search?q=${encodeURIComponent('SET-082/ed01')}`)).json().groups).toEqual([
      expect.objectContaining({ item_ids: ['SET-081'] }),
    ])
  })

  it('takes a second clip of a custom as its part and refuses a second master of a FYP', async () => {
    const custom = await send('/i/CUS-011:merge', { into: 'CUS-010' }, 'CUS-011')
    expect(custom.json()).toEqual({ item_id: 'CUS-010' })
    expect((await page('CUS-010')).files.map((file) => file.key)).toEqual(['master', 'clip01'])
    const fyp = await send('/i/FYP-0017:merge', { into: 'FYP-0004' }, 'FYP-0017')
    expect(fyp.statusCode).toBe(400)
    expect(fyp.json().details).toEqual({ keys: ['master'] })
    const types = await send('/i/FYP-0017:merge', { into: 'SET-081' }, 'FYP-0017')
    expect(types.statusCode).toBe(400)
  })
})

describe('what holds a type change and a removal', () => {
  it('takes candidates back, carries claims and stops at a confirmed placement', async () => {
    const claim = await place('SET-083', 'claim')
    const candidate = await place('SET-083', 'candidate')
    const changed = await send('/i/SET-083:change-type', { type: 'life' }, 'SET-083')
    expect(changed.statusCode).toBe(200)
    const { item_id: life } = changed.json()
    expect((await placementOf(claim))?.item).toBe(life)
    expect(await placementOf(candidate)).toMatchObject({ item: null, retracts: 1 })
    await place('SET-084', 'exact')
    const held = await send('/i/SET-084:change-type', { type: 'life' }, 'SET-084')
    expect(held.json().code).toBe('item_in_use')
  })

  it('removes an object with candidates only, keeps one with a claim of an old name', async () => {
    const candidate = await place('LIFE-096', 'candidate')
    const removed = await call(server.app, {
      method: 'DELETE',
      url: '/api/v1/lora/i/LIFE-096',
      as: owner,
      key: newKey(),
      ifMatch: (await page('LIFE-096')).version,
      body: { confirm: true },
    })
    expect(removed.json()).toEqual({ ok: true })
    expect(await placementOf(candidate)).toMatchObject({ item: null, retracts: 1 })
    await place('PPV-090', 'claim')
    const kept = await call(server.app, {
      method: 'DELETE',
      url: '/api/v1/lora/i/PPV-090',
      as: owner,
      key: newKey(),
      ifMatch: (await page('PPV-090')).version,
      body: { confirm: true },
    })
    expect(kept.json().code).toBe('item_in_use')
  })
})

describe('files between objects', () => {
  it('moves files to an object of another type and back to their own handle', async () => {
    const video = await send(
      '/i/LIFE-095/files:move',
      { keys: ['clip01'], into: 'SET-081' },
      'LIFE-095',
    )
    expect(video.statusCode).toBe(400)
    expect(video.json().details).toEqual({ keys: ['clip01'] })
    const there = await send(
      '/i/LIFE-095/files:move',
      { keys: ['pic01'], into: 'SET-081' },
      'LIFE-095',
    )
    expect(ItemDetailSchema.parse(there.json()).files.map((file) => file.key)).toEqual([
      'pic02',
      'clip01',
    ])
    expect((await page('SET-081')).files.map((file) => file.key)).toContain('raw04')
    const back = await send(
      '/i/SET-081/files:move',
      { keys: ['raw04'], into: 'LIFE-095' },
      'SET-081',
    )
    expect(back.statusCode).toBe(200)
    expect((await page('LIFE-095')).files.map((file) => file.key)).toEqual([
      'pic02',
      'clip01',
      'pic01',
    ])
  })

  it('extracts files of any type into a new object of the same type, never the master alone', async () => {
    const extracted = await send('/i/SET-081:extract', { keys: ['ed01'] }, 'SET-081')
    expect(extracted.statusCode).toBe(201)
    const { item_id: id } = extracted.json()
    expect(id).toMatch(/^SET-/)
    expect((await page(id)).files.map((file) => file.key)).toEqual(['ed01'])
    expect(await links(id)).toEqual(['extracted_from:out:SET-081'])
    const master = await send('/i/CUS-010:extract', { keys: ['master'] }, 'CUS-010')
    expect(master.statusCode).toBe(400)
  })
})
