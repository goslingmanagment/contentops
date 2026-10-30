import { randomUUID } from 'node:crypto'
import { addDays, mskDate } from '@contentops/contracts/clock'
import { IssuedTokenSchema } from '@contentops/contracts/domain/agents'
import { type Order, OrderListSchema, OrderSchema } from '@contentops/contracts/domain/orders'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCatalogItems, type FixtureFile } from './testing/catalog-factory'
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
 * Custom orders on the server (PLAN 4б, SPEC §5, §8.2, schema §9.4): parts, deliveries,
 * retractions, revisions, closing and «снят», overdue by the source date, the field a person
 * edited last, «подтверждено агентом», and the manager's whole path through an order.
 */

let server: TestServer
let owner: string
let diana: string
let reader: string
let agent: string

beforeAll(async () => {
  server = await testServer()
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  diana = (
    await addPerson(server.app, owner, {
      name: 'Диана',
      login: 'diana',
      role: 'manager',
      models: ['lora'],
    })
  ).session
  reader = (
    await addPerson(server.app, owner, {
      name: 'Fyper',
      login: 'fyper',
      role: 'reader',
      models: ['lora'],
    })
  ).session
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
    body: { name: 'Агент заказов', role: 'manager', models: ['lora'] },
  })
  if (added.statusCode !== 201) throw new Error(`add agent: ${added.body}`)
  const agentId = added.json().id as string
  const issued = await call(server.app, {
    method: 'POST',
    url: `/api/v1/admin/agents/${agentId}/tokens`,
    as: owner,
    key: newKey(),
    body: { agent_id: agentId, expires_in_days: null },
  })
  if (issued.statusCode !== 201) throw new Error(`issue token: ${issued.body}`)
  agent = `Bearer ${IssuedTokenSchema.parse(issued.json()).secret}`
})
afterAll(() => server.close())

let cards = 0
/** A fresh card of the fixture chat: every test has its own orders. */
const cardLink = () => `https://t.me/c/2627984998/12/${1000 + ++cards}`

const today = () => mskDate(new Date().toISOString())

interface Send {
  as?: string
  key?: string
  ifMatch?: number
  body?: unknown
}

function post(url: string, send: Send = {}) {
  return call(server.app, {
    method: 'POST',
    url: `/api/v1/lora${url}`,
    as: send.as ?? diana,
    key: send.key ?? newKey(),
    body: send.body,
    ...(send.ifMatch === undefined ? {} : { ifMatch: send.ifMatch }),
  })
}

async function ok(response: Awaited<ReturnType<typeof post>>, status = 200): Promise<Order> {
  if (response.statusCode !== status) {
    throw new Error(`expected ${status}, got ${response.statusCode}: ${response.body}`)
  }
  return OrderSchema.parse(response.json())
}

async function getOrder(id: string, as = diana): Promise<Order> {
  return ok(await call(server.app, { method: 'GET', url: `/api/v1/lora/orders/${id}`, as }))
}

async function createOrder(
  fields: Partial<{
    brief: string
    wants_video: boolean
    wants_photos: number
    deadline: string | null
    buyer: string | null
    duration_raw: string
  }> = {},
  as = diana,
): Promise<Order> {
  return ok(
    await post('/orders', {
      as,
      body: {
        message_url: cardLink(),
        buyer: 'фан №1482',
        account: 'lora-1',
        brief: 'вся в красном',
        duration_raw: '12-15 минут',
        wants_video: true,
        wants_photos: 0,
        deadline: null,
        fan_name: 'unknown',
        card_text: '📌 Кастом «вся в красном»\n⏱ 12-15 минут',
        ...fields,
      },
    }),
    201,
  )
}

/** A delivered CUS as the intake leaves it: videos and photos, each a file of its own. */
async function custom(files: { videos?: 0 | 1; photos?: number; arrivedAt?: string }) {
  // A CUS has one master: several clips of an order come as several CUS.
  const list: FixtureFile[] = [
    ...Array.from({ length: Math.min(files.videos ?? 0, 1) }, () => ({
      role: 'master' as const,
      durationS: 900,
      ...(files.arrivedAt ? { arrivedAt: files.arrivedAt } : {}),
    })),
    ...Array.from({ length: files.photos ?? 0 }, () => ({
      role: 'pic' as const,
      ...(files.arrivedAt ? { arrivedAt: files.arrivedAt } : {}),
    })),
  ]
  const [item] = await createCatalogItems(server.db, 'lora', [
    { type: 'custom', title: 'сдача', files: list },
  ])
  if (!item) throw new Error('no item')
  return item.id
}

function link(order: Order, item: string, body: Record<string, unknown> = {}, as = diana) {
  return post(`/orders/${order.id}/deliveries`, { as, body: { item_id: item, ...body } })
}

describe('creating an order', () => {
  it('keeps the card as the address; one card, one order', async () => {
    const order = await createOrder({ deadline: addDays(today(), 3) })
    expect(order.id).toMatch(/^tg-2627984998-12-\d+$/)
    expect(order).toMatchObject({
      title: 'вся в красном',
      buyer: 'фан №1482',
      account: 'lora-1',
      state: 'waiting',
      wants_video: true,
      duration: { raw: '12-15 минут', min_s: 720, max_s: 900 },
      card: { ref: expect.stringMatching(/^tg:2627984998\/12\/\d+$/) },
      created_by: { type: 'person', name: 'Диана' },
    })
    expect(order.card.text).toContain('вся в красном')
    expect(order.parts).toEqual([expect.objectContaining({ kind: 'video', complete: false })])
    // The same card in another spelling opens the order instead of a second one.
    const again = await post('/orders', {
      body: {
        message_url: order.card.ref.replace('tg:', 'tg:-100'),
        buyer: null,
        account: null,
        brief: 'другое',
        duration_raw: '',
        wants_video: true,
        wants_photos: 0,
        deadline: null,
        fan_name: 'unknown',
        card_text: null,
      },
    })
    expect(again.statusCode).toBe(422)
    expect(again.json()).toMatchObject({ code: 'order_exists', details: { order: order.id } })
  })

  it('needs a Telegram link and something to deliver', async () => {
    const base = {
      buyer: null,
      account: null,
      brief: 'в чёрном спорт',
      duration_raw: '',
      wants_video: true,
      wants_photos: 0,
      deadline: null,
      fan_name: 'unknown',
      card_text: null,
    }
    const noLink = await post('/orders', { body: { ...base, message_url: 'не ссылка' } })
    expect(noLink.statusCode).toBe(400)
    expect(noLink.json().details).toMatchObject({ field: 'message_url' })
    const nothing = await post('/orders', {
      body: { ...base, message_url: cardLink(), wants_video: false },
    })
    expect(nothing.statusCode).toBe(400)
  })

  it('reads the card text into fields', async () => {
    const response = await post('/orders:parse', {
      body: {
        card_text:
          '📌 Кастом «в белом халате»\n👤 фан №2201 · Fansly 1\n📄 у окна\n⏱ 8-10 минут\n🖼 15 фото',
        message_url: null,
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      buyer: 'фан №2201',
      account: 'lora-1',
      brief: '«в белом халате» у окна',
      wants_photos: 15,
    })
  })
})

describe('parts (SPEC §8.2, schema §9.4)', () => {
  it('only the video of video and photos is not delivered; 1 of 20 photos is not either', async () => {
    const order = await createOrder({ wants_photos: 20, brief: 'примерка белья' })
    expect(order.parts.map((part) => part.kind)).toEqual(['video', 'photos'])
    const video = await ok(await link(order, await custom({ videos: 1 })), 201)
    expect(video.state).toBe('partial')
    expect(video.parts.find((part) => part.kind === 'video')?.complete).toBe(true)
    expect(video.status.detail).toBe('видео есть, фото 0 из 20')
    const closing = await post(`/orders/${order.id}:close`)
    expect(closing.statusCode).toBe(422)
    expect(closing.json().code).toBe('order_not_complete')

    const one = await ok(await link(order, await custom({ photos: 1 })), 201)
    const photos = one.parts.find((part) => part.kind === 'photos')
    expect(photos).toMatchObject({ delivered: 1, required: 20, complete: false })
    expect(one.state).toBe('partial')
    const mark = await post(`/orders/${order.id}/parts/photos`, { body: { complete: true } })
    expect(mark.statusCode).toBe(422)

    const all = await ok(await link(order, await custom({ photos: 20 })), 201)
    expect(all.parts.every((part) => part.complete)).toBe(true)
    expect(all.state).toBe('delivered')
    expect(all.close_block).toBeNull()
    const { rows } = await server.db.execute<{ status: string }>(
      sql`SELECT status FROM custom_orders WHERE tg_message_id = ${Number(order.id.split('-')[3])}`,
    )
    expect(rows[0]?.status).toBe('delivered')
  })

  it('several clips are one part, marked when all of them came', async () => {
    const order = await createOrder({ brief: 'два ролика' })
    const first = await ok(await link(order, await custom({ videos: 1 }), { complete: false }), 201)
    expect(first.state).toBe('partial')
    expect(first.parts[0]).toMatchObject({ delivered: 1, complete: false })
    const second = await ok(
      await link(order, await custom({ videos: 1 }), { complete: false }),
      201,
    )
    expect(second.parts[0]).toMatchObject({ delivered: 2, complete: false })
    expect(second.parts).toHaveLength(1)
    const whole = await ok(
      await post(`/orders/${order.id}/parts/video`, { body: { complete: true } }),
    )
    expect(whole.parts[0]).toMatchObject({ complete: true, completed_by: { name: 'Диана' } })
    expect(whole.state).toBe('delivered')
  })
})

describe('deliveries, revisions, closing (SPEC §5)', () => {
  it('a retraction is a new record; the part loses its mark', async () => {
    const order = await createOrder({ brief: 'отзыв сдачи' })
    const delivered = await ok(await link(order, await custom({ videos: 1 })), 201)
    expect(delivered.state).toBe('delivered')
    const delivery = delivered.deliveries[0]
    if (!delivery) throw new Error('no delivery')
    const empty = await post(`/orders/${order.id}/deliveries/${delivery.id}:retract`, {
      body: { reason: '' },
    })
    expect(empty.statusCode).toBe(400)
    const retracted = await ok(
      await post(`/orders/${order.id}/deliveries/${delivery.id}:retract`, {
        body: { reason: 'это другой заказ' },
      }),
    )
    expect(retracted.state).toBe('waiting')
    expect(retracted.parts[0]).toMatchObject({ delivered: 0, complete: false })
    expect(retracted.deliveries[0]?.retracted).toMatchObject({
      reason: 'это другой заказ',
      by: { name: 'Диана' },
    })
    const { rows } = await server.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM custom_order_deliveries WHERE retracts_id = ${delivery.id}::uuid`)
    expect(rows[0]?.n).toBe(1)
    const unknown = await post(`/orders/${order.id}/deliveries/${randomUUID()}:retract`, {
      body: { reason: 'нет' },
    })
    expect(unknown.statusCode).toBe(404)
  })

  it('an open revision blocks closing; a new version alone does not close it', async () => {
    const order = await createOrder({ brief: 'танец живота' })
    await ok(await link(order, await custom({ videos: 1 })), 201)
    const revised = await ok(
      await post(`/orders/${order.id}/revisions`, {
        body: { text: 'без музыки', message_url: 'https://t.me/c/2627984998/12/77' },
      }),
      201,
    )
    expect(revised.state).toBe('revision')
    expect(revised.status).toMatchObject({ sign: 'turn', word: 'правка', detail: '«без музыки»' })
    // The routine reads the same message again: no second revision.
    const again = await ok(
      await post(`/orders/${order.id}/revisions`, {
        body: { text: 'без музыки', message_url: 'tg:2627984998/12/77' },
      }),
      201,
    )
    expect(again.revisions).toHaveLength(1)
    expect(again.messages.some((message) => message.kind === 'revision')).toBe(true)
    const closing = await post(`/orders/${order.id}:close`)
    expect(closing.statusCode).toBe(422)
    expect(closing.json().code).toBe('order_not_complete')
    const revision = again.revisions[0]
    if (!revision) throw new Error('no revision')
    const early = await post(`/orders/${order.id}/revisions/${revision.id}:complete`, {
      body: { basis: 'new_version' },
    })
    expect(early.statusCode).toBe(422)
    const fixed = await ok(await link(order, await custom({ videos: 1 })), 201)
    expect(fixed.state).toBe('revision')
    const done = await ok(
      await post(`/orders/${order.id}/revisions/${revision.id}:complete`, {
        body: { basis: 'new_version' },
      }),
    )
    expect(done.revisions[0]?.done).toMatchObject({
      basis: 'new_version',
      delivery_id: fixed.deliveries.at(-1)?.id,
      version_label: `новая версия ${fixed.deliveries.at(-1)?.item_id}`,
    })
    expect(done.state).toBe('delivered')
    const closed = await ok(await post(`/orders/${order.id}:close`))
    expect(closed.state).toBe('closed')
    expect(closed.closed_at).not.toBeNull()
    // A closed order takes no deliveries and no open revisions.
    expect((await link(order, await custom({ videos: 1 }))).json().code).toBe('order_closed')
    const late = await post(`/orders/${order.id}/revisions`, {
      body: { text: 'ещё', message_url: null },
    })
    expect(late.json().code).toBe('order_closed')
    const reopen = await post(`/orders/${order.id}/revisions/${revision.id}:reopen`)
    expect(reopen.json().code).toBe('order_closed')
  })

  it('close and a revision at once: exactly one of them wins', async () => {
    const order = await createOrder({ brief: 'гонка' })
    await ok(await link(order, await custom({ videos: 1 })), 201)
    const [close, revision] = await Promise.all([
      post(`/orders/${order.id}:close`),
      post(`/orders/${order.id}/revisions`, {
        body: { text: 'поправить свет', message_url: null },
      }),
    ])
    const after = await getOrder(order.id)
    if (close.statusCode === 200) {
      expect(revision.statusCode).toBe(422)
      expect(after.state).toBe('closed')
    } else {
      expect(revision.statusCode).toBe(201)
      expect(after.state).toBe('revision')
    }
  })

  it('«снят» needs a reason and takes the overdue away', async () => {
    const order = await createOrder({ brief: 'возврат', deadline: addDays(today(), -3) })
    expect(order.state).toBe('overdue')
    expect(order.overdue_days).toBe(3)
    const noReason = await post(`/orders/${order.id}:cancel`, { body: { reason: ' ' } })
    expect(noReason.statusCode).toBe(400)
    const cancelled = await ok(
      await post(`/orders/${order.id}:cancel`, { as: agent, body: { reason: 'отказ фана' } }),
    )
    expect(cancelled).toMatchObject({
      state: 'cancelled',
      overdue_days: null,
      status: { word: 'снят', detail: 'отказ фана' },
      cancelled: { reason: 'отказ фана', by: { type: 'agent', name: 'Агент заказов' } },
    })
    expect((await post(`/orders/${order.id}:close`)).json().code).toBe('order_closed')
    const list = OrderListSchema.parse(
      (
        await call(server.app, {
          method: 'GET',
          url: '/api/v1/lora/orders?tab=cancelled',
          as: diana,
        })
      ).json(),
    )
    expect(list.items.map((item) => item.id)).toContain(order.id)
  })
})

describe('overdue by the source date (SPEC §8.2)', () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

  it('a file that appeared before the deadline is in time, whenever it was accepted', async () => {
    const order = await createOrder({ brief: 'в срок', deadline: addDays(today(), -5) })
    expect(order.state).toBe('overdue')
    const delivered = await ok(
      await link(order, await custom({ videos: 1, arrivedAt: daysAgo(7) })),
      201,
    )
    expect(delivered.state).toBe('delivered')
    expect(delivered.late_days).toBeNull()
    expect(delivered.deliveries[0]?.delivered_at.slice(0, 10)).toBe(daysAgo(7).slice(0, 10))
  })

  it('a file that appeared after the deadline is late by its source date', async () => {
    const order = await createOrder({ brief: 'поздно', deadline: addDays(today(), -5) })
    const delivered = await ok(
      await link(order, await custom({ videos: 1, arrivedAt: daysAgo(2) })),
      201,
    )
    expect(delivered.state).toBe('delivered')
    expect(delivered.late_days).toBe(3)
    expect(delivered.status.detail).toContain('позже срока')
  })

  it('a draft in «Приехало» that chose the order already counts as its part', async () => {
    const order = await createOrder({ brief: 'в приехало', deadline: addDays(today(), -2) })
    expect(order.state).toBe('overdue')
    await server.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ model_id: string; id: string }>(sql`
        SELECT model_id, id FROM custom_orders WHERE tg_message_id = ${Number(order.id.split('-')[3])}`)
      const row = rows[0]
      if (!row) throw new Error('no order')
      await tx.execute(sql`SELECT set_config('app.actor_type', 'system', true),
                                  set_config('app.actor_label', 'тест', true),
                                  set_config('app.action', 'test', true),
                                  set_config('app.request_id', 'test', true)`)
      await tx.execute(sql`
        INSERT INTO sources (model_id, kind, label, root_path, credentials_ref)
        VALUES (${row.model_id}::uuid, 'yandex_disk', 'inbox-test', '/', 'INBOX_TEST')
        ON CONFLICT (model_id, label) DO NOTHING`)
      const { rows: groups } = await tx.execute<{ id: string; source_id: string }>(sql`
        INSERT INTO inbox_groups (model_id, source_id, group_key, grouping, custom_order_id)
        SELECT ${row.model_id}::uuid, id, ${randomUUID()}, 'single', ${row.id}::uuid
          FROM sources WHERE model_id = ${row.model_id}::uuid AND label = 'inbox-test'
        RETURNING id, source_id`)
      const group = groups[0]
      if (!group) throw new Error('no group')
      const objectId = randomUUID()
      await tx.execute(sql`
        INSERT INTO source_objects (model_id, id, source_id, resource_id, current_path, current_name)
        VALUES (${row.model_id}::uuid, ${objectId}::uuid, ${group.source_id}::uuid, ${objectId},
                '/Customs/13:03.mov', '13:03.mov')`)
      const { rows: revisions } = await tx.execute<{ id: string }>(sql`
        INSERT INTO source_revisions (model_id, source_object_id, sequence_no, byte_size,
                                      remote_created_at)
        VALUES (${row.model_id}::uuid, ${objectId}::uuid, 1, 100, ${daysAgo(3)}::timestamptz)
        RETURNING id`)
      await tx.execute(sql`
        INSERT INTO inbox_drafts (model_id, group_id, source_revision_id, origin, path)
        VALUES (${row.model_id}::uuid, ${group.id}::uuid, ${revisions[0]?.id}::uuid, 'disk_scan',
                '/Customs/13:03.mov')`)
    })
    const waiting = await getOrder(order.id)
    expect(waiting).toMatchObject({ in_inbox: true, overdue_days: null, state: 'waiting' })
    expect(waiting.status.detail).toBe('сдача в «Приехало»')
  })
})

describe('agents (SPEC §8.2, §11.1)', () => {
  it('an agent does not overwrite a field a person edited last', async () => {
    const order = await createOrder({ brief: 'поле человека', buyer: null }, agent)
    expect(order.created_by).toMatchObject({ type: 'agent' })
    const noVersion = await call(server.app, {
      method: 'PATCH',
      url: `/api/v1/lora/orders/${order.id}`,
      as: diana,
      key: newKey(),
      body: { deadline: '2026-12-01' },
    })
    expect(noVersion.statusCode).toBe(428)
    const edited = await ok(
      await call(server.app, {
        method: 'PATCH',
        url: `/api/v1/lora/orders/${order.id}`,
        as: diana,
        key: newKey(),
        ifMatch: order.version,
        body: { deadline: '2026-12-01' },
      }),
    )
    expect(edited.deadline).toBe('2026-12-01')
    const stale = await call(server.app, {
      method: 'PATCH',
      url: `/api/v1/lora/orders/${order.id}`,
      as: agent,
      key: newKey(),
      ifMatch: order.version,
      body: { brief: 'другое' },
    })
    expect(stale.statusCode).toBe(412)
    const refused = await call(server.app, {
      method: 'PATCH',
      url: `/api/v1/lora/orders/${order.id}`,
      as: agent,
      key: newKey(),
      ifMatch: edited.version,
      body: { deadline: '2026-12-05', brief: 'поле агента' },
    })
    expect(refused.statusCode).toBe(422)
    expect(refused.json()).toMatchObject({
      code: 'edited_by_person',
      details: { fields: ['deadline'], edited: [{ field: 'deadline', by: 'Диана' }] },
    })
    // Its own field and an empty one it may write.
    const own = await ok(
      await call(server.app, {
        method: 'PATCH',
        url: `/api/v1/lora/orders/${order.id}`,
        as: agent,
        key: newKey(),
        ifMatch: edited.version,
        body: { brief: 'поле агента', buyer: 'фан №77' },
      }),
    )
    expect(own).toMatchObject({ brief: 'поле агента', buyer: 'фан №77', deadline: '2026-12-01' })
  })

  it('an agent confirms an ambiguous link: «подтверждено агентом» on the order and in the journal', async () => {
    const order = await createOrder({ brief: 'спорная привязка' }, agent)
    const linked = await ok(
      await link(
        order,
        await custom({ videos: 1 }),
        {
          matched: ['ответ на карточку', '15:00 ≈ 15 мин'],
          evidence: ['https://t.me/c/2627984998/12/5555'],
          confirmed: true,
          message_url: 'https://t.me/c/2627984998/12/5555',
        },
        agent,
      ),
      201,
    )
    expect(linked.deliveries[0]).toMatchObject({
      matched: ['ответ на карточку', '15:00 ≈ 15 мин'],
      evidence: ['tg:2627984998/12/5555'],
      linked_by: { type: 'agent' },
      confirmed_by: { type: 'agent', name: 'Агент заказов' },
    })
    const journal = await call(server.app, {
      method: 'GET',
      url: `/api/v1/lora/journal?order=${order.id}&actor_type=agent`,
      as: owner,
    })
    const events = journal.json().items as { action: string; changes: unknown }[]
    expect(events.map((event) => event.action)).toEqual(['orders.linkDelivery', 'orders.create'])
    expect(JSON.stringify(events[0]?.changes)).toContain('агентом')
    // A key is required from an agent; the same key replays the same answer.
    const key = newKey()
    const first = await post(`/orders/${order.id}/messages`, {
      as: agent,
      key,
      body: {
        message_url: 'https://t.me/c/2627984998/12/5556',
        kind: 'confirmation',
        at: new Date().toISOString(),
        author: 'Лора',
        excerpt: 'готово',
      },
    })
    const repeat = await post(`/orders/${order.id}/messages`, {
      as: agent,
      key,
      body: {
        message_url: 'https://t.me/c/2627984998/12/5556',
        kind: 'confirmation',
        at: first.json().messages.at(-1).at,
        author: 'Лора',
        excerpt: 'готово',
      },
    })
    expect(first.statusCode).toBe(201)
    expect([201, 409]).toContain(repeat.statusCode)
  })
})

describe('rights and the list', () => {
  it('«Только чтение» reads the order without the buyer and the texts', async () => {
    const order = await createOrder({ brief: 'текст заказа', buyer: 'фан №5' })
    const read = await getOrder(order.id, reader)
    expect(read).toMatchObject({ buyer: null, brief: null, card: { url: '', text: null } })
    expect(read.messages).toEqual([])
    const write = await post(`/orders/${order.id}:cancel`, {
      as: reader,
      body: { reason: 'нет' },
    })
    expect(write.statusCode).toBe(403)
  })

  it('tabs, counts, search in every tab and keyset pages', async () => {
    const list = async (query: string) =>
      OrderListSchema.parse(
        (
          await call(server.app, { method: 'GET', url: `/api/v1/lora/orders?${query}`, as: diana })
        ).json(),
      )
    const open = await list('tab=open&limit=500')
    expect(open.open_count).toBe(open.items.length)
    expect(open.items.every((item) => !['closed', 'cancelled'].includes(item.state))).toBe(true)
    expect(open.overdue_count).toBe(open.items.filter((item) => item.state === 'overdue').length)
    const found = await list('q=танец')
    expect(found.items.map((item) => item.title)).toContain('танец живота')
    expect(found.items.some((item) => item.state === 'closed')).toBe(true)
    const first = await list('tab=open&limit=1')
    expect(first.items).toHaveLength(1)
    expect(first.next_cursor).not.toBeNull()
    const second = await list(`tab=open&limit=1&cursor=${first.next_cursor}`)
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id)
    const foreign = await call(server.app, {
      method: 'GET',
      url: `/api/v1/lora/orders?tab=closed&cursor=${first.next_cursor}`,
      as: diana,
    })
    expect(foreign.statusCode).toBe(400)
  })
})

describe("the manager's path through an order (PLAN 4б «сквозной сценарий»)", () => {
  it('order → delivery → revision → fixed version → close', async () => {
    // «Новый заказ» from the card.
    const order = await createOrder({ brief: 'Босс', deadline: addDays(today(), 2) })
    expect(order.state).toBe('waiting')
    // The delivery: CUS with its master.
    const cus = await custom({ videos: 1 })
    const delivered = await ok(await link(order, cus), 201)
    expect(delivered.state).toBe('delivered')
    expect(delivered.parts[0]).toMatchObject({ item_id: cus, complete: true })
    // The catalog knows the order of the CUS.
    const page = await call(server.app, { method: 'GET', url: `/api/v1/lora/i/${cus}`, as: diana })
    expect(page.json().order).toMatchObject({ id: order.id, title: 'Босс' })
    // A revision; the order is «Сдано, требуется правка».
    const revised = await ok(
      await post(`/orders/${order.id}/revisions`, {
        body: { text: 'без музыки', message_url: null },
      }),
      201,
    )
    expect(revised.state).toBe('revision')
    // The fixed master: a new version of the same CUS, delivered again.
    await server.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.actor_type', 'system', true),
                                  set_config('app.actor_label', 'тест', true),
                                  set_config('app.action', 'test', true),
                                  set_config('app.request_id', 'test', true)`)
      const { rows } = await tx.execute<{ model_id: string; asset_id: string; sha: Buffer }>(sql`
        SELECT a.model_id, a.id AS asset_id, v.master_sha256 AS sha
          FROM content_items i
          JOIN item_memberships im ON im.model_id = i.model_id AND im.item_id = i.id
          JOIN assets a ON a.model_id = im.model_id AND a.id = im.asset_id
          JOIN asset_versions v ON v.model_id = a.model_id AND v.id = a.current_version_id
         WHERE i.type = 'CUS' AND i.number = ${Number(cus.split('-')[1])}`)
      const row = rows[0]
      if (!row) throw new Error('no master')
      const sha = Buffer.alloc(32, 7)
      await tx.execute(sql`
        INSERT INTO blobs (sha256, byte_size, mime, ext, media_kind, storage_key)
        VALUES (${sha}, 1000, 'video/mp4', 'mp4', 'video', 'blobs/sha256/07/07/v2')
        ON CONFLICT (sha256) DO NOTHING`)
      const version = randomUUID()
      await tx.execute(sql`
        INSERT INTO asset_versions (model_id, id, asset_id, version_no, master_sha256, duration_ms)
        VALUES (${row.model_id}::uuid, ${version}::uuid, ${row.asset_id}::uuid, 2, ${sha}, 880000)`)
      await tx.execute(sql`
        UPDATE assets SET current_version_id = ${version}::uuid
         WHERE model_id = ${row.model_id}::uuid AND id = ${row.asset_id}::uuid`)
    })
    const refixed = await ok(await link(order, cus), 201)
    expect(refixed.deliveries).toHaveLength(2)
    expect(refixed.state).toBe('revision')
    const revision = refixed.revisions[0]
    if (!revision) throw new Error('no revision')
    const done = await ok(
      await post(`/orders/${order.id}/revisions/${revision.id}:complete`, {
        body: { basis: 'new_version' },
      }),
    )
    expect(done.revisions[0]?.done?.version_label).toBe(`новая версия ${cus}`)
    const closed = await ok(await post(`/orders/${order.id}:close`))
    expect(closed).toMatchObject({ state: 'closed', status: { word: 'закрыт' } })
    // The order's journal: who did what, in order.
    const journal = await call(server.app, {
      method: 'GET',
      url: `/api/v1/lora/journal?order=${order.id}`,
      as: owner,
    })
    expect((journal.json().items as { action: string }[]).map((event) => event.action)).toEqual([
      'orders.close',
      'orders.completeRevision',
      'orders.linkDelivery',
      'orders.addRevision',
      'orders.linkDelivery',
      'orders.create',
    ])
  })
})
