import { randomBytes } from 'node:crypto'
import {
  PublicationCardSchema,
  PublicationsFeedSchema,
} from '@contentops/contracts/domain/publications-screen'
import { StatsMediaCardSchema, StatsScreenSchema } from '@contentops/contracts/domain/stats-screen'
import {
  type HubCheck,
  HubError,
  type HubPublication,
  type HubPublicationTargets,
  type HubRedeemed,
  type HubSignedIn,
  type HubSignin,
  type HubSigninUser,
  type PersonDoor,
  type PublicationListQuery,
} from '@contentops/hub'
import type { LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setHubPage } from './hub/testing'
import { call, OWNER, signIn, type TestServer, testServer } from './testing/server'

/**
 * «Публикации» AS THE SIGNED-IN PERSON (products plan §2.4, package C2): ContentOps reads Hub's publications only
 * through the person's door with the person's own grant — never with its own key — and shows the model's pages alone.
 * An own account (no grant) is told so in words and Hub is not asked; a refusal, an outage and a grant that is over
 * are each said. The screen asks Hub for the MODEL by Hub's slug (`HUB_MODEL_MAP` reversed), never through a page's
 * binding here: a model whose pages bind nothing and whose slug differs from its code (the test model) shows Hub's
 * pages and posts. Hub, its sign-in and its door are fakes; every name is made up.
 */

/** Hub's models of its pages. */
const MODEL_OF: Record<string, string> = { 'lora-1': 'lora', 'zoe-1': 'zoe', 'test-1': 'test' }
const ofModel = (pageLabel: string | null, modelSlug: string | undefined) =>
  modelSlug === undefined || MODEL_OF[pageLabel ?? ''] === modelSlug

const PUBLIC = 'contentops.example.test'

function publication(id: number, pageLabel: string, status = 'draft'): HubPublication {
  const now = new Date().toISOString()
  const raw = {
    id,
    pageLabel,
    platform: 'fansly',
    kind: 'subscriber_post',
    status,
    version: 1,
    text: `пост ${id}`,
    publishAt: now,
    expiresAt: null,
    priceMills: null,
    media: [
      {
        role: 'media',
        position: 0,
        source: 'vault',
        mediaRef: `m${id}`,
        fileId: null,
        attachment: 0,
        name: null,
      },
    ],
    findings: [],
    blocked: false,
    author: { kind: 'agent', userId: null, agentKeyId: 9 },
    platformPostRef: null,
    statusReason: null,
    withdrawal: null,
    deletion: null,
    updatedAt: now,
    statusChangedAt: now,
    events: [
      {
        fromStatus: null,
        toStatus: status,
        actorKind: 'agent',
        actorUserId: null,
        actorAgentKeyId: 9,
        reason: null,
        at: now,
      },
    ],
    revision: null,
  }
  return {
    id,
    pageLabel,
    platform: 'fansly',
    kind: 'subscriber_post',
    status,
    version: 1,
    publishAt: now,
    statusReason: null,
    platformPostRef: null,
    vaultAlbumRef: null,
    blocked: false,
    findings: [],
    updatedAt: now,
    statusChangedAt: now,
    raw,
  }
}

/** Hub: the sign-in of the people, and their door — each grant reads its own publications. */
class FakeHub implements HubSignin, PersonDoor {
  private readonly live = new Map<string, HubSigninUser>()
  private readonly codes = new Map<string, HubRedeemed>()
  readonly publicationsOf = new Map<string, HubPublication[]>()
  readonly grantsAsked: string[] = []
  refuse = false
  away = false

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
  endAll() {
    this.live.clear()
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
        models: found.user.username === 'tkm' ? ['test'] : ['lora'],
        customsModels: [],
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
    this.grantsAsked.push(grant)
    const user = this.live.get(grant)
    if (!user) throw new HubError('refused', 'HTTP 401', { endpoint: 'person', status: 401 })
    if (this.away)
      throw new HubError('transient', 'network: connect ECONNREFUSED', { endpoint: 'person' })
    if (this.refuse) throw new HubError('refused', 'HTTP 403', { endpoint: 'person', status: 403 })
    return user
  }
  async customOrders(): Promise<never> {
    throw new Error('not this test')
  }
  async customOrderStep(): Promise<never> {
    throw new Error('not this test')
  }
  async publicationList(grant: string, query: PublicationListQuery) {
    const user = this.who(grant)
    return (this.publicationsOf.get(user.username) ?? []).filter(
      (one) =>
        (query.pageLabel === undefined || one.pageLabel === query.pageLabel) &&
        ofModel(one.pageLabel, query.modelSlug),
    )
  }
  async publicationGet(grant: string, id: number) {
    const user = this.who(grant)
    const found = (this.publicationsOf.get(user.username) ?? []).find((one) => one.id === id)
    if (!found) throw new HubError('refused', 'HTTP 404', { endpoint: 'person', status: 404 })
    return {
      publication: found,
      events: [],
      approvedAt: null,
      authorName: this.withNames ? 'Генгар' : null,
      approvedByName: this.withNames ? 'Диана' : null,
    }
  }
  /** The page's walls and tiers; null — a Hub without the row. */
  targets: HubPublicationTargets | null = null
  withNames = false
  async publicationTargets(grant: string) {
    this.who(grant)
    return this.targets
  }
  async publicationSettings(grant: string, modelSlug?: string) {
    const user = this.who(grant)
    const scope = user.username === 'tkm' ? ['test-1'] : ['lora-1', 'zoe-1']
    return {
      globalEnabled: true,
      pages: scope
        .filter((pageLabel) => ofModel(pageLabel, modelSlug))
        .map((pageLabel) => ({
          pageLabel,
          platform: 'fansly',
          enabled: true,
          autostopReason: null,
          paidPriceMinMills: 5000,
          paidPriceMaxMills: 40000,
          repostThresholdDays: 30,
          dailyLimit: null,
        })),
    }
  }
  async publicationQueues(grant: string) {
    this.who(grant)
    return []
  }
  readonly actions: string[] = []
  async publicationApprove(grant: string, items: { id: number; version: number }[]) {
    const user = this.who(grant)
    this.actions.push(`${user.username} approve ${items.map((one) => one.id).join(',')}`)
    return items.map((item) => {
      const found = (this.publicationsOf.get(user.username) ?? []).find((one) => one.id === item.id)
      if (!found)
        return {
          id: item.id,
          outcome: 'refused' as const,
          reason: 'not_found',
          approved: false,
          publication: null,
        }
      if (found.blocked) {
        return {
          id: item.id,
          outcome: 'refused' as const,
          reason: 'blocking_findings',
          approved: false,
          publication: found,
        }
      }
      found.status = 'approved'
      return {
        id: item.id,
        outcome: 'approved' as const,
        reason: null,
        approved: true,
        publication: found,
      }
    })
  }
  async publicationCancel(grant: string, id: number) {
    const user = this.who(grant)
    this.actions.push(`${user.username} cancel ${id}`)
    const found = (this.publicationsOf.get(user.username) ?? []).find((one) => one.id === id)
    if (!found) throw new HubError('refused', 'HTTP 404', { endpoint: 'person', status: 404 })
    if (found.status === 'scheduled') {
      throw new HubError('refused', 'HTTP 409 publication_handed_to_platform', {
        endpoint: 'person',
        status: 409,
      })
    }
    found.status = 'cancelled'
    return found
  }
  async publicationWithdraw(grant: string, id: number) {
    const user = this.who(grant)
    this.actions.push(`${user.username} withdraw ${id}`)
    return [
      {
        id,
        outcome: 'refused',
        reason: 'тестовая страница: на площадку не отправляется',
        publication: null,
      },
    ]
  }
  publicationReplace(): never {
    throw new Error('not this test')
  }
  /** The answers «Проверить» sent, as Hub's door got them. */
  readonly resolved: Array<{ id: number; answer: unknown }> = []
  async publicationResolve(grant: string, id: number, answer: unknown) {
    const user = this.who(grant)
    const found = (this.publicationsOf.get(user.username) ?? []).find((one) => one.id === id)
    if (!found) throw new HubError('refused', 'HTTP 404', { endpoint: 'person', status: 404 })
    this.resolved.push({ id, answer })
    return { publication: { ...found, status: 'scheduled' }, replacementId: null }
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
  readonly statsAsked: string[] = []
  async statsContent(grant: string, pageLabel: string, days: number) {
    this.who(grant)
    this.statsAsked.push(`content ${pageLabel} ${days}`)
    const head = {
      mediaOfferId: `${pageLabel}-m1`.replace(/\D/g, '') || '1',
      mediaType: 2,
      durationMs: 61_000,
      postId: '77',
      postedAt: '2026-11-10T12:00:00.000Z',
      deletedAt: null,
      caption: `видео ${pageLabel}`,
    }
    return {
      window: { fromDay: '2026-10-16', toDay: '2026-11-14', days },
      walk: { visited: 3, queued: 4 },
      media: [
        {
          ...head,
          views: 120,
          forYouViews: 80,
          timelineViews: 40,
          otherViews: 0,
          videoViews: 100,
          completedViews: 25,
          watchMs: 1_000_000,
          watchPctSum: 400_000,
          likes: 9,
          allTimeViews: 300,
        },
      ],
      topSales: [
        {
          ...head,
          priceMills: 19_990,
          salesCount: 3,
          netMills: 47_976,
          grossMills: 59_970,
          windowViews: 120,
        },
      ],
      topSalesTotal: 1,
    }
  }
  async statsMedia(grant: string, pageLabel: string, mediaOfferId: string, days: number) {
    this.who(grant)
    this.statsAsked.push(`media ${pageLabel} ${mediaOfferId}`)
    return {
      mediaOfferId,
      window: { fromDay: '2026-10-16', toDay: '2026-11-14', days },
      daily: [{ day: '2026-11-10', source: 0, views: 80 }],
      hourly: [],
      retention: [{ source: 0, sampleSize: 40, points: [{ percent: 0, stillWatching: 1 }] }],
      tags: [{ tag: 'pool', source: 0, views: 12 }],
    }
  }
  async contentComments(grant: string, pageLabel: string, window: { from: string; to: string }) {
    this.who(grant)
    this.statsAsked.push(`comments ${pageLabel} ${window.from} ${window.to}`)
    return {
      perPost: [
        {
          postRef: '77',
          commentCount: 5,
          possiblyTruncatedCount: 0,
          missingCount: 1,
          caption: null,
          publishedAt: '2026-11-10T12:00:00.000Z',
        },
      ],
      repliesCoverage: [{ status: 'complete', newestCapturedAt: null }],
      mediaUpdatedAt: '2026-11-14T09:00:00.000Z',
    }
  }
  fanslyLoginPages(): never {
    throw new Error('not this test')
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

const feed = async (as: string) => {
  const response = await call(server.app, {
    method: 'GET',
    url: '/api/v1/lora/publications?window=all',
    as,
  })
  expect(response.statusCode, response.body).toBe(200)
  return PublicationsFeedSchema.parse(response.json())
}

beforeAll(async () => {
  server = await testServer({
    secrets: { hub: true, hubBaseUrl: 'https://hub.example' },
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

describe('«Публикации» as the signed-in person', () => {
  it("reads the person's publications with her own grant and shows the model's pages alone", async () => {
    hub.publicationsOf.set('kira', [publication(301, 'lora-1'), publication(302, 'zoe-1')])
    const kira = await throughHub({ id: 501, username: 'kira', role: 'content_manager' })
    const read = await feed(kira)
    expect(read.hub).toBe('ok')
    expect(read.publications.map((one) => one.id)).toEqual([301])
    expect(read.publications[0]).toMatchObject({
      hub_page: 'lora-1',
      account: 'lora-1',
      files: [{ name: 'm301' }],
    })
    expect(read.pages.map((page) => page.hub_page)).toEqual(['lora-1'])
    const card = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/publications/301',
      as: kira,
    })
    expect(PublicationCardSchema.parse(card.json())).toMatchObject({
      hub: 'ok',
      publication: { id: 301 },
    })
    // Another model's post is not this model's: 404, as one that does not exist.
    const other = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/publications/302',
      as: kira,
    })
    expect(other.statusCode).toBe(404)
  })

  it("asks Hub for the model by Hub's slug: a model whose pages bind nothing shows Hub's pages and posts", async () => {
    // `ari` here is Hub's `test` (HUB_MODEL_MAP), and its page `ari-1` is bound to no Hub page.
    hub.publicationsOf.set('tkm', [
      publication(401, 'test-1'),
      publication(402, 'test-1', 'published'),
    ])
    const tkm = await throughHub({ id: 601, username: 'tkm', role: 'content_manager' })
    const response = await call(server.app, {
      method: 'GET',
      url: '/api/v1/ari/publications?window=all',
      as: tkm,
    })
    expect(response.statusCode, response.body).toBe(200)
    const read = PublicationsFeedSchema.parse(response.json())
    expect(read.hub).toBe('ok')
    expect(read.pages).toMatchObject([{ hub_page: 'test-1', account: null, label: 'test-1' }])
    expect(read.publications.map((one) => [one.id, one.account])).toEqual([
      [401, null],
      [402, null],
    ])
    const card = await call(server.app, {
      method: 'GET',
      url: '/api/v1/ari/publications/402',
      as: tkm,
    })
    expect(PublicationCardSchema.parse(card.json())).toMatchObject({
      publication: { id: 402, status: 'published' },
    })
  })

  it('acts as the person: approve, cancel, «Снять»; a refusal is said in words; another model is not there', async () => {
    const draft = publication(311, 'lora-1')
    const blocked = { ...publication(312, 'lora-1'), blocked: true }
    const scheduled = publication(313, 'lora-1', 'scheduled')
    hub.publicationsOf.set('kira', [draft, blocked, scheduled, publication(314, 'zoe-1')])
    const kira = await throughHub({ id: 501, username: 'kira', role: 'content_manager' })
    const act = (id: number, verb: string, body: object = {}) =>
      call(server.app, {
        method: 'POST',
        url: `/api/v1/lora/publications/${id}:${verb}`,
        as: kira,
        body,
      })
    const approved = await act(311, 'approve', { version: 1 })
    expect(approved.json()).toMatchObject({ outcome: 'done', publication_id: 311 })
    expect((await act(312, 'approve', { version: 1 })).json()).toMatchObject({
      outcome: 'refused',
      words: 'Есть замечания, которые не дают утвердить',
    })
    expect((await act(311, 'cancel')).json()).toMatchObject({ outcome: 'done' })
    const handed = await act(313, 'cancel')
    expect(handed.statusCode).toBe(422)
    expect((await act(313, 'withdraw')).json()).toMatchObject({
      outcome: 'refused',
      words: 'тестовая страница: на площадку не отправляется',
    })
    // A post of another model is not this model's: nothing is asked of Hub for it.
    const before = hub.actions.length
    expect((await act(314, 'approve', { version: 1 })).statusCode).toBe(404)
    expect(hub.actions.length).toBe(before)
    expect(hub.actions).toEqual([
      'kira approve 311',
      'kira approve 312',
      'kira cancel 311',
      'kira cancel 313',
      'kira withdraw 313',
    ])
  })

  it('asks Hub nothing for an own account without a grant, and says why', async () => {
    const asked = hub.grantsAsked.length
    const owner = await signIn(server.app, OWNER.login, OWNER.password)
    const read = await feed(owner)
    expect(read).toMatchObject({ hub: 'no_grant', publications: [], pages: [] })
    // An action without a grant is refused here, before Hub.
    const action = await call(server.app, {
      method: 'POST',
      url: '/api/v1/lora/publications/301:cancel',
      as: owner,
      body: {},
    })
    expect(action.statusCode).toBe(403)
    expect(hub.grantsAsked.length).toBe(asked)
  })

  it("says Hub's refusal and Hub's outage in words, and ends the session when the grant is over", async () => {
    const kira = await throughHub({ id: 501, username: 'kira', role: 'content_manager' })
    hub.refuse = true
    expect((await feed(kira)).hub).toBe('refused')
    hub.refuse = false
    hub.away = true
    expect((await feed(kira)).hub).toBe('unreachable')
    hub.away = false
    hub.endAll()
    const over = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/publications',
      as: kira,
    })
    expect(over.statusCode).toBe(401)
  })
})

describe('«Статистика» as the signed-in person', () => {
  it("reads one Fansly page of the model by Hub's slug, the comments over the same UTC days", async () => {
    const tkm = await throughHub({ id: 601, username: 'tkm', role: 'content_manager' })
    hub.statsAsked.length = 0
    const response = await call(server.app, {
      method: 'GET',
      url: '/api/v1/ari/stats?days=30',
      as: tkm,
    })
    expect(response.statusCode, response.body).toBe(200)
    const read = StatsScreenSchema.parse(response.json())
    expect(read).toMatchObject({
      hub: 'ok',
      pages: [{ hub_page: 'test-1', label: 'test-1' }],
      page: 'test-1',
      walk: { visited: 3, queued: 4 },
      top_sales_total: 1,
      comments: { state: 'ok', posts: [{ post_ref: '77', comment_count: 5, missing_count: 1 }] },
      updated_at: '2026-11-14T09:00:00.000Z',
    })
    expect(read.media[0]).toMatchObject({ views: 120, for_you_views: 80, watch_pct_sum: 400_000 })
    expect(read.top_sales[0]).toMatchObject({ net_mills: 47_976, gross_mills: 59_970 })
    expect(hub.statsAsked).toEqual([
      'content test-1 30',
      'comments test-1 2026-10-16T00:00:00.000Z 2026-11-15T00:00:00.000Z',
    ])
    // A page of another model is not asked: the first page of this model is shown instead.
    hub.statsAsked.length = 0
    const other = await call(server.app, {
      method: 'GET',
      url: '/api/v1/ari/stats?page=lora-1',
      as: tkm,
    })
    expect(StatsScreenSchema.parse(other.json()).page).toBe('test-1')
    expect(hub.statsAsked[0]).toBe('content test-1 30')
  })

  it("opens a media's card on the model's page only", async () => {
    const kira = await throughHub({ id: 501, username: 'kira', role: 'content_manager' })
    const card = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/stats/media/1?page=lora-1&days=7',
      as: kira,
    })
    expect(card.statusCode, card.body).toBe(200)
    expect(StatsMediaCardSchema.parse(card.json())).toMatchObject({
      media_offer_id: '1',
      retention: [{ sample_size: 40, points: [{ percent: 0, still_watching: 1 }] }],
    })
    const foreign = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/stats/media/1?page=zoe-1',
      as: kira,
    })
    expect(foreign.statusCode).toBe(404)
  })

  it('an own account without a grant is told so, and Hub is not asked', async () => {
    hub.statsAsked.length = 0
    const owner = await signIn(server.app, OWNER.login, OWNER.password)
    const response = await call(server.app, { method: 'GET', url: '/api/v1/lora/stats', as: owner })
    expect(StatsScreenSchema.parse(response.json()).hub).toBe('no_grant')
    const card = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/stats/media/1?page=lora-1',
      as: owner,
    })
    expect(card.statusCode).toBe(403)
    expect(hub.statsAsked).toEqual([])
  })
})

describe("Hub's old addresses", () => {
  it("the session carries Hub's slugs of the person's models where they differ", async () => {
    const tkm = await throughHub({ id: 601, username: 'tkm', role: 'content_manager' })
    const me = await call(server.app, { method: 'GET', url: '/api/v1/admin/me', as: tkm })
    expect(me.statusCode, me.body).toBe(200)
    expect(me.json()).toMatchObject({ models: ['ari'], hub_models: { test: 'ari' } })
    const kira = await throughHub({ id: 501, username: 'kira', role: 'content_manager' })
    const other = await call(server.app, { method: 'GET', url: '/api/v1/admin/me', as: kira })
    expect(other.json().hub_models).toEqual({})
  })
})

describe('the card names who and where', () => {
  it("names the author, the approver and the post's wall and tiers, and goes without them on an older Hub", async () => {
    const post = publication(701, 'lora-1', 'approved')
    post.raw.tierRefs = ['t1', 't9']
    post.raw.pinWallRefs = ['w2']
    hub.publicationsOf.set('kira', [post])
    const kira = await throughHub({ id: 501, username: 'kira', role: 'content_manager' })
    const read = async () => {
      const card = await call(server.app, {
        method: 'GET',
        url: '/api/v1/lora/publications/701',
        as: kira,
      })
      expect(card.statusCode, card.body).toBe(200)
      return PublicationCardSchema.parse(card.json())
    }
    // An older Hub: no names, no targets — the card stays as it was.
    hub.withNames = false
    hub.targets = null
    expect(await read()).toMatchObject({ author_name: null, approved_by_name: null, targets: null })
    hub.withNames = true
    hub.targets = {
      walls: [
        { wallRef: 'w1', name: 'Posts', defaultWall: true },
        { wallRef: 'w2', name: 'Free', defaultWall: false },
      ],
      tiers: [{ tierRef: 't1', name: 'Gold' }],
    }
    expect(await read()).toMatchObject({
      author_name: 'Генгар',
      approved_by_name: 'Диана',
      // No wall named: the default one; a tier Hub cannot name is counted, never shown as its number.
      targets: { wall: 'Posts (основная)', pinned: 'Free', tiers: '2 уровня' },
    })
    hub.withNames = false
    hub.targets = null
  })
})

describe('«Вышел» on an unknown outcome', () => {
  it("sends Hub the post's number and where it is", async () => {
    hub.publicationsOf.set('kira', [publication(801, 'lora-1', 'unknown')])
    const kira = await throughHub({ id: 501, username: 'kira', role: 'content_manager' })
    const answer = await call(server.app, {
      method: 'POST',
      url: '/api/v1/lora/publications/801:resolve',
      as: kira,
      body: { outcome: 'went_out', state: 'scheduled', platform_post_ref: '851203394123456789' },
    })
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.json()).toMatchObject({ outcome: 'done', publication_id: 801 })
    expect(hub.resolved.at(-1)).toEqual({
      id: 801,
      answer: { outcome: 'went_out', state: 'scheduled', platformPostRef: '851203394123456789' },
    })
  })
})
