import { resetPassword } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addPerson,
  call,
  newKey,
  OWNER,
  signIn,
  type TestServer,
  testServer,
} from './testing/server'

let server: TestServer
let owner: string

beforeAll(async () => {
  server = await testServer({ secrets: { ydisk: true, dropbox: false, hub: true } })
  owner = await signIn(server.app, OWNER.login, OWNER.password)
})
afterAll(() => server.close())

const get = (url: string, as = owner) => call(server.app, { method: 'GET', url, as })

describe('people and access', () => {
  it('a manager sees only granted models; the owner changes rights by version', async () => {
    const diana = await addPerson(server.app, owner, {
      name: 'Диана',
      login: 'diana',
      role: 'manager',
      models: ['lora'],
    })
    expect((await get('/api/v1/admin/me', diana.session)).json().models).toEqual(['lora'])
    expect(
      (await get('/api/v1/admin/models', diana.session))
        .json()
        .items.map((m: { code: string }) => m.code),
    ).toEqual(['lora'])
    expect((await get('/api/v1/admin/people', diana.session)).statusCode).toBe(403)

    const person = (await get('/api/v1/admin/people'))
      .json()
      .items.find((p: { login: string }) => p.login === 'diana')
    const change = (models: string[], key = newKey()) =>
      call(server.app, {
        method: 'PATCH',
        url: `/api/v1/admin/people/${diana.id}`,
        as: owner,
        key,
        ifMatch: person.version,
        body: { models },
      })
    const [left, right] = await Promise.all([change(['lora', 'ari']), change([])])
    expect([left?.statusCode, right?.statusCode].sort()).toEqual([200, 412])
    const grants = await get(`/api/v1/admin/people/${diana.id}/grants`)
    expect(grants.json().items[0].by).toBe('Дмитрий')
    expect(grants.json().items.length).toBe(2)
  })

  it('the owner cannot change their own role or revoke their own access', async () => {
    const me = (await get('/api/v1/admin/me')).json().person
    const role = await call(server.app, {
      method: 'PATCH',
      url: `/api/v1/admin/people/${me.id}`,
      as: owner,
      key: newKey(),
      ifMatch: me.version,
      body: { role: 'manager' },
    })
    expect(role.statusCode).toBe(403)
  })

  it('a duplicate login is a 400 on the field', async () => {
    const response = await call(server.app, {
      method: 'POST',
      url: '/api/v1/admin/people',
      as: owner,
      key: newKey(),
      body: { name: 'Диана 2', login: 'diana', role: 'reader', models: [] },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().details).toEqual({ field: 'login' })
  })

  it('names of the people of a model for «обычно выкладывает»', async () => {
    const names = (await get('/api/v1/lora/people'))
      .json()
      .items.map((p: { name: string }) => p.name)
    expect(names).toContain('Дмитрий')
  })
})

describe('models and pages', () => {
  it('adds a model and a page with its surfaces', async () => {
    const model = await call(server.app, {
      method: 'POST',
      url: '/api/v1/admin/models',
      as: owner,
      key: newKey(),
      body: { name: 'Мия', code: 'mia' },
    })
    expect(model.statusCode).toBe(201)
    const page = await call(server.app, {
      method: 'POST',
      url: '/api/v1/admin/models/mia/accounts',
      as: owner,
      key: newKey(),
      body: {
        platform: 'fansly',
        label: 'Fansly 1',
        code: 'mia-1',
        handle: 'MiaVie',
        hub_page: null,
      },
    })
    expect(page.statusCode).toBe(201)
    expect(page.json().accounts).toMatchObject([{ code: 'mia-1', position: 1, uniq_level: 'soft' }])
    const { rows } = await server.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM surfaces s JOIN accounts a ON a.id = s.account_id
       WHERE a.code = 'mia-1'`)
    expect(rows[0]?.n).toBe(5)
    const again = await call(server.app, {
      method: 'POST',
      url: '/api/v1/admin/models/mia/accounts',
      as: owner,
      key: newKey(),
      body: { platform: 'fansly', label: 'Fansly 2', code: 'mia-1', handle: 'x', hub_page: null },
    })
    expect(again.statusCode).toBe(400)
  })
})

describe('switches and thresholds', () => {
  it('Hub without a page code is not set up; with one it is off until switched on', async () => {
    const page = await call(server.app, {
      method: 'POST',
      url: '/api/v1/admin/models/lora/accounts',
      as: owner,
      key: newKey(),
      body: {
        platform: 'fansly',
        label: 'Fansly 9',
        code: 'lora-9',
        handle: 'L9',
        hub_page: 'lora-9',
      },
    })
    expect(page.statusCode).toBe(201)
    const hub = async () =>
      (await get('/api/v1/admin/integrations'))
        .json()
        .items.find((i: { id: string }) => i.id === 'hub:lora-9')
    expect((await hub()).state).toBe('off')
    expect((await hub()).line.text).toBe('Hub выключен для Fansly 9 — отметки работают')
    const on = await call(server.app, {
      method: 'PATCH',
      url: '/api/v1/admin/integrations/hub:lora-9',
      as: owner,
      key: newKey(),
      body: { switches: { receive: true } },
    })
    expect(on.statusCode).toBe(200)
    expect((await hub()).state).toBe('working')
    expect(
      (await get('/api/v1/admin/integrations'))
        .json()
        .items.find((i: { id: string }) => i.id === 'hub:lora-1').state,
    ).toBe('unset')
  })

  it('the row for everything is set by version; an exception is created and removed', async () => {
    const list = async () => (await get('/api/v1/admin/thresholds')).json().items
    const base = (await list()).find((t: { key: string }) => t.key === 'too_early_days')
    expect(base).toMatchObject({ value: null, version: 1, scope: 'all' })
    const set = await call(server.app, {
      method: 'PUT',
      url: '/api/v1/admin/thresholds',
      as: owner,
      key: newKey(),
      ifMatch: 1,
      body: { key: 'too_early_days', value: 14 },
    })
    expect(set.statusCode).toBe(200)
    expect(set.json()).toMatchObject({ value: 14, version: 2 })
    const exception = await call(server.app, {
      method: 'PUT',
      url: '/api/v1/admin/thresholds',
      as: owner,
      key: newKey(),
      body: { key: 'too_early_days', scope: 'type', scope_value: 'life', value: 7 },
    })
    expect(exception.statusCode).toBe(200)
    expect((await list()).filter((t: { key: string }) => t.key === 'too_early_days')).toHaveLength(
      2,
    )
    const remove = await call(server.app, {
      method: 'POST',
      url: '/api/v1/admin/thresholds:remove',
      as: owner,
      key: newKey(),
      ifMatch: 1,
      body: { key: 'too_early_days', scope: 'type', scope_value: 'life' },
    })
    expect(remove.statusCode).toBe(200)
    const off = await call(server.app, {
      method: 'PUT',
      url: '/api/v1/admin/thresholds',
      as: owner,
      key: newKey(),
      ifMatch: 2,
      body: { key: 'too_early_days', value: null },
    })
    expect(off.json()).toMatchObject({ value: null, version: 3 })
    const { rows } = await server.db.execute<{ value: unknown }>(sql`
      SELECT value FROM policy_settings WHERE key = 'too_early_days' AND item_type IS NULL`)
    expect(rows).toEqual([{ value: null }])
  })
})

describe('journal', () => {
  it('pages by cursor bound to its filters; model-less events only for the owner', async () => {
    const first = await get('/api/v1/lora/journal?limit=2')
    expect(first.statusCode).toBe(200)
    const page = first.json()
    expect(page.items).toHaveLength(2)
    expect(page.next_cursor).toBeTruthy()
    const next = await get(`/api/v1/lora/journal?limit=2&cursor=${page.next_cursor}`)
    expect(next.json().items[0].id).not.toBe(page.items[1].id)
    const foreign = await get(
      `/api/v1/lora/journal?limit=2&actor_type=agent&cursor=${page.next_cursor}`,
    )
    expect(foreign.statusCode).toBe(400)

    const people = await get('/api/v1/lora/journal?area=settings&limit=500')
    const phrases = people.json().items.map((e: { phrase: string }) => e.phrase)
    expect(phrases).toContain('Дмитрий добавил человека: Диана')

    const km = await addPerson(server.app, owner, {
      name: 'Катя',
      login: 'katya',
      role: 'manager',
      models: ['lora'],
    })
    const seen = (await get('/api/v1/lora/journal?limit=500', km.session)).json().items
    expect(seen.map((e: { phrase: string }) => e.phrase)).not.toContain(
      'Дмитрий добавил человека: Диана',
    )
  })
})

describe('reset-password command', () => {
  it('sets a new password, revokes sessions and journals it as the system', async () => {
    const session = await signIn(server.app, OWNER.login, OWNER.password)
    const result = await resetPassword(server.db, OWNER.login, 'brand-new-password')
    expect(result.revokedSessions).toBeGreaterThan(0)
    expect((await get('/api/v1/admin/me', session)).statusCode).toBe(401)
    owner = await signIn(server.app, OWNER.login, 'brand-new-password')
    const { rows } = await server.db.execute<{ actor_type: string }>(sql`
      SELECT actor_type FROM action_log WHERE action = 'principal.reset_password'`)
    expect(rows).toEqual([{ actor_type: 'system' }])
  })
})
