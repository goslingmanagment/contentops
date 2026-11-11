import { randomBytes } from 'node:crypto'
import { addDays } from '@contentops/contracts/clock'
import type { NewPlanRow } from '@contentops/contracts/commands/plan'
import { IssuedTokenSchema } from '@contentops/contracts/domain/agents'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCatalogItems, linkCatalogItems } from './testing/catalog-factory'
import { call, newKey, OWNER, signIn, type TestServer, testServer } from './testing/server'

/**
 * A custom never goes out free, and prices and deletion stay with people (SPEC §7, §11.1;
 * решение владельца 11.11.2026). 10–11.11.2026 cuts of a fan's paid custom stood on a model's
 * wall: a byte copy of the custom lay in `2. FYP` and a FYP was cut from it.
 */

let server: TestServer
let owner: string
let agent: string

const TODAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })
const day = (offset: number) => addDays(TODAY, offset)
/** The bytes of the custom: its master, a copy of it in FYP, a copy of it as raw material. */
const CUSTOM = randomBytes(32)

beforeAll(async () => {
  server = await testServer()
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  const on = await call(server.app, {
    method: 'PATCH',
    url: '/api/v1/admin/integrations/agents',
    as: owner,
    key: newKey(),
    body: { switches: { enabled: true } },
  })
  expect(on.statusCode, on.body).toBe(200)
  const added = await call(server.app, {
    method: 'POST',
    url: '/api/v1/admin/agents',
    as: owner,
    key: newKey(),
    body: { name: 'Генгар', role: 'manager', models: ['lora'] },
  })
  expect(added.statusCode, added.body).toBe(201)
  const token = await call(server.app, {
    method: 'POST',
    url: `/api/v1/admin/agents/${added.json().id}/tokens`,
    as: owner,
    key: newKey(),
    body: { agent_id: added.json().id, expires_in_days: null },
  })
  agent = `Bearer ${IssuedTokenSchema.parse(token.json()).secret}`
  const clean = { secondPerson: false }
  await createCatalogItems(server.db, 'lora', [
    {
      type: 'custom',
      number: 1,
      title: 'Заказ в красном',
      ...clean,
      files: [{ role: 'master', sha256: [CUSTOM] }],
    },
    // «PPV из кастома как есть»: the same bytes, linked.
    {
      type: 'ppv',
      number: 1,
      title: 'Красное',
      ppvKind: 'dm',
      ...clean,
      files: [{ role: 'master', sha256: [CUSTOM] }, { role: 'pic' }],
    },
    // The model's copy of the custom in `2. FYP`, accepted as a FYP: no link, only the bytes.
    {
      type: 'fyp',
      number: 1,
      title: 'Копия',
      ...clean,
      files: [{ role: 'master', sha256: [CUSTOM] }],
    },
    // The same copy taken as raw material, and a FYP cut from it.
    {
      type: 'raw',
      number: 1,
      rawPurpose: 'fyp',
      ...clean,
      files: [{ role: 'raw', sha256: [CUSTOM] }],
    },
    { type: 'fyp', number: 2, title: 'Нарезка', ...clean, files: [{ role: 'master' }] },
    // Clean ones.
    { type: 'life', number: 1, title: 'Лишнее', ...clean, files: [{ role: 'pic' }] },
    { type: 'fyp', number: 3, title: 'Своё', ...clean, files: [{ role: 'master' }] },
    { type: 'fyp', number: 4, title: 'Тоже своё', ...clean, files: [{ role: 'master' }] },
    { type: 'ppv', number: 2, title: 'Своё', ppvKind: 'dm', ...clean, files: [{ role: 'master' }] },
  ])
  await linkCatalogItems(server.db, 'lora', [
    { child: 'PPV-001', parent: 'CUS-001', relation: 'ppv_from_custom' },
    { child: 'FYP-0002', parent: 'RAW-0001', relation: 'montage_from' },
  ])
})
afterAll(() => server.close())

function row(patch: Partial<NewPlanRow>): NewPlanRow {
  return {
    item_id: 'FYP-0003',
    account: 'lora-1',
    surface: 'fyp',
    date: day(2),
    time: '14:00',
    fyp_version: null,
    assignee: null,
    note: null,
    requires_new_upload: false,
    awaiting_montage: null,
    marked: null,
    ...patch,
  }
}

const send = (
  as: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
  ifMatch?: number,
) => call(server.app, { method, url: `/api/v1/lora${url}`, as, key: newKey(), body, ifMatch })

async function put(input: NewPlanRow, as = owner) {
  return send(as, 'POST', '/plan/rows', { rows: [input] })
}

async function refusal(input: NewPlanRow): Promise<string> {
  const response = await put(input)
  expect(response.statusCode, response.body).toBe(201)
  const body = response.json()
  expect(body.created).toBe(false)
  return body.rejected[0]?.text as string
}

describe('a custom never goes out free (SPEC §7)', () => {
  it('a FYP that repeats the bytes of a custom is refused in FYP, the check line says why', async () => {
    expect(await refusal(row({ item_id: 'FYP-0001' }))).toBe(
      'из кастома CUS-001 — в фуп не ставится',
    )
    const check = await send(owner, 'POST', '/plan/rows:check', row({ item_id: 'FYP-0001' }))
    expect(check.json()).toMatchObject({
      blocked: true,
      text: 'Из кастома CUS-001 — в фуп не ставится',
    })
    // A FYP of its own goes as before.
    expect((await put(row({ item_id: 'FYP-0003' }))).json().created).toBe(true)
  })

  it('a FYP cut from a copy of a custom is refused too: provenance through the copy', async () => {
    expect(await refusal(row({ item_id: 'FYP-0002' }))).toBe(
      'из кастома CUS-001 — в фуп не ставится',
    )
  })

  it('a PPV from a custom: no story, no open wall; a paid wall post, the vault and the mass message stay', async () => {
    const ppv = { item_id: 'PPV-001' as const, time: '20:00' }
    expect(await refusal(row({ ...ppv, surface: 'story' }))).toBe(
      'из кастома CUS-001 — в сториз не ставится',
    )
    expect(await refusal(row({ ...ppv, surface: 'wall' }))).toBe(
      'из кастома CUS-001 — на стену только платным постом, с ценой',
    )
    for (const surface of ['vault', 'dm'] as const) {
      const response = await put(row({ ...ppv, surface }))
      expect(response.json().created, response.body).toBe(true)
    }
    const paid = await put(row({ ...ppv, surface: 'wall', price_mills: 15_000 }))
    expect(paid.json().created, paid.body).toBe(true)
    expect(paid.json().rows[0].publication.price_mills).toBe(15_000)
  })

  it('the price of a paid wall post of a custom cannot go later', async () => {
    const paid = await put(
      row({ item_id: 'PPV-001', surface: 'wall', date: day(3), price_mills: 20_000 }),
    )
    const created = paid.json().rows[0]
    const free = await send(
      owner,
      'PATCH',
      `/plan/rows/${created.id}`,
      { price_mills: null },
      created.version,
    )
    expect(free.statusCode, free.body).toBe(400)
    expect(free.json().message).toBe('из кастома CUS-001 — на стену только платным постом, с ценой')
    const zero = await send(
      owner,
      'PATCH',
      `/plan/rows/${created.id}`,
      { price_mills: 0 },
      created.version,
    )
    expect(zero.statusCode, zero.body).toBe(400)
    const other = await send(
      owner,
      'PATCH',
      `/plan/rows/${created.id}`,
      { price_mills: 25_000 },
      created.version,
    )
    expect(other.statusCode, other.body).toBe(200)
  })

  it('a montage from a copy of a custom is only a PPV', async () => {
    const montage = (expected: 'fyp' | 'ppv') => ({
      item_id: null,
      awaiting_montage: {
        from_item: 'RAW-0001' as const,
        expected_type: expected,
        file_keys: ['raw01'],
      },
    })
    expect(await refusal(row({ ...montage('fyp'), surface: 'fyp' }))).toBe(
      'из кастома CUS-001 монтируется только PPV',
    )
    const ppv = await put(row({ ...montage('ppv'), surface: 'vault' }))
    expect(ppv.json().created, ppv.body).toBe(true)
  })

  it('a row put before its object turned out to be from a custom is stopped at «Подготовить» and «Отправить»', async () => {
    const created = (await put(row({ item_id: 'FYP-0004', date: day(4) }))).json().rows[0]
    // Later a person links the FYP to the copy it was cut from.
    await linkCatalogItems(server.db, 'lora', [
      { child: 'FYP-0004', parent: 'RAW-0001', relation: 'montage_from', suggested: true },
    ])
    const prepare = await send(owner, 'POST', `/plan/rows/${created.id}:prepare`)
    expect(prepare.statusCode, prepare.body).toBe(422)
    expect(prepare.json()).toMatchObject({
      code: 'publication_refused',
      message: 'Из кастома CUS-001 — в фуп не ставится',
    })
    const sendRow = await send(owner, 'POST', `/plan/rows/${created.id}:send`, { version: 1 })
    expect(sendRow.statusCode, sendRow.body).toBe(422)
    expect(sendRow.json().code).toBe('publication_refused')
  })
})

describe('prices and deletion stay with people (SPEC §11.1)', () => {
  it('an agent plans a row without a price as before, but cannot set one', async () => {
    const plain = await put(row({ item_id: 'PPV-002', surface: 'vault', date: day(5) }), agent)
    expect(plain.statusCode, plain.body).toBe(201)
    expect(plain.json().created).toBe(true)
    const priced = await put(
      row({ item_id: 'PPV-002', surface: 'wall', time: '21:00', date: day(5), price_mills: 9_000 }),
      agent,
    )
    expect(priced.statusCode, priced.body).toBe(403)
    expect(priced.json().code).toBe('forbidden')
  })

  it('an agent edits a row but not its price', async () => {
    const created = (
      await put(row({ item_id: 'PPV-002', surface: 'wall', time: '22:00', date: day(6) }), agent)
    ).json().rows[0]
    const note = await send(
      agent,
      'PATCH',
      `/plan/rows/${created.id}`,
      { note: 'по плану' },
      created.version,
    )
    expect(note.statusCode, note.body).toBe(200)
    const price = await send(
      agent,
      'PATCH',
      `/plan/rows/${created.id}`,
      { price_mills: 9_000 },
      note.json().version,
    )
    expect(price.statusCode, price.body).toBe(403)
    expect(price.json().code).toBe('forbidden')
    // The same price again is no change.
    const same = await send(
      agent,
      'PATCH',
      `/plan/rows/${created.id}`,
      { price_mills: null },
      note.json().version,
    )
    expect(same.statusCode, same.body).toBe(200)
    const byOwner = await send(
      owner,
      'PATCH',
      `/plan/rows/${created.id}`,
      { price_mills: 9_000 },
      same.json().version,
    )
    expect(byOwner.statusCode, byOwner.body).toBe(200)
  })

  it('an agent does not delete an object; a person does', async () => {
    const read = async () =>
      (await call(server.app, { method: 'GET', url: '/api/v1/lora/i/LIFE-001', as: owner })).json()
    const before = await read()
    const byAgent = await send(agent, 'DELETE', '/i/LIFE-001', { confirm: true }, before.version)
    expect(byAgent.statusCode, byAgent.body).toBe(403)
    expect(byAgent.json().code).toBe('forbidden')
    expect((await read()).lifecycle).toEqual({ state: 'active' })
    const byOwner = await send(owner, 'DELETE', '/i/LIFE-001', { confirm: true }, before.version)
    expect(byOwner.statusCode, byOwner.body).toBe(200)
    expect((await read()).lifecycle).toMatchObject({ state: 'deleted' })
  })
})
