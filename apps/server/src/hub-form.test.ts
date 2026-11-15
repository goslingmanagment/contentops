import { randomBytes } from 'node:crypto'
import {
  HubError,
  type HubPerson,
  type HubRedeemed,
  type HubSignedIn,
  type HubSignin,
} from '@contentops/hub'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { call, OWNER, type TestServer, testServer } from './testing/server'

/**
 * ContentOps' own entrance (package C4): the form asks Hub first (one registry, one account), then ContentOps' own
 * accounts; Hub's refusals are words; Hub not answering leaves own accounts working; the invitation ends here;
 * «Выйти» and «Сменить пароль» go to Hub for a session over its grant.
 */

const PUBLIC = 'contentops.example.test'
const person = (code: string): HubPerson => ({
  code,
  displayName: 'Кира',
  role: 'content_manager',
  state: 'working',
  models: ['lora'],
  customsModels: [],
  products: ['contentops'],
})

class FakeHub implements HubSignin {
  answer: HubSignedIn | 'down' = 'down'
  signedOut: string[] = []
  changed: string[] = []
  private readonly live = new Set<string>()

  signedIn(code: string): HubSignedIn {
    const grant = randomBytes(32).toString('base64url')
    this.live.add(grant)
    const redeemed: HubRedeemed = {
      user: { id: code === 'kira' ? 901 : 902, username: code, role: 'content_manager' },
      owner: false,
      expiresAt: new Date(Date.now() + 86_400_000),
      grant,
      person: person(code),
    }
    return { kind: 'signed_in', redeemed }
  }

  startUrl() {
    return 'https://hub.example.test/api/v1/auth/sso'
  }
  async answers() {
    return true
  }
  async redeem(): Promise<HubRedeemed> {
    throw new HubError('refused', 'HTTP 409', { endpoint: 'signin.redeem', status: 409 })
  }
  async check(grant: string) {
    if (!this.live.has(grant)) return { active: false as const }
    return {
      active: true as const,
      user: { id: 901, username: 'kira', role: 'content_manager' },
      owner: false,
      expiresAt: new Date(Date.now() + 86_400_000),
      person: person('kira'),
    }
  }
  async waiting() {
    return []
  }
  private next(): Promise<HubSignedIn> {
    if (this.answer === 'down') {
      return Promise.reject(
        new HubError('transient', 'network: down', { endpoint: 'signin.password' }),
      )
    }
    return Promise.resolve(this.answer)
  }
  signIn() {
    return this.next()
  }
  setPasswordByLink() {
    return this.next()
  }
  async changePassword({ grant }: { grant: string }): Promise<HubSignedIn> {
    this.changed.push(grant)
    this.live.delete(grant)
    return this.signedIn('kira')
  }
  async signOut(grant: string) {
    this.signedOut.push(grant)
    return this.live.delete(grant)
  }
}

const hub = new FakeHub()
let server: TestServer

beforeAll(async () => {
  server = await testServer({
    hubSignin: { hub, origin: `https://${PUBLIC}`, ownerLogin: OWNER.login },
  })
})
afterAll(() => server.close())
beforeEach(() => {
  hub.answer = 'down'
})

function signIn(login: string, password: string, address = '203.0.113.9') {
  return server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/sign-in',
    headers: { host: PUBLIC, 'x-forwarded-for': address },
    payload: { login, password },
  })
}

function sessionOf(response: { headers: Record<string, unknown> }): string {
  return /co_session=([^;]+)/.exec(String(response.headers['set-cookie']))?.[1] ?? ''
}

describe('the form on ContentOps’ page', () => {
  it('signs a person of Hub in through Hub: ContentOps’ person made, no password kept here', async () => {
    hub.answer = hub.signedIn('kira')
    const response = await signIn('kira', 'her-password-in-hub')
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().person).toMatchObject({
      login: 'kira',
      role: 'manager',
      hub_code: 'kira',
    })
    const { rows } = await server.db.execute<{ password_hash: string | null }>(
      sql`SELECT password_hash FROM principals WHERE login = 'kira'`,
    )
    expect(rows[0]?.password_hash ?? null).toBeNull()
  })

  it('falls back to ContentOps’ own account on Hub’s «не подходят», and when Hub is down', async () => {
    hub.answer = { kind: 'refused', reason: 'wrong', message: null }
    expect((await signIn(OWNER.login, OWNER.password)).statusCode).toBe(200)
    hub.answer = 'down'
    expect((await signIn(OWNER.login, OWNER.password)).statusCode).toBe(200)
    // Hub down and no own account: the words say Hub, not «не подходят».
    const silent = await signIn('somebody', 'whatever-password')
    expect(silent.statusCode).toBe(503)
    expect(silent.json().message).toMatch(/^Вход сейчас недоступен/)
  })

  it('says each refusal of Hub in words: the owner, no access, locked', async () => {
    hub.answer = { kind: 'refused', reason: 'owner', message: null }
    const owner = await signIn('admin', 'x')
    expect(owner.statusCode).toBe(403)
    expect(owner.json()).toMatchObject({
      message: 'Владелец входит через Hub',
      details: { reason: 'owner' },
    })
    hub.answer = { kind: 'refused', reason: 'no_access', message: null }
    expect((await signIn('ivan', 'x')).json().message).toBe(
      'У вас нет доступа к ContentOps. Попросите владельца',
    )
    hub.answer = { kind: 'refused', reason: 'locked', message: null }
    expect((await signIn('ivan', 'x')).statusCode).toBe(429)
  })

  it('ends an invitation here: the password set in Hub, the person signed in', async () => {
    hub.answer = hub.signedIn('mila')
    const joined = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/join',
      headers: { host: PUBLIC },
      payload: { token: 'the-secret-of-the-link', password: 'a-strong-password-here' },
    })
    expect(joined.statusCode, joined.body).toBe(200)
    expect(joined.json().person).toMatchObject({ login: 'mila', role: 'manager' })
    hub.answer = { kind: 'refused', reason: 'link_used', message: null }
    const used = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/join',
      headers: { host: PUBLIC },
      payload: { token: 'the-secret-of-the-link', password: 'a-strong-password-here' },
    })
    expect(used.json().message).toMatch(/уже использована/)
  })

  it('changes the password in Hub and keeps this session; «Выйти» ends the session in Hub too', async () => {
    const signedIn = hub.signedIn('kira')
    hub.answer = signedIn
    const session = sessionOf(await signIn('kira', 'her-password-in-hub'))
    const changed = await call(server.app, {
      method: 'POST',
      url: '/api/v1/admin/me/password',
      as: session,
      key: `k-${Date.now()}`,
      body: { current: 'her-password-in-hub', next: 'her-new-password-in-hub' },
    })
    expect(changed.statusCode, changed.body).toBe(200)
    expect(hub.changed).toHaveLength(1)
    expect(
      (await call(server.app, { method: 'GET', url: '/api/v1/admin/me', as: session })).statusCode,
    ).toBe(200)
    await call(server.app, { method: 'POST', url: '/api/v1/auth/sign-out', as: session })
    expect(hub.signedOut).toHaveLength(1)
    expect(
      (await call(server.app, { method: 'GET', url: '/api/v1/admin/me', as: session })).statusCode,
    ).toBe(401)
  })
})
