import { randomBytes } from 'node:crypto'
import { IssuedTokenSchema } from '@contentops/contracts/domain/agents'
import { HubError, type HubRedeemed, type HubSignin, type HubSigninUser } from '@contentops/hub'
import { sql } from 'drizzle-orm'
import type { LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { HUB_CHECK_EVERY_MS, HUB_SILENCE_MS } from './auth/hub-signin'
import { call, newKey, OWNER, signIn, type TestServer, testServer } from './testing/server'

/**
 * «Войти через хаб» (SPEC §11.1): the state of the browser, single use of a code, no session
 * without a linked principal, the hub's sign-out ends ours; the password and the agents'
 * tokens work as before.
 */

const PUBLIC = 'contentops.example.test'
const TAILNET = 'contentops.tailnet.example.test'
const OWNER_AT_HUB: HubSigninUser = { id: 7, username: 'boss', role: 'owner' }

/** Hub's half: codes it has minted, grants it has handed out, and whether it answers at all. */
class FakeHub implements HubSignin {
  redeemed = 0
  checks = 0
  probes = 0
  unreachable = false
  /** The hub answers the re-check with this refusal (401, 403, 404…): it is not down, it says no. */
  refusing: { kind: 'auth_rejected' | 'refused'; status: number } | null = null
  private readonly codes = new Map<string, HubRedeemed>()
  private readonly live = new Map<string, HubSigninUser>()

  /** A person signed in at the hub went to ContentOps: the code of the callback. */
  mint(user: HubSigninUser, owner = user.role === 'owner'): string {
    const code = randomBytes(32).toString('base64url')
    const grant = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + 20 * 24 * 60 * 60_000)
    this.codes.set(code, { user, owner, expiresAt, grant })
    this.live.set(grant, user)
    return code
  }

  /** The person signed out at the hub, or the owner revoked them there. */
  signOutAll(): void {
    this.live.clear()
  }

  startUrl({ state, next, silent }: { state: string; next: string; silent?: boolean }): string {
    const query = { to: 'contentops', state, next, ...(silent ? { silent: '1' } : {}) }
    return `https://hub.example.test/api/v1/auth/sso?${new URLSearchParams(query)}`
  }

  async answers(): Promise<boolean> {
    this.probes += 1
    return !this.unreachable
  }

  async redeem(code: string): Promise<HubRedeemed> {
    this.redeemed += 1
    const person = this.codes.get(code)
    this.codes.delete(code)
    if (!person) {
      throw new HubError('refused', 'signin.redeem: HTTP 409', {
        endpoint: 'signin.redeem',
        status: 409,
      })
    }
    return person
  }

  async check(grant: string) {
    this.checks += 1
    if (this.unreachable) {
      throw new HubError('transient', 'network: connect ECONNREFUSED', { endpoint: 'signin.check' })
    }
    if (this.refusing) {
      throw new HubError(this.refusing.kind, `signin.check: HTTP ${this.refusing.status}`, {
        endpoint: 'signin.check',
        status: this.refusing.status,
      })
    }
    const user = this.live.get(grant)
    return user
      ? {
          active: true as const,
          user,
          owner: user.role === 'owner',
          expiresAt: new Date(Date.now() + 86_400_000),
        }
      : { active: false as const }
  }
}

let server: TestServer
let plain: TestServer
const hub = new FakeHub()
let clock = Date.now()

beforeAll(async () => {
  ;[server, plain] = await Promise.all([
    testServer({
      hubSignin: {
        hub,
        origin: `https://${PUBLIC}`,
        ownerLogin: OWNER.login,
        now: () => clock,
      },
    }),
    testServer(),
  ])
})
afterAll(() => Promise.all([server.close(), plain.close()]))
beforeEach(() => {
  hub.unreachable = false
  hub.refusing = null
})

function cookieOf(response: LightMyRequestResponse, name: string): string | undefined {
  const header = response.headers['set-cookie']
  const all = Array.isArray(header) ? header : header ? [header] : []
  for (const line of all) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(line)
    if (match) return match[1]
  }
  return undefined
}

function get(url: string, headers: Record<string, string> = {}, app = server.app) {
  return app.inject({ method: 'GET', url, headers: { host: PUBLIC, ...headers } })
}

/** «Войти через хаб» pressed: the state cookie this browser now holds. */
async function start(next = '/lora/library'): Promise<string> {
  const response = await get(`/auth/hub/start?${new URLSearchParams({ next })}`)
  expect(response.statusCode).toBe(302)
  const state = cookieOf(response, 'co_hub_state')
  expect(state).toMatch(/^[\w-]{43}$/)
  const location = new URL(String(response.headers.location))
  expect(location.origin).toBe('https://hub.example.test')
  expect(location.searchParams.get('state')).toBe(state)
  expect(location.searchParams.get('next')).toBe(next)
  return state ?? ''
}

/** The hub sent the browser back with a code. */
function callback(input: { code: string; state: string; cookie?: string; next?: string }) {
  const query = new URLSearchParams({
    code: input.code,
    state: input.state,
    next: input.next ?? '/lora/library',
  })
  return get(
    `/auth/hub/callback?${query}`,
    input.cookie === undefined ? {} : { cookie: input.cookie },
  )
}

/** The whole way for the hub's owner: start, the hub, the callback; the session cookie. */
async function signInThroughHub(user = OWNER_AT_HUB): Promise<string> {
  const state = await start()
  const response = await callback({
    code: hub.mint(user),
    state,
    cookie: `co_hub_state=${state}`,
  })
  expect(response.statusCode).toBe(302)
  expect(response.headers.location).toBe('/lora/library')
  const session = cookieOf(response, 'co_session')
  expect(session).toMatch(/^hub\.[\w-]{43}$/)
  return session ?? ''
}

function me(session: string) {
  return call(server.app, { method: 'GET', url: '/api/v1/admin/me', as: session })
}

async function sessionCount(): Promise<number> {
  const { rows } = await server.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM sessions`,
  )
  return rows[0]?.n ?? 0
}

describe('where «Войти через хаб» is offered', () => {
  it('only on the public name, and only where the hub is configured', async () => {
    expect((await get('/api/v1/auth/methods')).json()).toEqual({ hub: true })
    expect((await get('/api/v1/auth/methods', { host: TAILNET })).json()).toEqual({ hub: false })
    expect((await get('/api/v1/auth/methods', {}, plain.app)).json()).toEqual({ hub: false })
  })

  it('elsewhere the start and the callback lead to the password screen', async () => {
    const elsewhere = await get('/auth/hub/start?next=%2Fplan', { host: TAILNET })
    expect(elsewhere.statusCode).toBe(302)
    expect(elsewhere.headers.location).toBe('/login?from=%2Fplan')
    expect(cookieOf(elsewhere, 'co_hub_state')).toBeUndefined()
    const off = await get('/auth/hub/callback?code=x&state=y', {}, plain.app)
    expect(off.headers.location).toBe('/login')
  })
})

describe('the callback', () => {
  it('refuses a state that is not this browser’s: no redeem, no session', async () => {
    const before = hub.redeemed
    const state = await start()
    const code = hub.mint(OWNER_AT_HUB)
    for (const cookie of [undefined, `co_hub_state=${'x'.repeat(43)}`]) {
      const response = await callback({ code, state, ...(cookie ? { cookie } : {}) })
      expect(response.statusCode).toBe(302)
      expect(response.headers.location).toBe('/login?from=%2Flora%2Flibrary&hub=failed')
      expect(cookieOf(response, 'co_session')).toBeUndefined()
    }
    // Someone else's code with their own state in the address: the cookie decides.
    const theirs = await callback({ code, state: 'y'.repeat(43), cookie: `co_hub_state=${state}` })
    expect(theirs.headers.location).toBe('/login?from=%2Flora%2Flibrary&hub=failed')
    expect(hub.redeemed).toBe(before)
  })

  it('links the hub’s owner to the configured owner and opens a session of its own', async () => {
    const session = await signInThroughHub()
    const answer = await me(session)
    expect(answer.statusCode).toBe(200)
    expect(answer.json().person.login).toBe(OWNER.login)
    const { rows } = await server.db.execute<{ hub_user_id: string; hub_login: string }>(sql`
      SELECT hub_user_id::text, hub_login FROM principals WHERE login = ${OWNER.login}`)
    expect(rows[0]).toEqual({ hub_user_id: '7', hub_login: 'boss' })
    const { rows: journal } = await server.db.execute<{ action: string; result: string }>(sql`
      SELECT action, result FROM action_log
       WHERE action IN ('auth.hubLink', 'auth.hubSignIn') ORDER BY id`)
    expect(journal.slice(0, 2)).toEqual([
      { action: 'auth.hubLink', result: 'ok' },
      { action: 'auth.hubSignIn', result: 'ok' },
    ])
  })

  it('never takes a code twice: the replay is refused before the hub is asked', async () => {
    const state = await start()
    const code = hub.mint(OWNER_AT_HUB)
    const first = await callback({ code, state, cookie: `co_hub_state=${state}` })
    expect(cookieOf(first, 'co_session')).toMatch(/^hub\./)
    expect(cookieOf(first, 'co_hub_state')).toBe('')
    const redeemed = hub.redeemed
    // The same address again, even with the state cookie kept.
    const replay = await callback({ code, state, cookie: `co_hub_state=${state}` })
    expect(replay.headers.location).toBe('/login?from=%2Flora%2Flibrary&hub=failed')
    expect(cookieOf(replay, 'co_session')).toBeUndefined()
    // The same code with a fresh state of this browser.
    const fresh = await start()
    const again = await callback({ code, state: fresh, cookie: `co_hub_state=${fresh}` })
    expect(again.headers.location).toBe('/login?from=%2Flora%2Flibrary&hub=failed')
    expect(cookieOf(again, 'co_session')).toBeUndefined()
    expect(hub.redeemed).toBe(redeemed)
  })

  it('a code the hub has already spent opens nothing', async () => {
    const state = await start()
    const response = await callback({
      code: randomBytes(32).toString('base64url'),
      state,
      cookie: `co_hub_state=${state}`,
    })
    expect(response.headers.location).toBe('/login?from=%2Flora%2Flibrary&hub=failed')
    expect(cookieOf(response, 'co_session')).toBeUndefined()
  })

  it('a hub person without a linked principal gets «нет доступа» and no session', async () => {
    const before = await sessionCount()
    for (const [user, owner] of [
      [{ id: 41, username: 'someone', role: 'chatter' }, false],
      // Another owner at the hub: the configured owner is linked to someone else already.
      [{ id: 8, username: 'second-owner', role: 'owner' }, true],
    ] as const) {
      const state = await start()
      const response = await callback({
        code: hub.mint(user, owner),
        state,
        cookie: `co_hub_state=${state}`,
      })
      expect(response.statusCode).toBe(302)
      expect(response.headers.location).toBe('/login?from=%2Flora%2Flibrary&hub=no_access')
      expect(cookieOf(response, 'co_session')).toBeUndefined()
    }
    expect(await sessionCount()).toBe(before)
    const { rows } = await server.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM principals WHERE hub_user_id IN (41, 8)`)
    expect(rows[0]?.n).toBe(0)
  })
})

describe('a session opened through the hub', () => {
  it('asks the hub at most once a minute and ends when the person is gone there', async () => {
    const session = await signInThroughHub()
    clock += HUB_CHECK_EVERY_MS + 1
    expect((await me(session)).statusCode).toBe(200)
    const checks = hub.checks
    expect((await me(session)).statusCode).toBe(200)
    expect(hub.checks).toBe(checks)

    hub.signOutAll()
    // Within the minute the last answer stands.
    expect((await me(session)).statusCode).toBe(200)
    clock += HUB_CHECK_EVERY_MS + 1
    expect((await me(session)).statusCode).toBe(401)
    const { rows } = await server.db.execute<{ revoked: boolean }>(sql`
      SELECT revoked_at IS NOT NULL AS revoked FROM sessions
       WHERE hub_grant IS NOT NULL ORDER BY created_at DESC LIMIT 1`)
    expect(rows[0]?.revoked).toBe(true)
    const { rows: journal } = await server.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM action_log WHERE action = 'auth.hubSessionEnded'`)
    expect(journal[0]?.n).toBeGreaterThan(0)
    expect((await me(session)).statusCode).toBe(401)
  })

  it('ends at once when the hub refuses the re-check (401, 403, 404): only silence keeps the grace', async () => {
    for (const refusing of [
      { kind: 'auth_rejected', status: 401 },
      { kind: 'auth_rejected', status: 403 },
      { kind: 'refused', status: 404 },
    ] as const) {
      const session = await signInThroughHub()
      hub.refusing = refusing
      clock += HUB_CHECK_EVERY_MS + 1
      expect((await me(session)).statusCode, String(refusing.status)).toBe(401)
      // Ended, not refused for a while: the hub answering again does not bring it back.
      hub.refusing = null
      clock += HUB_CHECK_EVERY_MS + 1
      expect((await me(session)).statusCode, String(refusing.status)).toBe(401)
      const { rows } = await server.db.execute<{ revoked: boolean }>(sql`
        SELECT revoked_at IS NOT NULL AS revoked FROM sessions
         WHERE hub_grant IS NOT NULL ORDER BY created_at DESC LIMIT 1`)
      expect(rows[0]?.revoked, String(refusing.status)).toBe(true)
    }
  })

  it('outlives a silent hub for a bounded time, then ends until the hub answers', async () => {
    const session = await signInThroughHub()
    hub.unreachable = true
    clock += HUB_CHECK_EVERY_MS + 1
    expect((await me(session)).statusCode).toBe(200)
    clock += HUB_SILENCE_MS
    expect((await me(session)).statusCode).toBe(401)
    hub.unreachable = false
    clock += HUB_CHECK_EVERY_MS + 1
    expect((await me(session)).statusCode).toBe(200)
  })
})

describe('what stays as it was', () => {
  it('the password sign-in gives the same cookie and never asks the hub', async () => {
    const checks = hub.checks
    const response = await call(server.app, {
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      body: { login: OWNER.login, password: OWNER.password },
    })
    expect(response.statusCode).toBe(200)
    expect(String(response.headers['set-cookie'])).toMatch(
      /^co_session=[\w-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/,
    )
    const session = await signIn(server.app, OWNER.login, OWNER.password)
    clock += HUB_CHECK_EVERY_MS + 1
    expect((await me(session)).statusCode).toBe(200)
    expect(hub.checks).toBe(checks)
  })

  it('an agent’s token works without the hub', async () => {
    const owner = await signIn(server.app, OWNER.login, OWNER.password)
    const { rows } = await server.db.execute<{ id: string }>(sql`
      INSERT INTO principals (kind, login, display_name, role)
      VALUES ('agent', 'agent-hub-test', 'Проверка', 'manager') RETURNING id`)
    const agentId = rows[0]?.id ?? ''
    const issued = await call(server.app, {
      method: 'POST',
      url: `/api/v1/admin/agents/${agentId}/tokens`,
      as: owner,
      key: newKey(),
      body: { agent_id: agentId, expires_in_days: 30 },
    })
    expect(issued.statusCode).toBe(201)
    const { secret } = IssuedTokenSchema.parse(issued.json())
    const on = await call(server.app, {
      method: 'PATCH',
      url: '/api/v1/admin/integrations/agents',
      as: owner,
      key: newKey(),
      body: { switches: { enabled: true } },
    })
    expect(on.statusCode).toBe(200)
    const checks = hub.checks
    const models = await call(server.app, {
      method: 'GET',
      url: '/api/v1/admin/models',
      as: `Bearer ${secret}`,
    })
    expect(models.statusCode).toBe(200)
    expect(hub.checks).toBe(checks)
  })
})

/** All `Set-Cookie` lines of an answer. */
function setCookies(response: LightMyRequestResponse): string[] {
  const header = response.headers['set-cookie']
  return Array.isArray(header) ? header : header ? [header] : []
}

describe('the silent try (a page that got 401 before the sign-in screen)', () => {
  const silentStart = (cookie?: string, host = PUBLIC) =>
    get('/auth/hub/start?silent=1&next=%2Flora%2Flibrary', {
      host,
      ...(cookie === undefined ? {} : { cookie }),
    })

  it('goes to the hub once, silently; with nobody there, the sign-in screen', async () => {
    const { redeemed, probes } = hub
    const first = await silentStart()
    expect(first.statusCode).toBe(302)
    const location = new URL(String(first.headers.location))
    expect(location.origin).toBe('https://hub.example.test')
    expect(location.searchParams.get('silent')).toBe('1')
    expect(location.searchParams.get('next')).toBe('/lora/library')
    const state = cookieOf(first, 'co_hub_state')
    expect(location.searchParams.get('state')).toBe(state)
    // Marked before the browser leaves, readable by the page.
    expect(setCookies(first)).toContain('co_hub_try=1; Path=/; Max-Age=600; SameSite=Lax')
    expect(hub.probes).toBe(probes + 1)
    const back = await get(
      `/auth/hub/callback?${new URLSearchParams({ error: 'none', state: state ?? '', next: '/lora/library' })}`,
      { cookie: `co_hub_state=${state}; co_hub_try=1` },
    )
    expect(back.statusCode).toBe(302)
    expect(back.headers.location).toBe('/login?from=%2Flora%2Flibrary')
    expect(cookieOf(back, 'co_session')).toBeUndefined()
    expect(cookieOf(back, 'co_hub_state')).toBe('')
    expect(hub.redeemed).toBe(redeemed)
  })

  it('signs the person in on the page asked when the hub has a session', async () => {
    const first = await silentStart()
    const state = cookieOf(first, 'co_hub_state') ?? ''
    const back = await callback({
      code: hub.mint(OWNER_AT_HUB),
      state,
      cookie: `co_hub_state=${state}`,
    })
    expect(back.headers.location).toBe('/lora/library')
    const session = cookieOf(back, 'co_session') ?? ''
    expect((await me(session)).statusCode).toBe(200)
  })

  it('is not made twice in ten minutes, after «Выйти», off the public name or to a silent hub', async () => {
    const probes = hub.probes
    for (const cookie of ['co_hub_try=1', 'co_hub_out=1']) {
      const again = await silentStart(cookie)
      expect(again.headers.location).toBe('/login?from=%2Flora%2Flibrary')
      expect(cookieOf(again, 'co_hub_state')).toBeUndefined()
    }
    const tailnet = await silentStart(undefined, TAILNET)
    expect(tailnet.headers.location).toBe('/login?from=%2Flora%2Flibrary')
    expect(hub.probes).toBe(probes)

    hub.unreachable = true
    const down = await silentStart()
    expect(down.headers.location).toBe('/login?from=%2Flora%2Flibrary')
    expect(cookieOf(down, 'co_hub_state')).toBeUndefined()
    expect(setCookies(down)).toEqual(['co_hub_try=1; Path=/; Max-Age=600; SameSite=Lax'])
  })

  it('«Выйти» ends this browser’s session and leaves the mark until «Войти через хаб»', async () => {
    const session = await signInThroughHub()
    const out = await call(server.app, {
      method: 'POST',
      url: '/api/v1/auth/sign-out',
      as: session,
    })
    expect(out.statusCode).toBe(200)
    expect(setCookies(out)).toEqual([
      'co_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      // Until the browser session ends: no lifetime of its own.
      'co_hub_out=1; Path=/; SameSite=Lax',
    ])
    expect((await me(session)).statusCode).toBe(401)
    const { rows } = await server.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM action_log WHERE action = 'auth.signOut'`)
    expect(rows[0]?.n).toBeGreaterThan(0)
    // Without a session it answers the same: the mark is what matters.
    const again = await call(server.app, { method: 'POST', url: '/api/v1/auth/sign-out' })
    expect(again.statusCode).toBe(200)
    expect(setCookies(again)).toContain('co_hub_out=1; Path=/; SameSite=Lax')
    // Pressing «Войти через хаб» takes the mark away.
    const pressed = await get('/auth/hub/start?next=%2F', { cookie: 'co_hub_out=1' })
    expect(setCookies(pressed)).toContain('co_hub_out=; Path=/; Max-Age=0; SameSite=Lax')
  })
})
