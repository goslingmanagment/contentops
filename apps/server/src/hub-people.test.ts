import { randomBytes } from 'node:crypto'
import {
  HubError,
  type HubPerson,
  type HubRedeemed,
  type HubSignedIn,
  type HubSignin,
  type HubSigninUser,
  type HubWaitingMatter,
} from '@contentops/hub'
import { sql } from 'drizzle-orm'
import type { LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HUB_CHECK_EVERY_MS } from './auth/hub-signin'
import { call, OWNER, type TestServer, testServer } from './testing/server'

/**
 * People come from Hub (products plan §4.1): a content manager and a person who leads customs are made
 * from Hub's answer, follow it at every re-check and are closed when Hub closes them; anyone Hub does
 * not name gets nothing; Hub's test model is another model here by one setting.
 */

const PUBLIC = 'contentops.example.test'

/** Hub's half, with the registry's person behind each login. */
class FakeHub implements HubSignin {
  readonly people = new Map<number, HubPerson | null>()
  readonly waits = new Map<number, HubWaitingMatter[]>()
  private readonly live = new Map<string, HubSigninUser>()
  private readonly codes = new Map<string, HubRedeemed>()

  mint(user: HubSigninUser): string {
    const code = randomBytes(32).toString('base64url')
    const grant = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + 86_400_000)
    this.codes.set(code, { user, owner: user.role === 'owner', expiresAt, grant })
    this.live.set(grant, user)
    return code
  }

  startUrl({ state, next }: { state: string; next: string }): string {
    return `https://hub.example.test/api/v1/auth/sso?${new URLSearchParams({ to: 'contentops', state, next })}`
  }

  async answers() {
    return true
  }

  async redeem(code: string): Promise<HubRedeemed> {
    const found = this.codes.get(code)
    this.codes.delete(code)
    if (!found)
      throw new HubError('refused', 'HTTP 409', { endpoint: 'signin.redeem', status: 409 })
    return { ...found, person: this.people.get(found.user.id) ?? null }
  }

  async check(grant: string) {
    const user = this.live.get(grant)
    if (!user) return { active: false as const }
    return {
      active: true as const,
      user,
      owner: user.role === 'owner',
      expiresAt: new Date(Date.now() + 86_400_000),
      person: this.people.get(user.id) ?? null,
    }
  }

  async waiting(grant: string) {
    const user = this.live.get(grant)
    return user ? (this.waits.get(user.id) ?? []) : null
  }
  async signIn(): Promise<HubSignedIn> {
    return { kind: 'refused', reason: 'wrong', message: null }
  }

  async setPasswordByLink(): Promise<HubSignedIn> {
    return { kind: 'refused', reason: 'link_unknown', message: null }
  }

  async changePassword(): Promise<HubSignedIn> {
    return { kind: 'refused', reason: 'wrong', message: null }
  }

  async signOut() {
    return false
  }
}

const hub = new FakeHub()
let server: TestServer
let clock = Date.now()

beforeAll(async () => {
  server = await testServer({
    hubSignin: {
      hub,
      origin: `https://${PUBLIC}`,
      ownerLogin: OWNER.login,
      modelMap: { test: 'ari' },
      now: () => clock,
    },
  })
})
afterAll(() => server.close())

function person(code: string, overrides: Partial<HubPerson> = {}): HubPerson {
  return {
    code,
    displayName: 'Кира',
    role: 'content_manager',
    state: 'working',
    models: ['lora'],
    customsModels: [],
    products: ['contentops'],
    ...overrides,
  }
}

function cookieOf(response: LightMyRequestResponse, name: string): string | undefined {
  const header = response.headers['set-cookie']
  for (const line of Array.isArray(header) ? header : header ? [header] : []) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(line)
    if (match) return match[1]
  }
  return undefined
}

/** Start, Hub, callback: the session cookie, or the address the browser was sent to without one. */
async function throughHub(user: HubSigninUser): Promise<{ session?: string; location: string }> {
  const start = await server.app.inject({
    method: 'GET',
    url: '/auth/hub/start?next=%2F',
    headers: { host: PUBLIC },
  })
  const state = cookieOf(start, 'co_hub_state') ?? ''
  const back = await server.app.inject({
    method: 'GET',
    url: `/auth/hub/callback?${new URLSearchParams({ code: hub.mint(user), state, next: '/' })}`,
    headers: { host: PUBLIC, cookie: `co_hub_state=${state}` },
  })
  expect(back.statusCode).toBe(302)
  const session = cookieOf(back, 'co_session')
  return { ...(session ? { session } : {}), location: String(back.headers.location) }
}

const me = (session: string) =>
  call(server.app, { method: 'GET', url: '/api/v1/admin/me', as: session })

describe('a person from Hub', () => {
  it('a content manager: «Контент-менеджер» on the models of their working pages, marked «из Hub»', async () => {
    hub.people.set(101, person('kira'))
    const { session } = await throughHub({ id: 101, username: 'kira', role: 'content_manager' })
    const answer = (await me(session ?? '')).json()
    expect(answer.person).toMatchObject({
      login: 'kira',
      role: 'manager',
      models: ['lora'],
      hub_code: 'kira',
    })
    expect(answer.models).toEqual(['lora'])
    expect(answer.first_day).toBe(true)
    // What Hub owns is not edited here.
    const changed = await call(server.app, {
      method: 'PATCH',
      url: `/api/v1/admin/people/${answer.person.id}`,
      as: await ownerSession(),
      key: `k-${Date.now()}`,
      ifMatch: answer.person.version,
      body: { models: ['lora', 'ari'] },
    })
    expect(changed.statusCode).toBe(403)
  })

  it('follows Hub at the re-check: new models, then closed when Hub closes the person', async () => {
    hub.people.set(102, person('mila', { displayName: 'Мила' }))
    const { session = '' } = await throughHub({
      id: 102,
      username: 'mila',
      role: 'content_manager',
    })
    hub.people.set(102, person('mila', { displayName: 'Мила', models: ['lora', 'ari'] }))
    clock += HUB_CHECK_EVERY_MS + 1
    expect((await me(session)).json().models.sort()).toEqual(['ari', 'lora'])
    hub.people.set(102, person('mila', { displayName: 'Мила', state: 'left' }))
    clock += HUB_CHECK_EVERY_MS + 1
    expect((await me(session)).statusCode).toBe(401)
    const { rows } = await server.db.execute<{ closed: boolean }>(
      sql`SELECT disabled_at IS NOT NULL AS closed FROM principals WHERE hub_person_code = 'mila'`,
    )
    expect(rows[0]?.closed).toBe(true)
    // And the next sign-in through Hub finds no access.
    expect(
      (await throughHub({ id: 102, username: 'mila', role: 'content_manager' })).location,
    ).toContain('hub=no_access')
  })

  it('a person who leads customs: «Только кастомы», the orders and «Ждут вас», nothing else', async () => {
    hub.people.set(
      103,
      person('vera', {
        role: 'chatter',
        models: ['lora'],
        customsModels: ['lora'],
        products: ['workboard', 'contentops'],
      }),
    )
    const { session = '' } = await throughHub({ id: 103, username: 'vera', role: 'chatter' })
    expect((await me(session)).json().person).toMatchObject({ role: 'customs', models: ['lora'] })
    const get = (url: string) => call(server.app, { method: 'GET', url, as: session })
    expect((await get('/api/v1/lora/waiting')).statusCode).toBe(200)
    expect((await get('/api/v1/lora/plan?date=2026-11-15')).statusCode).toBe(403)
    expect((await get('/api/v1/lora/inbox')).statusCode).toBe(403)
    expect((await get('/api/v1/admin/people')).statusCode).toBe(403)
  })

  it('anyone Hub does not name gets nothing: a chatter, a login nobody holds', async () => {
    hub.people.set(104, person('ivan', { role: 'chatter', models: ['lora'] }))
    expect((await throughHub({ id: 104, username: 'ivan', role: 'chatter' })).location).toContain(
      'hub=no_access',
    )
    hub.people.set(105, null)
    expect((await throughHub({ id: 105, username: 'nobody', role: 'chatter' })).location).toContain(
      'hub=no_access',
    )
  })

  it("Hub's test model is another model here: a test person never sees a real one", async () => {
    hub.people.set(106, person('t-km', { displayName: 'Тест: КМ', models: ['test'] }))
    const { session = '' } = await throughHub({
      id: 106,
      username: 't-km',
      role: 'content_manager',
    })
    expect((await me(session)).json().models).toEqual(['ari'])
  })

  it('reads what waits in Hub for the person, through their own sign-in', async () => {
    hub.people.set(107, person('lena', { displayName: 'Лена' }))
    hub.waits.set(107, [
      {
        id: 1,
        kind: 'content.week_approve',
        title: 'Неделя ждёт утверждения',
        link: '/matters',
        pageLabels: [],
        openedAt: new Date(),
      },
    ])
    const { session = '' } = await throughHub({
      id: 107,
      username: 'lena',
      role: 'content_manager',
    })
    const waiting = (
      await call(server.app, { method: 'GET', url: '/api/v1/lora/waiting', as: session })
    ).json()
    expect(waiting.hub).toBe('ok')
    expect(waiting.matters.map((matter: { title: string }) => matter.title)).toEqual([
      'Неделя ждёт утверждения',
    ])
  })
  it('a person of the registry: «Отозвать доступ» is not here, the registry decides', async () => {
    hub.people.set(108, person('olga', { displayName: 'Ольга' }))
    await throughHub({ id: 108, username: 'olga', role: 'content_manager' })
    const { rows } = await server.db.execute<{ id: string }>(
      sql`SELECT id FROM principals WHERE hub_person_code = 'olga'`,
    )
    const revoked = await call(server.app, {
      method: 'POST',
      url: `/api/v1/admin/people/${rows[0]?.id}:revoke-access`,
      as: await ownerSession(),
      key: `k-revoke-${Date.now()}`,
    })
    expect(revoked.statusCode).toBe(403)
    expect(revoked.json().message).toMatch(/реестр людей/)
  })

  it('a hand-made person linked to the registry: the old password is no way in, its sessions end', async () => {
    const added = await call(server.app, {
      method: 'POST',
      url: '/api/v1/admin/people',
      as: await ownerSession(),
      key: `k-add-${Date.now()}`,
      body: { name: 'Надя', login: 'nadia', role: 'manager', models: ['lora'] },
    })
    expect(added.statusCode, added.body).toBe(201)
    const password = added.json().temporary_password as string
    const local = await call(server.app, {
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      body: { login: 'nadia', password },
    })
    expect(local.statusCode).toBe(200)
    const localSession = /co_session=([^;]+)/.exec(String(local.headers['set-cookie']))?.[1] ?? ''
    // The owner invites her through the registry; her first sign-in through Hub links her by code.
    hub.people.set(109, person('nadia', { displayName: 'Надя' }))
    const { session } = await throughHub({ id: 109, username: 'nadia', role: 'content_manager' })
    expect(session).toBeTruthy()
    expect((await me(localSession)).statusCode).toBe(401)
    const again = await call(server.app, {
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      body: { login: 'nadia', password },
    })
    expect(again.statusCode).toBe(401)
  })

  it('«Ждут вас» cuts by Hub’s model, not by the pages bound here', async () => {
    hub.people.set(110, person('t-km2', { displayName: 'Тест: КМ', models: ['test'] }))
    hub.waits.set(110, [
      {
        id: 2,
        kind: 'content.week_approve',
        title: 'Неделя тестовой страницы',
        link: '/matters',
        pageLabels: ['test-1'],
        models: ['test'],
        openedAt: new Date(),
      },
    ])
    const { session = '' } = await throughHub({
      id: 110,
      username: 't-km2',
      role: 'content_manager',
    })
    const waiting = (
      await call(server.app, { method: 'GET', url: '/api/v1/ari/waiting', as: session })
    ).json()
    expect(waiting.matters.map((matter: { title: string }) => matter.title)).toEqual([
      'Неделя тестовой страницы',
    ])
  })
})

let owner: string | null = null
async function ownerSession(): Promise<string> {
  if (owner) return owner
  const response = await call(server.app, {
    method: 'POST',
    url: '/api/v1/auth/sign-in',
    body: { login: OWNER.login, password: OWNER.password },
  })
  owner = /co_session=([^;]+)/.exec(String(response.headers['set-cookie']))?.[1] ?? ''
  return owner
}
