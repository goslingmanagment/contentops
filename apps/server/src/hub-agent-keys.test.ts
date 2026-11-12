import { createHash } from 'node:crypto'
import { IssuedTokenSchema } from '@contentops/contracts/domain/agents'
import {
  HUB_AGENT_KEY_PREFIX,
  type HubAgentKeys,
  HubError,
  type HubKeyAnswer,
} from '@contentops/hub'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHubAgentKeyService, HUB_KEY_FRESH_MS, HUB_KEY_HOLD_MS } from './auth/hub-agent-keys'
import { opsHubAgent } from './ops-owner'
import { call, newKey, OWNER, signIn, type TestServer, testServer } from './testing/server'

/**
 * An agent's hub key (SPEC §11.1, ecosystem M2): Hub says whose key it is, by its sha256 only;
 * the owner's link says which local agent it acts as; a code without a link, an inactive key and
 * a person's route get nothing; the answer holds a minute, an active one up to an hour while Hub
 * is down, an inactive one never; every call is written under the agent's code.
 */

const digest = (token: string) => createHash('sha256').update(token).digest('hex')

/** Hub's «кто этот ключ»: the digests it knows, and whether it answers at all. */
class FakeHub implements HubAgentKeys {
  readonly active = new Map<string, string>()
  readonly asked: string[] = []
  down = false
  refuse = false
  expiresAt = new Date(Date.now() + 30 * 86_400_000)

  async introspect(keyDigest: string): Promise<HubKeyAnswer> {
    this.asked.push(keyDigest)
    if (this.down) {
      throw new HubError('transient', 'network: connect ECONNREFUSED', {
        endpoint: 'agentKeys.introspect',
      })
    }
    if (this.refuse) {
      throw new HubError('auth_rejected', 'agentKeys.introspect: HTTP 403', {
        endpoint: 'agentKeys.introspect',
        status: 403,
      })
    }
    const code = this.active.get(keyDigest)
    return code
      ? {
          active: true,
          agent: { code, displayName: code },
          expiresAt: this.expiresAt,
          cacheSeconds: 60,
          staleSeconds: 3600,
        }
      : { active: false, cacheSeconds: 60, staleSeconds: 3600 }
  }
}

const hub = new FakeHub()
let clock = Date.now()
let server: TestServer
let plain: TestServer
let owner: string
let localToken: string
let agentId: string

const GENGAR = `${HUB_AGENT_KEY_PREFIX}gengar-key`
const STRANGER = `${HUB_AGENT_KEY_PREFIX}stranger-key`
const WEEK = '2026-W46'

beforeAll(async () => {
  ;[server, plain] = await Promise.all([
    testServer({ hubAgentKeys: createHubAgentKeyService(hub, { now: () => clock }) }),
    testServer(),
  ])
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  const on = await call(server.app, {
    method: 'PATCH',
    url: '/api/v1/admin/integrations/agents',
    as: owner,
    key: newKey(),
    body: { switches: { enabled: true } },
  })
  if (on.statusCode !== 200) throw new Error(`agents on: ${on.body}`)
  const added = await call(server.app, {
    method: 'POST',
    url: '/api/v1/admin/agents',
    as: owner,
    key: newKey(),
    body: { name: 'Генгар', role: 'manager', models: ['lora'] },
  })
  if (added.statusCode !== 201) throw new Error(`add agent: ${added.body}`)
  agentId = added.json().id
  const token = await call(server.app, {
    method: 'POST',
    url: `/api/v1/admin/agents/${agentId}/tokens`,
    as: owner,
    key: newKey(),
    body: { agent_id: agentId, expires_in_days: null },
  })
  localToken = `Bearer ${IssuedTokenSchema.parse(token.json()).secret}`
  await opsHubAgent(server.db, { name: 'Генгар', code: 'gengar' })
  hub.active.set(digest(GENGAR), 'gengar')
  hub.active.set(digest(STRANGER), 'stranger')
})
afterAll(() => Promise.all([server.close(), plain.close()]))
beforeEach(() => {
  hub.down = false
  hub.refuse = false
  hub.active.set(digest(GENGAR), 'gengar')
  // Every test starts past any answer an earlier one left.
  clock += HUB_KEY_HOLD_MS * 2
})

const as = (token: string) => `Bearer ${token}`
const plan = (token: string, model = 'lora', app = server.app) =>
  call(app, { method: 'GET', url: `/api/v1/${model}/plan?week=${WEEK}`, as: as(token) })

async function calls() {
  const { rows } = await server.db.execute<{
    agent_code: string
    principal_id: string | null
    method: string
    url: string
    outcome: string
    held: boolean
  }>(
    sql`SELECT agent_code, principal_id, method, url, outcome, held FROM hub_agent_calls ORDER BY id`,
  )
  return rows
}

describe('rights of a hub key', () => {
  it('acts as the linked local agent: its models, its role, never a person’s route', async () => {
    const read = await plan(GENGAR)
    expect(read.statusCode, read.body).toBe(200)
    // Ари is not granted to the local agent: the hub key has no more than it.
    expect((await plan(GENGAR, 'ari')).statusCode).toBe(403)
    const me = await call(server.app, { method: 'GET', url: '/api/v1/admin/me', as: as(GENGAR) })
    expect(me.statusCode).toBe(403)
    expect(me.json().message).toContain('Только для людей')
    const people = await call(server.app, {
      method: 'GET',
      url: '/api/v1/admin/people',
      as: as(GENGAR),
    })
    expect(people.statusCode).toBe(403)
    const rows = await calls()
    expect(rows.slice(-4)).toEqual([
      expect.objectContaining({ agent_code: 'gengar', principal_id: agentId, outcome: 'ok' }),
      expect.objectContaining({ url: `/api/v1/ari/plan?week=${WEEK}`, outcome: 'ok' }),
      expect.objectContaining({ method: 'GET', url: '/api/v1/admin/me', outcome: 'ok' }),
      expect.objectContaining({ url: '/api/v1/admin/people', held: false }),
    ])
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain(HUB_AGENT_KEY_PREFIX)
      expect(JSON.stringify(row)).not.toContain(digest(GENGAR))
    }
    // Hub got the digest, never the key.
    expect(hub.asked).toContain(digest(GENGAR))
    expect(hub.asked.join()).not.toContain(HUB_AGENT_KEY_PREFIX)
  })

  it('a code without a link gets nothing, an inactive key is no key', async () => {
    const stranger = await plan(STRANGER)
    expect(stranger.statusCode).toBe(403)
    expect(stranger.json().message).toContain('не связан')
    expect((await calls()).at(-1)).toMatchObject({
      agent_code: 'stranger',
      principal_id: null,
      outcome: 'not_linked',
    })
    const unknown = await plan(`${HUB_AGENT_KEY_PREFIX}made-up`)
    expect(unknown.statusCode).toBe(401)
    expect(unknown.json().message).toContain('не действует')
  })

  it('the owner’s link and switch decide at once; local tokens work as before', async () => {
    await opsHubAgent(server.db, { name: 'Генгар', code: null })
    expect((await plan(GENGAR)).statusCode).toBe(403)
    expect(
      (
        await call(server.app, {
          method: 'GET',
          url: `/api/v1/lora/plan?week=${WEEK}`,
          as: localToken,
        })
      ).statusCode,
    ).toBe(200)
    await opsHubAgent(server.db, { name: 'Генгар', code: 'gengar' })
    expect((await plan(GENGAR)).statusCode).toBe(200)
    await expect(opsHubAgent(server.db, { name: 'Генгар', code: 'Bad Code' })).rejects.toThrow()
    // One code — one agent.
    await expect(
      server.db.execute(
        sql`UPDATE principals SET hub_agent_code = 'gengar' WHERE login = ${OWNER.login}`,
      ),
    ).rejects.toThrow()
    const off = await call(server.app, {
      method: 'PATCH',
      url: '/api/v1/admin/integrations/agents',
      as: owner,
      key: newKey(),
      body: { switches: { enabled: false } },
    })
    expect(off.statusCode).toBe(200)
    try {
      const refused = await plan(GENGAR)
      expect(refused.statusCode).toBe(403)
      expect(refused.json().message).toContain('Агенты выключены')
    } finally {
      await call(server.app, {
        method: 'PATCH',
        url: '/api/v1/admin/integrations/agents',
        as: owner,
        key: newKey(),
        body: { switches: { enabled: true } },
      })
    }
  })

  it('without ContentOps’ own hub key a hub key is an unknown token', async () => {
    expect((await plan(GENGAR, 'lora', plain.app)).statusCode).toBe(401)
  })
})

describe('the answer of Hub over time', () => {
  it('a revoke at Hub is seen within the minute', async () => {
    expect((await plan(GENGAR)).statusCode).toBe(200)
    hub.active.delete(digest(GENGAR))
    clock += HUB_KEY_FRESH_MS - 1_000
    expect((await plan(GENGAR)).statusCode).toBe(200)
    clock += 2_000
    expect((await plan(GENGAR)).statusCode).toBe(401)
  })

  it('Hub down: the active answer holds up to an hour, then a clear refusal', async () => {
    expect((await plan(GENGAR)).statusCode).toBe(200)
    hub.down = true
    clock += 10 * 60_000
    expect((await plan(GENGAR)).statusCode).toBe(200)
    expect((await calls()).at(-1)).toMatchObject({ agent_code: 'gengar', held: true })
    const asked = hub.asked.length
    clock += 5_000
    expect((await plan(GENGAR)).statusCode).toBe(200)
    expect(hub.asked.length).toBe(asked)
    clock += 49 * 60_000 + 50_000
    expect((await plan(GENGAR)).statusCode).toBe(200)
    clock += 10_000
    const refused = await plan(GENGAR)
    expect(refused.statusCode).toBe(503)
    expect(refused.json().message).toContain('хаб не отвечает')
  })

  it('an inactive answer is never extended, a refusal of Hub holds nothing', async () => {
    hub.active.delete(digest(GENGAR))
    expect((await plan(GENGAR)).statusCode).toBe(401)
    hub.down = true
    clock += HUB_KEY_FRESH_MS + 1_000
    expect((await plan(GENGAR)).statusCode).toBe(503)

    hub.down = false
    hub.active.set(digest(GENGAR), 'gengar')
    clock += HUB_KEY_FRESH_MS + 1_000
    expect((await plan(GENGAR)).statusCode).toBe(200)
    hub.refuse = true
    clock += HUB_KEY_FRESH_MS + 1_000
    const refused = await plan(GENGAR)
    expect(refused.statusCode).toBe(503)
    expect(refused.json().message).toContain('хаб отказал')
    hub.refuse = false
    hub.down = true
    expect((await plan(GENGAR)).statusCode).toBe(503)
  })

  it('an answer never outlives the key', async () => {
    hub.expiresAt = new Date(clock + 30_000)
    try {
      expect((await plan(GENGAR)).statusCode).toBe(200)
      clock += 31_000
      expect((await plan(GENGAR)).statusCode).toBe(401)
    } finally {
      hub.expiresAt = new Date(Date.now() + 30 * 86_400_000)
    }
  })
})
