import { AgentSchema, IssuedTokenSchema } from '@contentops/contracts/domain/agents'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, newKey, OWNER, signIn, type TestServer, testServer } from './testing/server'

/** «Добавить агента» and its rights (DESIGN §4.19, SPEC §11.1): a token follows the agent. */

let server: TestServer
let owner: string

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
  if (on.statusCode !== 200) throw new Error(`agents on: ${on.body}`)
})
afterAll(() => server.close())

async function addAgent(body: { name: string; role: string; models: string[] }, key = newKey()) {
  return call(server.app, { method: 'POST', url: '/api/v1/admin/agents', as: owner, key, body })
}

async function tokenOf(agentId: string): Promise<string> {
  const response = await call(server.app, {
    method: 'POST',
    url: `/api/v1/admin/agents/${agentId}/tokens`,
    as: owner,
    key: newKey(),
    body: { agent_id: agentId, expires_in_days: null },
  })
  if (response.statusCode !== 201) throw new Error(`issue token: ${response.body}`)
  return `Bearer ${IssuedTokenSchema.parse(response.json()).secret}`
}

const normUrl = (model: string, account: string) => `/api/v1/${model}/accounts/${account}/week-norm`

async function readNorm(token: string, model: string, account: string) {
  return call(server.app, { method: 'GET', url: normUrl(model, account), as: token })
}

/** Puts the norm back as it is: a change that needs the manager role. */
async function writeNorm(token: string, model: string, account: string) {
  const norm = await call(server.app, { method: 'GET', url: normUrl(model, account), as: owner })
  const { version, account: _account, ...body } = norm.json()
  return call(server.app, {
    method: 'PUT',
    url: normUrl(model, account),
    as: token,
    key: newKey(),
    ifMatch: version,
    body,
  })
}

describe('add agent', () => {
  let agentId: string
  let token: string

  it('the owner adds a manager agent on Лора; it is journaled', async () => {
    const response = await addAgent({ name: 'Приёмка', role: 'manager', models: ['lora'] })
    expect(response.statusCode).toBe(201)
    const agent = AgentSchema.parse(response.json())
    expect(agent).toMatchObject({
      name: 'Приёмка',
      role: 'manager',
      models: ['lora'],
      tokens: [],
      version: 1,
    })
    agentId = agent.id
    const list = await call(server.app, { method: 'GET', url: '/api/v1/admin/agents', as: owner })
    expect(list.json().items.map((item: { id: string }) => item.id)).toContain(agentId)
    const { rows } = await server.db.execute<{ kind: string; after: unknown }>(sql`
      SELECT p.kind, a.after FROM action_log a JOIN principals p ON p.id = a.subject_id
       WHERE a.action = 'settings.addAgent' AND a.entry_kind = 'action' AND a.result = 'ok'
         AND a.subject_id = ${agentId}::uuid`)
    expect(rows).toEqual([
      { kind: 'agent', after: { Имя: 'Приёмка', Роль: 'Контент-менеджер', Модели: 'Лора' } },
    ])
  })

  it('its token reads and changes Лора and is refused on Ари', async () => {
    token = await tokenOf(agentId)
    expect((await readNorm(token, 'lora', 'lora-1')).statusCode).toBe(200)
    expect((await writeNorm(token, 'lora', 'lora-1')).statusCode).toBe(200)
    expect((await readNorm(token, 'ari', 'ari-1')).statusCode).toBe(403)
  })

  it('an agent does not manage agents, even with the manager role', async () => {
    const response = await call(server.app, {
      method: 'POST',
      url: '/api/v1/admin/agents',
      as: token,
      key: newKey(),
      body: { name: 'Сам себе', role: 'manager', models: ['lora'] },
    })
    expect(response.statusCode).toBe(403)
  })

  it('a reader agent reads but does not change', async () => {
    const response = await addAgent({ name: 'Fyper', role: 'reader', models: ['lora'] })
    expect(response.statusCode).toBe(201)
    const reader = await tokenOf(AgentSchema.parse(response.json()).id)
    expect((await readNorm(reader, 'lora', 'lora-1')).statusCode).toBe(200)
    const write = await writeNorm(reader, 'lora', 'lora-1')
    expect(write.statusCode).toBe(403)
    expect(write.json().message).toBe('Только чтение')
  })

  it('a repeat with the same key gives the same agent, not a second one', async () => {
    const key = newKey()
    const body = { name: 'Импорт', role: 'manager', models: ['ari'] }
    const first = await addAgent(body, key)
    const repeat = await addAgent(body, key)
    expect(first.statusCode).toBe(201)
    expect(repeat.statusCode).toBe(201)
    expect(repeat.json().id).toBe(first.json().id)
    const { rows } = await server.db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM principals WHERE kind = 'agent' AND display_name = 'Импорт'`)
    expect(rows).toEqual([{ count: 1 }])
  })

  it('an unknown model or the owner role is a 400', async () => {
    const unknown = await addAgent({ name: 'Заказы', role: 'manager', models: ['lora', 'nobody'] })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json().details).toEqual({ models: ['nobody'] })
    const ownerRole = await addAgent({ name: 'Заказы', role: 'owner', models: [] })
    expect(ownerRole.statusCode).toBe(400)
    const { rows } = await server.db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM principals WHERE display_name = 'Заказы'`)
    expect(rows).toEqual([{ count: 0 }])
  })

  describe('update agent', () => {
    const patch = (body: unknown, ifMatch?: number, key = newKey()) =>
      call(server.app, {
        method: 'PATCH',
        url: `/api/v1/admin/agents/${agentId}`,
        as: owner,
        key,
        ...(ifMatch === undefined ? {} : { ifMatch }),
        body,
      })

    it('needs the version: none is 428, a stale one 412 with what is there', async () => {
      expect((await patch({ role: 'reader' })).statusCode).toBe(428)
      const stale = await patch({ role: 'reader' }, 7)
      expect(stale.statusCode).toBe(412)
      expect(stale.json().details).toMatchObject({
        current_version: 1,
        current_value: { name: 'Приёмка', role: 'manager', models: ['lora'] },
      })
    })

    it('moving the agent to Ари as a reader moves its token at once', async () => {
      const response = await patch({ name: 'Приёмка Ари', role: 'reader', models: ['ari'] }, 1)
      expect(response.statusCode).toBe(200)
      expect(AgentSchema.parse(response.json())).toMatchObject({
        name: 'Приёмка Ари',
        role: 'reader',
        models: ['ari'],
        version: 2,
      })
      expect(response.json().tokens).toHaveLength(1)
      expect((await readNorm(token, 'lora', 'lora-1')).statusCode).toBe(403)
      expect((await readNorm(token, 'ari', 'ari-1')).statusCode).toBe(200)
      expect((await writeNorm(token, 'ari', 'ari-1')).statusCode).toBe(403)
      const { rows } = await server.db.execute<{ before: unknown; after: unknown }>(sql`
        SELECT before, after FROM action_log
         WHERE action = 'settings.updateAgent' AND entry_kind = 'action' AND result = 'ok'`)
      expect(rows).toEqual([
        {
          before: { Имя: 'Приёмка', Роль: 'Контент-менеджер', Модели: 'Лора' },
          after: { Имя: 'Приёмка Ари', Роль: 'Только чтение', Модели: 'Ари' },
        },
      ])
    })

    it('a manager again: the token changes Ари', async () => {
      const response = await patch({ role: 'manager' }, 2)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ role: 'manager', models: ['ari'], version: 3 })
      expect((await writeNorm(token, 'ari', 'ari-1')).statusCode).toBe(200)
    })

    it('an unknown model is a 400 and changes nothing', async () => {
      const response = await patch({ models: ['ari', 'nobody'] }, 3)
      expect(response.statusCode).toBe(400)
      const list = await call(server.app, {
        method: 'GET',
        url: '/api/v1/admin/agents',
        as: owner,
      })
      const agent = list.json().items.find((item: { id: string }) => item.id === agentId)
      expect(agent).toMatchObject({ models: ['ari'], version: 3 })
    })

    it('an unknown agent is a 404', async () => {
      const response = await call(server.app, {
        method: 'PATCH',
        url: '/api/v1/admin/agents/01a1b2c3-0000-7000-8000-000000000000',
        as: owner,
        key: newKey(),
        ifMatch: 1,
        body: { role: 'reader' },
      })
      expect(response.statusCode).toBe(404)
    })
  })
})
