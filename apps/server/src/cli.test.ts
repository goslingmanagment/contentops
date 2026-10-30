import { type Io, main } from '@contentops/cli'
import { IssuedTokenSchema } from '@contentops/contracts/domain/agents'
import { sql } from 'drizzle-orm'
import type { InjectOptions } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, newKey, OWNER, signIn, type TestServer, testServer } from './testing/server'

/** `contentops` against the real server: its `fetch` goes through `app.inject`. */

let server: TestServer
let secret: string

function injectFetch(app: TestServer['app']): Io['fetch'] {
  return async (url, init) => {
    const target = new URL(url)
    const answer = await app.inject({
      method: init.method as InjectOptions['method'],
      url: `${target.pathname}${target.search}`,
      headers: Object.fromEntries(new Headers(init.headers)),
      ...(init.body === undefined || init.body === null ? {} : { payload: String(init.body) }),
    })
    const headers = new Headers()
    for (const [name, value] of Object.entries(answer.headers)) {
      if (value === undefined) continue
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item))
    }
    const empty = answer.statusCode === 204 || answer.statusCode === 304
    return new Response(empty ? null : new Uint8Array(answer.rawPayload), {
      status: answer.statusCode,
      headers,
    })
  }
}

async function contentops(token: string | undefined, ...argv: string[]) {
  const state = { out: '', err: '' }
  const code = await main(argv, {
    env: { CONTENTOPS_URL: 'http://cli.test', CONTENTOPS_TOKEN: token },
    fetch: injectFetch(server.app),
    stdout: (text) => {
      state.out += text
    },
    stderr: (text) => {
      state.err += text
    },
    readStdin: async () => '',
    cwd: process.cwd(),
    sleep: async () => {},
    now: () => Date.now(),
  })
  return { code, ...state }
}

beforeAll(async () => {
  server = await testServer()
  const owner = await signIn(server.app, OWNER.login, OWNER.password)
  const { rows } = await server.db.execute<{ id: string }>(sql`
    INSERT INTO principals (kind, login, display_name, role)
    VALUES ('agent', 'agent-cli', 'Агент CLI', 'manager') RETURNING id`)
  const agentId = rows[0]?.id ?? ''
  await server.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.actor_type', 'system', true),
      set_config('app.actor_label', 'test', true), set_config('app.action', 'test', true),
      set_config('app.request_id', 'test', true)`)
    await tx.execute(sql`INSERT INTO principal_grants (model_id, principal_id)
      SELECT id, ${agentId}::uuid FROM models WHERE code = 'lora'`)
  })
  const issued = await call(server.app, {
    method: 'POST',
    url: `/api/v1/admin/agents/${agentId}/tokens`,
    as: owner,
    key: newKey(),
    body: { agent_id: agentId, expires_in_days: 30 },
  })
  secret = IssuedTokenSchema.parse(issued.json()).secret
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

const NORM = ['plan', 'norm', '--model', 'lora', '--account', 'lora-1']

describe('contentops against the server', () => {
  it('reads a model route: exit 0, the answer as JSON on stdout', async () => {
    const result = await contentops(secret, ...NORM, '--json')
    expect(result).toMatchObject({ code: 0, err: '' })
    expect(result.out.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(result.out)).toMatchObject({ version: expect.any(Number) })
  })

  it('an object that is not there is exit 1 with the error body', async () => {
    const result = await contentops(
      secret,
      'objects',
      'get',
      '--model',
      'lora',
      '--id',
      'PPV-999',
      '--json',
    )
    expect(result.code).toBe(1)
    expect(JSON.parse(result.out)).toMatchObject({
      code: 'not_found',
      request_id: expect.any(String),
    })
    expect(result.err).toMatch(/^not_found: /)
  })

  it('no token and a foreign model are exit 2', async () => {
    const anonymous = await contentops(undefined, ...NORM)
    expect(anonymous.code).toBe(2)
    expect(anonymous.err).toContain('unauthenticated: ')
    const foreign = await contentops(secret, 'plan', 'norm', '--model', 'ari', '--account', 'ari-1')
    expect(foreign.code).toBe(2)
    expect(foreign.err).toContain('forbidden: ')
  })

  it('a change repeated with the same --idempotency-key is replayed, not applied twice', async () => {
    const {
      version,
      account: _account,
      ...norm
    } = JSON.parse((await contentops(secret, ...NORM)).out)
    const key = newKey()
    const change = [
      'plan',
      'updateNorm',
      '--model',
      'lora',
      '--account',
      'lora-1',
      '--if-match',
      String(version),
      '--idempotency-key',
      key,
      '--body',
      JSON.stringify({ ...norm, uniq_level: 'trim' }),
      '--json',
    ]
    const first = await contentops(secret, ...change)
    expect(first).toMatchObject({ code: 0, err: `idempotency-key: ${key}\n` })
    expect(JSON.parse(first.out)).toMatchObject({ version: version + 1, uniq_level: 'trim' })
    const repeat = await contentops(secret, ...change)
    expect(repeat).toMatchObject({ code: 0, out: first.out })
    expect(JSON.parse((await contentops(secret, ...NORM)).out).version).toBe(version + 1)
    const stale = await contentops(secret, ...change.map((arg) => (arg === key ? newKey() : arg)))
    expect(stale.code).toBe(1)
    expect(stale.err).toMatch(/^idempotency-key: .*\nversion_mismatch: /)
  })
})

describe('contentops for the routine customs-daily (SPEC §8.2)', () => {
  const card = 'https://t.me/c/2627984998/12/31337'
  const fields = {
    message_url: card,
    card_author: 'Чаттер',
    card_at: '2026-10-29T10:00:00Z',
    buyer: 'фан №4471',
    account: 'lora-1',
    brief: 'в чёрном спорт',
    duration_raw: '10 минут',
    wants_video: true,
    wants_photos: 0,
    deadline: null,
    fan_name: 'unknown',
    card_text: null,
  }

  it('finds no order, creates it, finds it by the link; a second create is exit 1', async () => {
    const missing = await contentops(
      secret,
      'orders',
      'find',
      '--model',
      'lora',
      '--tg',
      card,
      '--json',
    )
    expect(missing.code).toBe(1)
    expect(JSON.parse(missing.out)).toMatchObject({ code: 'not_found' })
    const create = [
      'orders',
      'create',
      '--model',
      'lora',
      '--body',
      JSON.stringify(fields),
      '--json',
    ]
    const created = await contentops(secret, ...create)
    expect(created.code).toBe(0)
    const order = JSON.parse(created.out)
    expect(order).toMatchObject({
      id: 'tg-2627984998-12-31337',
      state: 'waiting',
      created_by: { type: 'agent' },
    })
    const found = await contentops(
      secret,
      'orders',
      'find',
      '--model',
      'lora',
      '--tg',
      card,
      '--json',
    )
    expect(found.code).toBe(0)
    expect(JSON.parse(found.out).id).toBe(order.id)
    const again = await contentops(secret, ...create)
    expect(again.code).toBe(1)
    expect(JSON.parse(again.out)).toMatchObject({
      code: 'order_exists',
      details: { order: order.id },
    })
  })
})
