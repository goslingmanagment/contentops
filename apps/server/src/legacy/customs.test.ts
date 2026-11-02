import { randomUUID } from 'node:crypto'
import { type Order, OrderSchema } from '@contentops/contracts/domain/orders'
import { SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import type { LegacyListingEntry } from '@contentops/legacy'
import { recordingRetry } from '@contentops/sources/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchHandler } from '../intake/fetch'
import { drain, type IntakeHarness, intakeHarness, LORA_ROOT, setSwitch } from '../intake/testing'
import { createLogger } from '../logger'
import type { BlobStore } from '../media/storage'
import { registerBlob } from '../media/storage-ops'
import { tempStore } from '../media/testing'
import { buildServer } from '../server'
import { call, newKey, signIn } from '../testing/server'
import { autoAcceptForDraft } from './auto-accept'
import { enqueueImport } from './parse'
import { snapshotOf } from './snapshot'
import { freezeDisk, plantDisk, runImport, runQueued } from './testing'

/**
 * Old customs and the orders made from their cards (SPEC §6.3, §8.2; PLAN этап 7) through the
 * real import: the model's line links, the buyer's name links when he is alone, the brief alone
 * asks «Какой заказ?», a short or earlier file finds no order; an order made after its custom
 * takes it; a repeat changes no row. Fan names here are invented.
 */

let h: IntakeHarness
let store: BlobStore
let app: ReturnType<typeof buildServer>
let owner: string

const ctx = () => ({ actor: SYSTEM_ACTOR('test'), action: 'test', requestId: randomUUID() })

const file = (path: string): LegacyListingEntry => ({
  path: `disk:/3. Customs/${path}`,
  isDir: false,
  size: 2000 + path.length,
  createdAt: '2026-08-01T10:00:00+00:00',
})

const DISK: LegacyListingEntry[] = [
  file('12:40 гимнастика.mov'),
  file('9:10 Феликс.mov'),
  file('5:00 вся в зелёном.mov'),
  file('7:00 пахнущие кеды.mov'),
  file('12:00 Лиам.mov'),
  file('2:00 Рекс.mov'),
]

let cards = 0
const cardLink = () => `https://t.me/c/2627984998/3/${5000 + ++cards}`

async function newOrder(fields: Record<string, unknown>): Promise<Order> {
  const response = await call(app, {
    method: 'POST',
    url: '/api/v1/lora/orders',
    as: owner,
    key: newKey(),
    body: {
      message_url: cardLink(),
      card_author: 'Чаттер',
      card_at: '2026-07-20T10:00:00Z',
      buyer: null,
      account: null,
      brief: 'Танец у окна',
      duration_raw: '5 минут',
      wants_video: true,
      wants_photos: 0,
      deadline: null,
      fan_name: 'unknown',
      card_text: null,
      ...fields,
    },
  })
  if (response.statusCode !== 201) throw new Error(`order: ${response.body}`)
  return OrderSchema.parse(response.json())
}

async function modelLine(order: Order, text: string, message: number) {
  const response = await call(app, {
    method: 'POST',
    url: `/api/v1/lora/orders/${order.id}/messages`,
    as: owner,
    key: newKey(),
    body: {
      message_url: `https://t.me/c/2627984998/3/${message}`,
      kind: 'delivery',
      at: '2026-08-01T09:00:00Z',
      author: 'Модель',
      excerpt: text,
    },
  })
  if (response.statusCode >= 300) throw new Error(`line: ${response.body}`)
}

const orders: Record<string, Order> = {}

beforeAll(async () => {
  h = await intakeHarness()
  store = await tempStore('legacy-customs')
  await setSwitch(h.db, 'ydisk.scan', h.modelId, true)
  plantDisk(h.yandex.tree, LORA_ROOT, DISK)
  expect((await freezeDisk(h, '2026-11-02')).state).toBe('succeeded')
  app = buildServer({
    db: h.db,
    publicUrl: 'http://localhost:5173',
    secrets: { hub: false },
    sourceEnv: {},
    logger: createLogger({ level: 'silent' }),
    storage: store.roots,
  })
  await app.ready()
  owner = await signIn(app, 'owner', 'owner-password')
  expect((await runImport(h.db, h.modelId, 'parse')).state).toBe('succeeded')

  // The agent's pass over the old cards, before the customs import (PLAN этап 7).
  orders.dance = await newOrder({ brief: 'Гимнастика на ковре', duration_raw: '10 минут' })
  await modelLine(orders.dance, '12:40 гимнастика', 9001)
  orders.felix = await newOrder({
    buyer: 'https://fansly.com/felix_rw/posts',
    card_text: 'Покупатель: https://fansly.com/felix_rw/posts\nИмя: Felix',
    brief: 'Душ и пена',
    duration_raw: '8 минут',
  })
  orders.red1 = await newOrder({ brief: 'Зелёное платье у окна' })
  orders.red2 = await newOrder({ brief: 'Зелёный свет, зелёное бельё' })
  orders.rex = await newOrder({ buyer: 'Rex', brief: 'Йога', duration_raw: '10 минут' })
}, 120_000)
afterAll(async () => {
  await app?.close()
  await h?.close()
})

async function bytes() {
  const { work } = await withActorTx(h.db, ctx(), async (tx) => {
    const snapshot = await snapshotOf(tx, h.modelId, null)
    if (!snapshot) throw new Error('no snapshot')
    return enqueueImport(tx, {
      modelId: h.modelId,
      mode: 'bytes',
      snapshot,
      nonce: randomUUID(),
      input: { roots: ['3. Customs'], folder: null, force: true },
    })
  })
  return runQueued(h.db, work.id)
}

/** The media works of a real stack for every fetched draft, and the hook that follows. */
async function readyAll() {
  const { rows } = await h.db.execute<{ id: string; sha: string; path: string }>(sql`
    SELECT id, encode(source_sha256, 'hex') AS sha, path FROM inbox_drafts
     WHERE state IN ('discovered', 'processing') AND source_sha256 IS NOT NULL
       AND blocked_reason IS NULL ORDER BY path`)
  for (const draft of rows) {
    const staged = await store.staged(draft.sha)
    if (!staged) throw new Error(`nothing staged for ${draft.path}`)
    await registerBlob(h.db, store, {
      file: staged.path,
      sha256: draft.sha,
      ext: staged.ext,
      mediaKind: 'video',
      owner: 'test:',
    })
    await withActorTx(h.db, ctx(), async (tx) => {
      await tx.execute(sql`
        UPDATE inbox_drafts
           SET master_sha256 = source_sha256, master_is_source = true, master_verified_at = now(),
               state = 'ready', ready_at = now()
         WHERE id = ${draft.id}::uuid`)
      await tx.transaction((inner) => autoAcceptForDraft(inner, h.modelId, draft.id))
    })
  }
}

async function customOf(name: string) {
  const { rows } = await h.db.execute<{
    item: string | null
    group: string
    blocked: string | null
    queue: string | null
  }>(sql`
    SELECT public_item_id(i.type, i.number) AS item, g.id AS group, d.blocked_reason AS blocked,
           g.evidence ->> 'queue' AS queue
      FROM inbox_drafts d JOIN inbox_groups g ON g.id = d.group_id
      LEFT JOIN content_items i ON i.id = d.applied_item_id
     WHERE d.path LIKE ${`%/${name}%`}`)
  return rows[0]
}

async function deliveries() {
  const { rows } = await h.db.execute<{ item: string; order: string; signals: string[] }>(sql`
    SELECT public_item_id(i.type, i.number) AS item, o.tg_message_id::text AS order,
           d.basis -> 'signals' AS signals
      FROM custom_order_deliveries d JOIN content_items i ON i.id = d.item_id
      JOIN custom_orders o ON o.id = d.order_id
     WHERE d.retracts_id IS NULL ORDER BY 1`)
  return rows
}

const messageOf = (order: Order) => order.id.split('-').at(-1)

/** Rows a repeat could change: all but the works and their journal. */
async function footprint() {
  const { rows } = await h.db.execute(sql`SELECT
    (SELECT count(*) FROM content_items)::int AS items,
    (SELECT count(*) FROM custom_order_deliveries)::int AS deliveries,
    (SELECT count(*) FROM inbox_draft_candidates)::int AS candidates,
    (SELECT sum(row_version) FROM inbox_drafts)::int AS drafts,
    (SELECT sum(row_version) FROM custom_orders)::int AS orders,
    (SELECT count(*) FROM action_log WHERE entry_kind = 'change'
      AND subject_kind NOT IN ('work_operations'))::int AS changes`)
  return rows[0]
}

describe('the customs import with the orders of the old cards', () => {
  it('links by the model line and by a lone buyer, asks on the brief, finds none for the rest', async () => {
    expect((await bytes()).state).toBe('succeeded')
    const fetch = fetchHandler({
      factory: h.factory,
      store,
      fetchAheadGb: 25,
      retry: recordingRetry({ attempts: 1 }).policy,
    })
    await drain(h.db, ['fetch'], { fetch })
    await readyAll()

    const linked = await deliveries()
    const dance = await customOf('12:40 гимнастика')
    const felix = await customOf('9:10 Феликс')
    expect(linked).toHaveLength(2)
    expect(linked).toContainEqual(
      expect.objectContaining({ item: dance?.item, order: messageOf(orders.dance as Order) }),
    )
    expect(linked).toContainEqual(
      expect.objectContaining({ item: felix?.item, order: messageOf(orders.felix as Order) }),
    )
    const byLine = linked.find((row) => row.item === dance?.item)
    expect(byLine?.signals).toContain('строка модели «12:40 гимнастика»')
    const byBuyer = linked.find((row) => row.item === felix?.item)
    expect(byBuyer?.signals).toContain('покупатель в имени: «феликс»')

    // The brief alone: ◆ «Какой заказ?» with both red orders, the group waits.
    const red = await customOf('5:00 вся в зелёном')
    expect(red).toMatchObject({ item: null, blocked: 'ambiguous_order', queue: 'ambiguous_order' })
    const { rows: asked } = await h.db.execute<{
      order: string
      signals: Record<string, true>
    }>(sql`
      SELECT o.tg_message_id::text AS order, c.signals FROM inbox_draft_candidates c
        JOIN inbox_drafts d ON d.id = c.draft_id JOIN custom_orders o ON o.id = c.order_id
       WHERE d.group_id = ${red?.group}::uuid AND c.kind = 'order' ORDER BY 1`)
    expect(asked.map((row) => row.order)).toEqual(
      [messageOf(orders.red1 as Order), messageOf(orders.red2 as Order)].sort(),
    )
    expect(Object.keys(asked[0]?.signals ?? {})).toContain('в ТЗ: «зеленом»')

    // No evidence, or a custom shorter than the order: accepted alone, no stub order.
    for (const name of ['7:00 пахнущие кеды', '12:00 Лиам', '2:00 Рекс']) {
      expect((await customOf(name))?.item).toMatch(/^CUS-\d+$/)
    }
  })

  it('the journal names the import as the author of the link', async () => {
    const { rows } = await h.db.execute<{ actor: string; type: string }>(sql`
      SELECT actor_label AS actor, actor_type AS type FROM action_log
       WHERE subject_kind = 'custom_orders' AND entry_kind = 'action'
         AND after::text LIKE '%Сдача%' ORDER BY id`)
    expect(rows).toEqual([
      { actor: 'импорт', type: 'system' },
      { actor: 'импорт', type: 'system' },
    ])
  })

  it('an order made after its custom takes it; the person who made it stays the author', async () => {
    const liam = await newOrder({
      buyer: 'Liam (u481516)',
      brief: 'Танец',
      duration_raw: '10 минут',
    })
    const item = (await customOf('12:00 Лиам'))?.item
    expect(liam.deliveries).toEqual([
      expect.objectContaining({
        item_id: item,
        matched: expect.arrayContaining(['покупатель в имени: «лиам»']),
      }),
    ])
    expect(liam.state).toBe('delivered')
    const { rows } = await h.db.execute<{ actor: string }>(sql`
      SELECT actor_label AS actor FROM action_log
       WHERE subject_kind = 'custom_orders' AND entry_kind = 'action' ORDER BY id DESC LIMIT 2`)
    expect(rows.map((row) => row.actor)).toEqual(['импорт', 'Владелец'])
  })

  it('a person answers «Какой заказ?» and accepts the delivery', async () => {
    const red = await customOf('5:00 вся в зелёном')
    const decided = await call(app, {
      method: 'POST',
      url: `/api/v1/lora/inbox/groups/${red?.group}:decide`,
      as: owner,
      key: newKey(),
      body: { decision: 'which_order', order_id: (orders.red2 as Order).id },
    })
    expect(decided.statusCode).toBe(200)
    const accepted = await call(app, {
      method: 'POST',
      url: `/api/v1/lora/inbox/groups/${red?.group}:accept`,
      as: owner,
      key: newKey(),
      body: { as: 'default' },
    })
    expect(accepted.statusCode).toBe(200)
    const item = accepted.json().item_id as string
    expect(await deliveries()).toContainEqual(
      expect.objectContaining({ item, order: messageOf(orders.red2 as Order) }),
    )
  })

  it('a repeat of the import changes no row', async () => {
    const before = await footprint()
    const again = await bytes()
    expect(again.report).toMatchObject({
      groups_new: 0,
      drafts_new: 0,
      accepted_now: 0,
      orders_linked: 0,
    })
    expect(await footprint()).toEqual(before)
  })
})
