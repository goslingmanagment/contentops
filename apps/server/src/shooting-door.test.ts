import { randomBytes } from 'node:crypto'
import { HubOrderListSchema, HubOrderSchema } from '@contentops/contracts/domain/hub-orders'
import {
  type HubCheck,
  type HubCustomOrder,
  HubError,
  type HubRedeemed,
  type HubSignedIn,
  type HubSignin,
  type HubSigninUser,
  type PersonDoor,
  type PersonShootingStep,
} from '@contentops/hub'
import type { LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setHubPage } from './hub/testing'
import { call, newKey, OWNER, signIn, type TestServer, testServer } from './testing/server'

/**
 * «Съёмка» AS THE SIGNED-IN PERSON (products plan §2.4, §4.5, package C3): a person signed in over
 * Hub's grant reads their own orders through Hub's person's door — fresh, of their realm, even what
 * ContentOps' background read (its agent key) does not have — and writes a step through it with
 * that grant; Hub decides whose the step is. An own account with no grant reads the last background
 * read and is told why it has no steps. Hub, its sign-in and its door are fakes; every name is made up.
 */

const PUBLIC = 'contentops.example.test'

function order(id: number, fields: Partial<HubCustomOrder> = {}): HubCustomOrder {
  const now = new Date().toISOString()
  return {
    id,
    code: `K-${id}`,
    pageLabel: 'lora-1',
    platform: 'fansly',
    model: 'Лора',
    modelSlug: 'lora',
    fan: { username: `fan_${id}`, displayName: null },
    buyer: null,
    card: { task: `заказ ${id}`, wantsVideo: true },
    what: `заказ ${id}`,
    deadlineOn: null,
    state: 'checked',
    stateWord: 'Проверен',
    leader: { name: 'Кира', phase: 'shoot', product: 'contentops' },
    stateAt: now,
    stateNote: null,
    stateRef: null,
    telegramRefs: [],
    contentopsRef: null,
    overdueDays: null,
    partsDone: [],
    openRevisions: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
    cardText: `📦 Описание заказа K-${id}`,
    sourceText: null,
    messages: [],
    ...fields,
  }
}

/** Hub: the sign-in of the people, and their door — each grant reads its own orders. */
class FakeHub implements HubSignin, PersonDoor {
  private readonly live = new Map<string, HubSigninUser>()
  private readonly codes = new Map<string, HubRedeemed>()
  /** The orders each login reads through the door (its scope and realm, as Hub cuts them). */
  readonly ordersOf = new Map<string, HubCustomOrder[]>()
  /** Who leads which order's shooting: the only login Hub lets take a step of it. */
  readonly leaderOf = new Map<string, string>()
  readonly steps: { login: string; body: PersonShootingStep }[] = []
  /** Hub's models of a login's person (its slugs): Лора unless said otherwise. */
  readonly modelsOf = new Map<string, string[]>()
  away = false

  // The door's other rows («Публикации», package C2): not this test's.
  publicationList(): never {
    throw new Error('not this test')
  }
  publicationGet(): never {
    throw new Error('not this test')
  }
  publicationSettings(): never {
    throw new Error('not this test')
  }
  publicationQueues(): never {
    throw new Error('not this test')
  }
  publicationApprove(): never {
    throw new Error('not this test')
  }
  publicationCancel(): never {
    throw new Error('not this test')
  }
  publicationWithdraw(): never {
    throw new Error('not this test')
  }
  publicationReplace(): never {
    throw new Error('not this test')
  }
  publicationResolve(): never {
    throw new Error('not this test')
  }
  publicationQueueRefresh(): never {
    throw new Error('not this test')
  }
  publicationSettingsUpdate(): never {
    throw new Error('not this test')
  }
  publicationDeletePost(): never {
    throw new Error('not this test')
  }
  publicationWithdrawPage(): never {
    throw new Error('not this test')
  }
  publicationSwitches(): never {
    throw new Error('not this test')
  }
  publicationSwitchSet(): never {
    throw new Error('not this test')
  }
  publicationTargets(): never {
    throw new Error('not this test')
  }
  fanslyLoginPages(): never {
    throw new Error('not this test')
  }
  statsContent(): never {
    throw new Error('not this test')
  }
  statsMedia(): never {
    throw new Error('not this test')
  }
  contentComments(): never {
    throw new Error('not this test')
  }

  mint(user: HubSigninUser): string {
    const code = randomBytes(32).toString('base64url')
    const grant = randomBytes(32).toString('base64url')
    this.codes.set(code, {
      user,
      owner: user.role === 'owner',
      expiresAt: new Date(Date.now() + 86_400_000),
      grant,
    })
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
    if (!found)
      throw new HubError('refused', 'HTTP 409', { endpoint: 'signin.redeem', status: 409 })
    return {
      ...found,
      person: {
        code: found.user.username,
        displayName: found.user.username,
        role: found.user.role,
        state: 'working',
        models:
          found.user.role === 'content_manager'
            ? (this.modelsOf.get(found.user.username) ?? ['lora'])
            : [],
        customsModels: found.user.role === 'chatter' ? ['lora'] : [],
        products: ['contentops'],
      },
    }
  }
  async check(grant: string): Promise<HubCheck> {
    const user = this.live.get(grant)
    if (!user) return { active: false }
    return { active: true, user, owner: false, expiresAt: new Date(Date.now() + 86_400_000) }
  }
  async waiting() {
    return []
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

  private who(grant: string): HubSigninUser {
    const user = this.live.get(grant)
    if (!user) throw new HubError('refused', 'HTTP 401', { endpoint: 'person', status: 401 })
    if (this.away)
      throw new HubError('transient', 'network: connect ECONNREFUSED', { endpoint: 'person' })
    return user
  }
  async customOrders(grant: string) {
    const user = this.who(grant)
    return {
      orders: structuredClone(this.ordersOf.get(user.username) ?? []),
      serverNow: new Date().toISOString(),
    }
  }
  async customOrderStep(grant: string, body: PersonShootingStep) {
    const user = this.who(grant)
    this.steps.push({ login: user.username, body })
    const own = this.ordersOf.get(user.username) ?? []
    const found = own.find((one) => one.code === body.code)
    if (!found) throw new HubError('refused', 'HTTP 404', { endpoint: 'person', status: 404 })
    if (this.leaderOf.get(body.code) !== user.username) {
      throw new HubError('refused', 'HTTP 409 not_allowed', {
        endpoint: 'person',
        status: 409,
        code: 'not_allowed',
      })
    }
    Object.assign(found, {
      state: body.step,
      stateWord: null,
      deadlineOn: body.deadlineOn ?? found.deadlineOn,
    })
    return { order: structuredClone(found), outcome: 'changed' as const, event: null }
  }
}

const hub = new FakeHub()
let server: TestServer

function cookieOf(response: LightMyRequestResponse, name: string): string | undefined {
  const header = response.headers['set-cookie']
  for (const line of Array.isArray(header) ? header : header ? [header] : []) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(line)
    if (match) return match[1]
  }
  return undefined
}

/** Signed in through Hub: the session cookie of a person whose session holds Hub's grant. */
async function throughHub(user: HubSigninUser): Promise<string> {
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
  const session = cookieOf(back, 'co_session')
  if (!session) throw new Error(`no session: ${back.statusCode} ${String(back.headers.location)}`)
  return session
}

const list = async (as: string) => {
  const response = await call(server.app, { method: 'GET', url: '/api/v1/lora/hub-orders', as })
  expect(response.statusCode, response.body).toBe(200)
  return HubOrderListSchema.parse(response.json())
}
const step = (as: string, code: string, body: Record<string, unknown>) =>
  call(server.app, {
    method: 'POST',
    url: `/api/v1/lora/hub-orders/${code}/steps`,
    as,
    key: newKey(),
    body,
  })

beforeAll(async () => {
  server = await testServer({
    secrets: { hub: true, hubBaseUrl: 'https://hub.example' },
    // Hub's test model is ContentOps' `ari` here by one setting, as `test=smoke` on the VM.
    hubSignin: {
      hub,
      origin: `https://${PUBLIC}`,
      ownerLogin: OWNER.login,
      modelMap: { test: 'ari' },
    },
    personDoor: hub,
  })
  await setHubPage(server.db, 'lora-1', 'lora-1')
})
afterAll(() => server.close())

describe('«Съёмка» as the signed-in person', () => {
  it("reads the person's own orders through the door, fresh, which the background read does not have", async () => {
    hub.ordersOf.set('kira', [order(201), order(202, { pageLabel: 'zoe-1', modelSlug: 'zoe' })])
    const kira = await throughHub({ id: 501, username: 'kira', role: 'content_manager' })
    const read = await list(kira)
    // An order Hub names of another model is not this model's.
    expect(read.items.map((one) => one.code)).toEqual(['K-201'])
    expect(read.read_at).not.toBeNull()
    const card = HubOrderSchema.parse(
      (
        await call(server.app, { method: 'GET', url: '/api/v1/lora/hub-orders/K-201', as: kira })
      ).json(),
    )
    expect(card).toMatchObject({ steps: ['at_model'], steps_note: null })
  })

  it("a model whose Hub slug differs and whose accounts are bound to no Hub page: Hub's answer places the order", async () => {
    // `ari` here is Hub's `test` (HUB_MODEL_MAP); its accounts carry no hub_page_ref, as `smoke`'s on the VM.
    hub.modelsOf.set('tkm', ['test'])
    hub.ordersOf.set('tkm', [
      order(231, { pageLabel: 'test-1', modelSlug: 'test', state: 'at_model' }),
      order(232, { pageLabel: 'test-1', modelSlug: 'test', state: 'shot' }),
    ])
    hub.leaderOf.set('K-231', 'tkm')
    const tkm = await throughHub({ id: 503, username: 'tkm', role: 'content_manager' })
    const read = await call(server.app, { method: 'GET', url: '/api/v1/ari/hub-orders', as: tkm })
    expect(read.statusCode, read.body).toBe(200)
    expect(
      HubOrderListSchema.parse(read.json())
        .items.map((one) => one.code)
        .sort(),
    ).toEqual(['K-231', 'K-232'])
    const taken = await call(server.app, {
      method: 'POST',
      url: '/api/v1/ari/hub-orders/K-231/steps',
      as: tkm,
      key: newKey(),
      body: { step: 'shot' },
    })
    expect(taken.statusCode, taken.body).toBe(200)
    expect(HubOrderSchema.parse(taken.json())).toMatchObject({ code: 'K-231', state: 'shot' })
  })

  it('writes a step through the door with the grant; Hub refuses whoever does not lead it', async () => {
    hub.ordersOf.set('kira', [order(211), order(212)])
    hub.leaderOf.set('K-211', 'kira')
    hub.leaderOf.set('K-212', 'someone-else')
    const kira = await throughHub({ id: 501, username: 'kira', role: 'content_manager' })
    const taken = await step(kira, 'K-211', { step: 'at_model', deadline: '2030-01-10' })
    expect(taken.statusCode, taken.body).toBe(200)
    expect(HubOrderSchema.parse(taken.json())).toMatchObject({
      code: 'K-211',
      state: 'at_model',
      deadline: '2030-01-10',
    })
    expect(hub.steps.at(-1)).toEqual({
      login: 'kira',
      body: { code: 'K-211', step: 'at_model', deadlineOn: '2030-01-10' },
    })
    const refused = await step(kira, 'K-212', { step: 'at_model' })
    expect(refused.statusCode).toBe(403)
    expect(refused.json().message).toMatch(/^Шаг не принят: его ведёт другой человек/)
  })

  it('«Только кастомы» through Hub reads and moves the orders it leads, as itself', async () => {
    hub.ordersOf.set('nik', [order(221)])
    hub.leaderOf.set('K-221', 'nik')
    const nik = await throughHub({ id: 502, username: 'nik', role: 'chatter' })
    expect((await list(nik)).items.map((one) => one.code)).toEqual(['K-221'])
    const taken = await step(nik, 'K-221', { step: 'at_model' })
    expect(taken.statusCode, taken.body).toBe(200)
    expect(hub.steps.at(-1)?.login).toBe('nik')
  })

  it('an own account with no grant reads the last background read and is told why it has no steps', async () => {
    const owner = await signIn(server.app, OWNER.login, OWNER.password)
    const read = await list(owner)
    expect(read.items).toEqual([])
    const refused = await step(owner, 'K-211', { step: 'at_model' })
    expect(refused.statusCode).toBe(403)
    expect(refused.json().message).toBe(
      'Шаги доступны с учётной записью из реестра: попросите владельца',
    )
  })

  it('Hub away: the person reads the last background read, and a step is not written', async () => {
    const kira = await throughHub({ id: 501, username: 'kira', role: 'content_manager' })
    hub.away = true
    try {
      expect((await list(kira)).items).toEqual([])
      const away = await step(kira, 'K-211', { step: 'shot' })
      expect(away.statusCode).toBe(503)
      expect(away.json().message).toBe('Не удалось записать шаг, попробуйте ещё раз')
    } finally {
      hub.away = false
    }
  })
})
