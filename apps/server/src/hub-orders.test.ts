import { randomUUID } from 'node:crypto'
import {
  type HubOrder,
  HubOrderListSchema,
  HubOrderSchema,
} from '@contentops/contracts/domain/hub-orders'
import { parseTelegramRef, telegramRefText } from '@contentops/contracts/order-link'
import type { WorkContext } from '@contentops/db'
import {
  type HubClient,
  type HubCustomOrder,
  HubError,
  type HubOrderMessage,
  type HubOrderReportBody,
} from '@contentops/hub'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setHubPage } from './hub/testing'
import { hubOrdersHandler } from './hub-orders/work'
import { createCatalogItems } from './testing/catalog-factory'
import {
  addPerson,
  call,
  newKey,
  OWNER,
  signIn,
  type TestServer,
  testServer,
} from './testing/server'

/**
 * The hub's custom orders in ContentOps (ecosystem plan 12.11.2026, package N): which orders
 * are the model's, a file linked to one goes to the hub through the outbox and the card shows
 * what the hub knows, the last read stays when the hub is away. The hub is an in-memory fake
 * of its agent door; every name, ref and text is made up.
 */

let server: TestServer
let owner: string
let reader: string

const CHAT = '7000000001'

function hubOrder(id: number, fields: Partial<HubCustomOrder> = {}): HubCustomOrder {
  return {
    id,
    code: `K-${id}`,
    pageLabel: 'lora-1',
    platform: 'fansly',
    model: 'Лора',
    fan: { username: 'fan_one', displayName: null },
    buyer: null,
    card: { task: '1. в красном\n2. медленно', duration: '5 минут', wantsVideo: true },
    what: 'в красном',
    deadlineOn: null,
    state: 'at_model',
    stateAt: new Date().toISOString(),
    stateNote: null,
    stateRef: null,
    telegramRefs: [`tg:${CHAT}/3/${9000 + id}`],
    contentopsRef: null,
    overdueDays: null,
    partsDone: [],
    openRevisions: 0,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cardText: `📦 Описание заказа K-${id}`,
    sourceText: null,
    messages: [],
    ...fields,
  }
}

const normalRef = (text: string | undefined) => {
  const ref = text ? parseTelegramRef(text) : null
  return ref ? telegramRefText(ref) : null
}
const MOVES_FROM: readonly string[] = ['recorded', 'paid', 'at_model', 'partly', 'revision']

/**
 * The hub's agent door as far as ContentOps uses it, and as the hub keeps a message: one per
 * Telegram link and ordinal, or one per event ref; the same again answers `unchanged` with the
 * event it already had, a link that holds another kind of message keeps nothing (`event: null`).
 * The hub derives partly and shot from the parts, and takes a retracted delivery's part back.
 */
class FakeHub {
  orders = new Map<string, HubCustomOrder>()
  reports: { code: string; body: HubOrderReportBody }[] = []
  matters = new Map<string, 'open' | 'closed'>()
  titles = new Map<string, string>()
  down = false

  static wanted(order: HubCustomOrder): ('video' | 'photos')[] {
    const parts: ('video' | 'photos')[] = []
    if (order.card.wantsVideo !== false) parts.push('video')
    if ((order.card.wantsPhotos ?? 0) > 0) parts.push('photos')
    return parts.length === 0 ? ['photos'] : parts
  }

  client(): HubClient {
    const away = () => {
      if (this.down)
        throw new HubError('transient', 'network: connect ECONNREFUSED', { endpoint: 'x' })
    }
    const refused = (status: number, reason: string) =>
      new HubError('refused', `HTTP ${status} ${reason}`, { endpoint: 'x', status, code: reason })
    return {
      customOrders: async () => {
        away()
        return { orders: [...this.orders.values()], serverNow: new Date().toISOString() }
      },
      reportCustomOrder: async (code: string, body: HubOrderReportBody) => {
        away()
        const order = this.orders.get(code)
        if (!order) throw refused(404, 'not_found')
        this.reports.push({ code, body })
        const link = normalRef(body.message?.telegramRef)
        const ref = body.eventRef ?? link
        if (ref === null) throw refused(400, 'bad_request')
        const kind = body.action === 'delivery' ? 'delivery' : 'note'
        const answer = (
          outcome: 'changed' | 'unchanged',
          event: HubOrderMessage | null,
          result: 'stored' | 'already',
        ) => ({
          order: structuredClone(order),
          outcome,
          event: event === null ? null : { ref, result },
        })
        const same = order.messages.find((message) =>
          body.eventRef
            ? message.eventRef === body.eventRef
            : message.eventRef === null && message.telegramRef === link && message.ordinal === 0,
        )
        if (same) return answer('unchanged', same.kind === kind ? same : null, 'already')
        const wanted = FakeHub.wanted(order)
        const message: HubOrderMessage = {
          telegramRef: link,
          eventRef: body.eventRef ?? null,
          ordinal: 0,
          kind,
          part: body.action === 'delivery' ? body.part : null,
          complete: body.action === 'delivery' ? body.complete : null,
          at: body.message?.at ?? null,
          author: body.message?.author ?? null,
          excerpt:
            body.action === 'retract'
              ? (body.message?.excerpt ?? body.reason)
              : (body.message?.excerpt ?? null),
          doneAt: null,
          retractedAt: null,
        }
        if (body.action === 'retract') {
          const by = normalRef(body.retracts)
          const hits = order.messages.filter(
            (one) =>
              one.kind === 'delivery' &&
              (one.eventRef === body.retracts || (by !== null && one.telegramRef === by)),
          )
          if (hits.length === 0) throw refused(409, 'unknown_event')
          const now = new Date().toISOString()
          const taken = hits.filter((one) => one.retractedAt === null)
          for (const one of taken) one.retractedAt = now
          const live = order.messages.filter(
            (one) => one.kind === 'delivery' && one.retractedAt === null,
          )
          const lost = taken
            .filter((one) => one.complete !== false && one.part !== null)
            .map((one) => one.part)
            .filter((part) => !live.some((one) => one.part === part && one.complete !== false))
          order.partsDone = order.partsDone.filter((part) => !lost.includes(part))
          if (taken.length > 0 && (order.state === 'shot' || order.state === 'partly')) {
            order.state = wanted.every((part) => order.partsDone.includes(part))
              ? 'shot'
              : order.partsDone.length > 0 || live.length > 0
                ? 'partly'
                : 'at_model'
          }
        } else if (body.action === 'delivery' && MOVES_FROM.includes(order.state)) {
          if (body.complete) order.partsDone = [...new Set([...order.partsDone, body.part])]
          const open = order.openRevisions > 0 || order.state === 'revision'
          if (open && body.complete) order.openRevisions = 0
          const whole = wanted.every((part) => order.partsDone.includes(part))
          order.state = open && !body.complete ? 'revision' : whole ? 'shot' : 'partly'
        }
        order.messages.push(message)
        order.version++
        return answer('changed', message, 'stored')
      },
      openMatter: async (body: { key: string; title: string }) => {
        away()
        this.matters.set(body.key, 'open')
        this.titles.set(body.key, body.title)
        return { key: body.key, state: 'open' as const, transition: 'opened' as const }
      },
      closeMatter: async (body: { key: string }) => {
        away()
        this.matters.set(body.key, 'closed')
        return { key: body.key, state: 'closed' as const, transition: 'closed' as const }
      },
    } as unknown as HubClient
  }
}

const hub = new FakeHub()

async function modelId(code: string): Promise<string> {
  const { rows } = await server.db.execute<{ id: string }>(
    sql`SELECT id FROM models WHERE code = ${code}`,
  )
  return rows[0]?.id ?? ''
}

/** One run of `hub_orders` for the model, as the worker runs it. */
async function run(model = 'lora') {
  const handler = hubOrdersHandler({ client: () => hub.client() })
  const context = {
    work: { modelId: await modelId(model) },
    db: server.db,
    signal: new AbortController().signal,
    checkpoint: async () => {},
  } as unknown as WorkContext
  return handler(context)
}

async function list(as = owner) {
  const response = await call(server.app, { method: 'GET', url: '/api/v1/lora/hub-orders', as })
  expect(response.statusCode, response.body).toBe(200)
  return HubOrderListSchema.parse(response.json())
}

async function card(code: string, as = owner): Promise<HubOrder> {
  const response = await call(server.app, {
    method: 'GET',
    url: `/api/v1/lora/hub-orders/${code}`,
    as,
  })
  expect(response.statusCode, response.body).toBe(200)
  return HubOrderSchema.parse(response.json())
}

async function custom(files: { video?: boolean; photos?: number }) {
  const [item] = await createCatalogItems(server.db, 'lora', [
    {
      type: 'custom',
      title: 'сдача',
      files: [
        ...(files.video ? [{ role: 'master' as const, durationS: 300 }] : []),
        ...Array.from({ length: files.photos ?? 0 }, () => ({ role: 'pic' as const })),
      ],
    },
  ])
  if (!item) throw new Error('no item')
  return item.id
}

function link(code: string, body: Record<string, unknown>) {
  return call(server.app, {
    method: 'POST',
    url: `/api/v1/lora/hub-orders/${code}/deliveries`,
    as: owner,
    key: newKey(),
    body,
  })
}

beforeAll(async () => {
  server = await testServer({ secrets: { hub: true, hubBaseUrl: 'https://hub.example' } })
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  await setHubPage(server.db, 'lora-1', 'lora-1')
  await setHubPage(server.db, 'ari-1', 'ari-1')
  reader = (
    await addPerson(server.app, owner, {
      name: 'Fyper',
      login: 'fyper',
      role: 'reader',
      models: ['lora'],
    })
  ).session
  hub.orders.set('K-1', hubOrder(1))
  hub.orders.set('K-2', hubOrder(2, { state: 'shot', partsDone: ['video'] }))
  // Not in production yet: paid, not at the model.
  hub.orders.set('K-3', hubOrder(3, { state: 'paid' }))
  // No page: ContentOps' old order of the import tells the model.
  hub.orders.set(
    'K-4',
    hubOrder(4, { pageLabel: null, contentopsRef: 'lora/tg-7000000001-3-501', telegramRefs: [] }),
  )
  // No page, an unknown chat: the hub's board has it, no model here.
  hub.orders.set('K-5', hubOrder(5, { pageLabel: null, telegramRefs: ['tg:5550001/7/1'] }))
  // A page of Ari: not Lora's.
  hub.orders.set('K-6', hubOrder(6, { pageLabel: 'ari-1' }))
})
afterAll(() => server.close())

describe('the hub orders of a model', () => {
  it('shows the orders in production of the model from the last read', async () => {
    expect((await list()).read_at).toBeNull()
    await run()
    const read = await list()
    expect(read.read_error).toBeNull()
    expect(read.items.map((order) => order.code).sort()).toEqual(['K-1', 'K-2', 'K-4'])
    expect(read.unassigned).toBe(1)
    expect(read.board_url).toBe('https://hub.example/workboard/customs')
    const first = read.items.find((order) => order.code === 'K-1')
    expect(first).toMatchObject({
      account: 'lora-1',
      buyer: 'fan_one',
      status: { word: 'у модели' },
      hub_url: 'https://hub.example/workboard/customs/K-1',
      card_url: `https://t.me/c/${CHAT}/3/9001`,
    })
    expect(read.items.find((order) => order.code === 'K-4')?.archive_order).toBe(
      'tg-7000000001-3-501',
    )
    // «Только чтение» sees no buyer, card or link.
    const hidden = (await list(reader)).items.find((order) => order.code === 'K-1')
    expect(hidden).toMatchObject({ buyer: null, card_text: null, card_url: null })
  })

  it('a linked file reaches the hub through the outbox; until then the card says so', async () => {
    const item = await custom({ video: true })
    const linked = await link('K-1', { item_id: item })
    expect(linked.statusCode, linked.body).toBe(201)
    const before = HubOrderSchema.parse(linked.json())
    expect(before.files).toEqual([
      expect.objectContaining({
        item_id: item,
        part: 'video',
        complete: true,
        report: expect.objectContaining({ state: 'pending' }),
      }),
    ])
    // The hub does not know yet: the card keeps the hub's state and says the delivery waits.
    expect(before.state).toBe('at_model')
    expect(before.status.detail).toContain('сдача ещё не в Hub')
    const { rows: works } = await server.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM work_operations
       WHERE kind = 'hub_orders' AND state = 'pending'`)
    expect(works[0]?.n).toBeGreaterThan(0)

    await run()
    expect(hub.reports.at(-1)).toMatchObject({
      code: 'K-1',
      body: {
        action: 'delivery',
        eventRef: `contentops:delivery:${before.files[0]?.id}`,
        part: 'video',
        complete: true,
        message: { author: 'ContentOps' },
      },
    })
    const after = await card('K-1')
    expect(after.state).toBe('shot')
    expect(after.files[0]?.report).toMatchObject({ state: 'sent', error: null })
    expect(after.pending_reports).toBe(0)
    // The same file again links nothing and sends nothing.
    const again = await link('K-1', { item_id: item })
    expect(again.statusCode, again.body).toBe(201)
    expect(HubOrderSchema.parse(again.json()).files).toHaveLength(1)
  })

  it("an order with no Telegram card gets its delivery: the hub keeps it by ContentOps' own id", async () => {
    const item = await custom({ video: true })
    const linked = HubOrderSchema.parse((await link('K-4', { item_id: item })).json())
    const delivery = linked.files.find((file) => file.archive_order === null)
    // K-4 has no Telegram card in the hub: the delivery still goes, known by its own id.
    expect(delivery?.report).toMatchObject({ state: 'pending' })
    await run()
    const eventRef = `contentops:delivery:${delivery?.id}`
    expect(hub.reports.at(-1)).toMatchObject({
      code: 'K-4',
      body: { action: 'delivery', eventRef },
    })
    expect(hub.orders.get('K-4')?.messages).toContainEqual(
      expect.objectContaining({ kind: 'delivery', eventRef, telegramRef: null }),
    )
    expect(hub.orders.get('K-4')?.state).toBe('shot')
    const after = await card('K-4')
    expect(after.files.find((file) => file.id === delivery?.id)?.report).toMatchObject({
      state: 'sent',
      error: null,
    })
  })

  it('a retraction is its own event in the hub: the delivery is taken back there', async () => {
    const k2 = await custom({ video: true })
    const second = HubOrderSchema.parse((await link('K-2', { item_id: k2 })).json())
    const file = second.files[0]
    if (!file) throw new Error('no file')
    const retracted = await call(server.app, {
      method: 'POST',
      url: `/api/v1/lora/hub-orders/K-2/deliveries/${file.id}:retract`,
      as: owner,
      key: newKey(),
      body: { reason: 'это другой заказ' },
    })
    expect(retracted.statusCode, retracted.body).toBe(200)
    await run()
    const deliveryRef = `contentops:delivery:${file.id}`
    expect(hub.reports.at(-1)).toMatchObject({
      code: 'K-2',
      body: { action: 'retract', retracts: deliveryRef, reason: 'это другой заказ' },
    })
    const order = hub.orders.get('K-2')
    // The hub took the delivery back: its part no longer counts, nothing else delivered it.
    expect(
      order?.messages.find((message) => message.eventRef === deliveryRef)?.retractedAt,
    ).toEqual(expect.any(String))
    expect(order).toMatchObject({ state: 'at_model', partsDone: [] })
    const after = await card('K-2')
    expect(after.files[0]?.retracted).toMatchObject({ reason: 'это другой заказ' })
    expect(after.files[0]?.retraction_report).toMatchObject({ state: 'sent' })
  })

  it('a report the hub keeps no event of is «refused» with words, never «sent» on a 200', async () => {
    hub.orders.set('K-8', hubOrder(8))
    await run()
    const item = await custom({ video: true })
    const linked = HubOrderSchema.parse((await link('K-8', { item_id: item })).json())
    const file = linked.files[0]
    if (!file) throw new Error('no file')
    // A report written before events: a note under the order's card, a link the hub has a delivery under.
    const cardRef = `tg:${CHAT}/3/9008`
    hub.orders.get('K-8')?.messages.push({
      telegramRef: cardRef,
      eventRef: null,
      ordinal: 0,
      kind: 'delivery',
      part: 'video',
      complete: true,
      at: null,
      author: null,
      excerpt: null,
      doneAt: null,
      retractedAt: null,
    })
    const old = {
      action: 'message',
      kind: 'note',
      message: { telegramRef: cardRef, excerpt: 'отвязана' },
    }
    await server.db.execute(sql`
      UPDATE hub_order_reports SET body = ${JSON.stringify(old)}::jsonb
       WHERE delivery_id = ${file.id}::uuid`)
    await run()
    expect(hub.reports.at(-1)).toMatchObject({ code: 'K-8', body: old })
    expect((await card('K-8')).files[0]?.report).toMatchObject({
      state: 'refused',
      error: expect.stringContaining('не сохранил'),
    })
  })

  it('the hub away: the last read stays with its time, the reports wait', async () => {
    const lastRead = (await list()).read_at
    const item = await custom({ video: true })
    hub.orders.set('K-7', hubOrder(7))
    hub.down = true
    try {
      // K-7 is not in the last read: nothing to link it to yet.
      expect((await link('K-7', { item_id: item })).statusCode).toBe(404)
      const k1photos = await custom({ video: true })
      expect((await link('K-2', { item_id: k1photos })).statusCode).toBe(201)
      await run()
      const read = await list()
      expect(read.read_at).toBe(lastRead)
      expect(read.read_error).toMatch(/^Hub не ответил/)
      expect(read.items.map((order) => order.code)).toContain('K-1')
      const k2 = await card('K-2')
      expect(k2.pending_reports).toBe(1)
    } finally {
      hub.down = false
    }
    await run()
    const read = await list()
    expect(read.read_error).toBeNull()
    expect(read.items.map((order) => order.code)).toContain('K-7')
    expect((await card('K-2')).pending_reports).toBe(0)
  })

  it('a copy of a custom outside its folder opens a matter in the hub, and closes it', async () => {
    const item = await custom({ video: true })
    const { rows } = await server.db.execute<{ id: string }>(sql`
      SELECT id FROM content_items WHERE model_id = ${await modelId('lora')}::uuid
         AND public_item_id(type, number) = ${item}`)
    const itemId = rows[0]?.id ?? ''
    await server.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.actor_type', 'system', true),
        set_config('app.actor_label', 'test', true), set_config('app.action', 'test', true),
        set_config('app.request_id', ${randomUUID()}, true)`)
      await tx.execute(sql`
        INSERT INTO review_cases (model_id, kind, dedup_key, item_id, details)
        VALUES (${await modelId('lora')}::uuid, 'custom_copy', ${`copy:${itemId}`}, ${itemId}::uuid,
                ${JSON.stringify({ relative: '/8. Other/x.mov', source: 'dropbox' })}::jsonb)`)
    })
    await run()
    const key = [...hub.matters.keys()].find((candidate) =>
      candidate.startsWith('contentops.custom_copy:'),
    )
    expect(key && hub.matters.get(key)).toBe('open')
    await server.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.actor_type', 'system', true),
        set_config('app.actor_label', 'test', true), set_config('app.action', 'test', true),
        set_config('app.request_id', ${randomUUID()}, true)`)
      await tx.execute(sql`UPDATE review_cases SET state = 'dismissed', resolved_at = now()
                             WHERE kind = 'custom_copy'`)
    })
    await run()
    expect(key && hub.matters.get(key)).toBe('closed')
  })

  it('copies of one custom are one matter, named by the hub order the custom is linked to', async () => {
    const lora = await modelId('lora')
    hub.orders.set('K-9', hubOrder(9))
    await run()
    const item = await custom({ video: true })
    expect((await link('K-9', { item_id: item })).statusCode).toBe(201)
    const { rows } = await server.db.execute<{ id: string }>(sql`
      SELECT id FROM content_items WHERE model_id = ${lora}::uuid
         AND public_item_id(type, number) = ${item}`)
    const itemId = rows[0]?.id ?? ''
    const cases: string[] = []
    await server.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.actor_type', 'system', true),
        set_config('app.actor_label', 'test', true), set_config('app.action', 'test', true),
        set_config('app.request_id', ${randomUUID()}, true)`)
      for (const name of ['a.mov', 'b.mov', 'c.mov']) {
        const { rows: made } = await tx.execute<{ id: string }>(sql`
          INSERT INTO review_cases (model_id, kind, dedup_key, item_id, details)
          VALUES (${lora}::uuid, 'custom_copy', ${`copy:${itemId}:${name}`}, ${itemId}::uuid,
                  ${JSON.stringify({ relative: `/8. Other/${name}`, source: 'dropbox' })}::jsonb)
          RETURNING id`)
        cases.push(made[0]?.id ?? '')
      }
    })
    // A matter per file, as the earlier passes opened them.
    const perFile = `contentops.custom_copy:${cases[0]}`
    hub.matters.set(perFile, 'open')
    await server.db.execute(sql`
      INSERT INTO hub_matters (model_id, key, kind, title)
      VALUES (${lora}::uuid, ${perFile}, 'contentops.custom_copy', 'Копия кастома')`)
    await run()
    const mine = [...hub.matters.entries()].filter(
      ([key, state]) => state === 'open' && cases.some((id) => key.endsWith(id)),
    )
    expect(mine).toEqual([])
    expect(hub.matters.get(perFile)).toBe('closed')
    expect(hub.matters.get('contentops.custom_copy:K-9')).toBe('open')
    expect(hub.titles.get('contentops.custom_copy:K-9')).toMatch(/^Копии кастома K-9 /)
  })
})
