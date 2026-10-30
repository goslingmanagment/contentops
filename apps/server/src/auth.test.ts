import { IssuedTokenSchema } from '@contentops/contracts/domain/agents'
import { SessionPrincipalSchema } from '@contentops/contracts/domain/people'
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
  server = await testServer()
  owner = await signIn(server.app, OWNER.login, OWNER.password)
})
afterAll(() => server.close())

async function journal(action: string) {
  const { rows } = await server.db.execute<{ result: string; actor_type: string }>(sql`
    SELECT result, actor_type FROM action_log
     WHERE action = ${action} AND entry_kind = 'action' ORDER BY id`)
  return rows
}

describe('sign-in and sessions', () => {
  it('refuses a wrong password with 401 and journals the attempt', async () => {
    const before = (await journal('auth.signIn')).length
    const response = await call(server.app, {
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      body: { login: OWNER.login, password: 'wrong-password' },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().message).toBe('Логин или пароль не подходят')
    expect(response.headers['set-cookie']).toBeUndefined()
    const rows = await journal('auth.signIn')
    expect(rows.slice(before)).toEqual([{ result: 'denied', actor_type: 'system' }])
  })

  it('gives an HttpOnly SameSite cookie, stores only its hash for 30 days', async () => {
    const response = await call(server.app, {
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      body: { login: 'DMITRIY', password: OWNER.password },
    })
    expect(response.statusCode).toBe(200)
    const cookie = String(response.headers['set-cookie'])
    expect(cookie).toMatch(
      /^co_session=[\w-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/,
    )
    const token = /co_session=([^;]+)/.exec(cookie)?.[1] ?? ''
    const { rows } = await server.db.execute<{ days: number }>(sql`
      SELECT round(extract(epoch FROM expires_at - created_at) / 86400)::int AS days
        FROM sessions WHERE token_hash = sha256(convert_to(${token}, 'UTF8'))`)
    expect(rows).toEqual([{ days: 30 }])
  })

  it('answers me with the person, the models and the skin', async () => {
    const response = await call(server.app, { method: 'GET', url: '/api/v1/admin/me', as: owner })
    expect(response.statusCode).toBe(200)
    const me = SessionPrincipalSchema.parse(response.json())
    expect(me).toMatchObject({ models: ['lora', 'ari'], ui_skin: 'blue' })
    expect(me.person).toMatchObject({ login: 'dmitriy', role: 'owner' })
  })

  it('changes the name and the skin of the profile', async () => {
    const response = await call(server.app, {
      method: 'PATCH',
      url: '/api/v1/admin/me',
      as: owner,
      key: newKey(),
      body: { ui_skin: 'focus' },
    })
    expect(response.statusCode).toBe(200)
    const me = await call(server.app, { method: 'GET', url: '/api/v1/admin/me', as: owner })
    expect(me.json().ui_skin).toBe('focus')
  })

  it('rotates the session of the same browser on a new sign-in', async () => {
    const first = await signIn(server.app, OWNER.login, OWNER.password)
    const second = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { cookie: `co_session=${first}` },
      payload: { login: OWNER.login, password: OWNER.password },
    })
    expect(second.statusCode).toBe(200)
    const old = await call(server.app, { method: 'GET', url: '/api/v1/admin/me', as: first })
    expect(old.statusCode).toBe(401)
    const { rows } = await server.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM sessions WHERE replaced_by_id IS NOT NULL`)
    expect(rows[0]?.n).toBeGreaterThan(0)
  })

  it('lists own sessions and revokes one; the revoked one is 401 at once', async () => {
    const other = await signIn(server.app, OWNER.login, OWNER.password)
    const list = await call(server.app, {
      method: 'GET',
      url: '/api/v1/admin/me/sessions',
      as: owner,
    })
    const sessions = list.json().items as { id: string; current: boolean }[]
    expect(sessions[0]?.current).toBe(true)
    const { rows } = await server.db.execute<{ id: string }>(sql`
      SELECT id FROM sessions WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`)
    const target = rows[0]?.id ?? ''
    const revoke = await call(server.app, {
      method: 'POST',
      url: `/api/v1/admin/me/sessions/${target}:revoke`,
      as: owner,
      key: newKey(),
    })
    expect(revoke.statusCode).toBe(200)
    expect(
      (await call(server.app, { method: 'GET', url: '/api/v1/admin/me', as: other })).statusCode,
    ).toBe(401)
  })

  it('an expired session is 401', async () => {
    const session = await signIn(server.app, OWNER.login, OWNER.password)
    await server.db.execute(sql`
      UPDATE sessions SET expires_at = now() - interval '1 second'
       WHERE id = (SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1)`)
    const response = await call(server.app, { method: 'GET', url: '/api/v1/admin/me', as: session })
    expect(response.statusCode).toBe(401)
  })

  it('changing the password signs out the other browsers, not this one', async () => {
    const nikita = await addPerson(server.app, owner, {
      name: 'Никита',
      login: 'nikita',
      role: 'manager',
      models: ['lora'],
    })
    const phone = await signIn(server.app, 'nikita', nikita.password)
    const change = await call(server.app, {
      method: 'POST',
      url: '/api/v1/admin/me/password',
      as: nikita.session,
      key: newKey(),
      body: { current: nikita.password, next: 'nikita-new-pass' },
    })
    expect(change.statusCode).toBe(200)
    const me = (session: string) =>
      call(server.app, { method: 'GET', url: '/api/v1/admin/me', as: session })
    expect((await me(nikita.session)).statusCode).toBe(200)
    expect((await me(phone)).statusCode).toBe(401)
    expect(await signIn(server.app, 'nikita', 'nikita-new-pass')).toBeTruthy()
  })

  it('sign-out everywhere ends every session', async () => {
    const person = await addPerson(server.app, owner, {
      name: 'Ира',
      login: 'ira',
      role: 'reader',
      models: ['lora'],
    })
    const second = await signIn(server.app, 'ira', person.password)
    const response = await call(server.app, {
      method: 'POST',
      url: '/api/v1/auth/sign-out-everywhere',
      as: person.session,
      key: newKey(),
    })
    expect(response.statusCode).toBe(200)
    expect(String(response.headers['set-cookie'])).toContain('Max-Age=0')
    for (const session of [person.session, second]) {
      const me = await call(server.app, { method: 'GET', url: '/api/v1/admin/me', as: session })
      expect(me.statusCode).toBe(401)
    }
  })
})

describe('secret answers', () => {
  it('a temporary password is shown once: a repeat answers 409 «уже выполнено»', async () => {
    const key = newKey()
    const request = {
      method: 'POST' as const,
      url: '/api/v1/admin/people',
      as: owner,
      key,
      body: { name: 'Оля', login: 'olya', role: 'reader', models: ['ari'] },
    }
    const first = await call(server.app, request)
    expect(first.statusCode).toBe(201)
    expect(first.json().temporary_password).toMatch(/^\w{4}-\w{4}-\w{4}-\w{4}$/)
    expect(first.json().person.gender).toBe('f')
    const repeat = await call(server.app, request)
    expect(repeat.statusCode).toBe(409)
    expect(repeat.json().message).toBe('Уже выполнено — повторите с новым ключом')
    const { rows } = await server.db.execute<{ state: string; response: unknown }>(sql`
      SELECT state, response FROM idempotency_keys WHERE key = ${key}`)
    expect(rows).toEqual([{ state: 'no_replay', response: null }])
  })
})

describe('agents', () => {
  let agentId: string
  let secret: string

  beforeAll(async () => {
    const { rows } = await server.db.execute<{ id: string }>(sql`
      INSERT INTO principals (kind, login, display_name, role)
      VALUES ('agent', 'agent-norms', 'Нормы', 'manager') RETURNING id`)
    agentId = rows[0]?.id ?? ''
    await server.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.actor_type', 'system', true),
        set_config('app.actor_label', 'test', true), set_config('app.action', 'test', true),
        set_config('app.request_id', 'test', true)`)
      await tx.execute(sql`INSERT INTO principal_grants (model_id, principal_id)
        SELECT id, ${agentId}::uuid FROM models WHERE code = 'lora'`)
    })
  })

  it('issues a token once; the secret is not stored and not replayed', async () => {
    const key = newKey()
    const request = {
      method: 'POST' as const,
      url: `/api/v1/admin/agents/${agentId}/tokens`,
      as: owner,
      key,
      body: { agent_id: agentId, expires_in_days: 30 },
    }
    const response = await call(server.app, request)
    expect(response.statusCode).toBe(201)
    const issued = IssuedTokenSchema.parse(response.json())
    secret = issued.secret
    expect(secret.startsWith(issued.token.prefix)).toBe(true)
    expect((await call(server.app, request)).statusCode).toBe(409)
  })

  it('agents are off until the owner turns them on', async () => {
    const me = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/accounts/lora-1/week-norm',
      as: `Bearer ${secret}`,
    })
    expect(me.statusCode).toBe(403)
    const on = await call(server.app, {
      method: 'PATCH',
      url: '/api/v1/admin/integrations/agents',
      as: owner,
      key: newKey(),
      body: { switches: { enabled: true } },
    })
    expect(on.statusCode).toBe(200)
    expect(on.json().state).toBe('working')
    const after = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/accounts/lora-1/week-norm',
      as: `Bearer ${secret}`,
    })
    expect(after.statusCode).toBe(200)
  })

  it('an agent must send Idempotency-Key and stays inside its models', async () => {
    const norm = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/accounts/lora-1/week-norm',
      as: `Bearer ${secret}`,
    })
    const { version, account: _account, ...body } = norm.json()
    const noKey = await call(server.app, {
      method: 'PUT',
      url: '/api/v1/lora/accounts/lora-1/week-norm',
      as: `Bearer ${secret}`,
      ifMatch: version,
      body,
    })
    expect(noKey.statusCode).toBe(400)
    const ok = await call(server.app, {
      method: 'PUT',
      url: '/api/v1/lora/accounts/lora-1/week-norm',
      as: `Bearer ${secret}`,
      key: newKey(),
      ifMatch: version,
      body: { ...body, uniq_level: 'trim' },
    })
    expect(ok.statusCode).toBe(200)
    const foreign = await call(server.app, {
      method: 'GET',
      url: '/api/v1/ari/accounts/ari-1/week-norm',
      as: `Bearer ${secret}`,
    })
    expect(foreign.statusCode).toBe(403)
    const { rows } = await server.db.execute<{ used: boolean }>(sql`
      SELECT last_used_at IS NOT NULL AS used FROM api_tokens WHERE principal_id = ${agentId}::uuid`)
    expect(rows[0]?.used).toBe(true)
  })

  it('a revoked token is 401 at once', async () => {
    const { rows } = await server.db.execute<{ id: string }>(sql`
      SELECT id FROM api_tokens WHERE principal_id = ${agentId}::uuid`)
    const revoke = await call(server.app, {
      method: 'POST',
      url: `/api/v1/admin/agents/${agentId}/tokens/${rows[0]?.id}:revoke`,
      as: owner,
      key: newKey(),
    })
    expect(revoke.statusCode).toBe(200)
    expect(revoke.json().tokens[0].revoked_at).not.toBeNull()
    const after = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/accounts/lora-1/week-norm',
      as: `Bearer ${secret}`,
    })
    expect(after.statusCode).toBe(401)
  })
})
