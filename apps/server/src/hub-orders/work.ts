import { parseTelegramRef, telegramRefText } from '@contentops/contracts/order-link'
import {
  type Db,
  enqueueWork,
  LeaseLostError,
  type PeriodicStream,
  type Queryable,
  RunnerStoppedError,
  WorkDeferred,
  type WorkHandler,
} from '@contentops/db'
import {
  createHubClient,
  type HubClient,
  type HubCustomOrder,
  HubError,
  type HubOrderReportBody,
  isHubError,
} from '@contentops/hub'
import { sql } from 'drizzle-orm'
import { keepMatters, type MattersOutcome } from './matters'

/**
 * Work `hub_orders` of role `worker` (ecosystem plan 12.11.2026, package N), one stream per
 * model with a Hub page, every 5 minutes and right after a delivery or a retraction:
 *
 * 1. the outbox: every report the hub has not taken goes, the oldest first; it is «sent» only when
 *    the hub answers that it keeps that very event (stored now, or had it), else it is refused
 *    with the hub's words (the card shows it); a failure leaves the rest for the next run;
 * 2. the read: the hub's open orders (`write:customs`), cut to the model's — by the page, by
 *    ContentOps' old order of the import, or by the model's Telegram chats — become the last
 *    read; a read that does not come back keeps the previous one and says why;
 * 3. the matters: ContentOps' findings open and close their matters in the hub.
 *
 * The run itself never fails on the hub: the next interval tries again, and the screen shows
 * the last read with its time and «Hub не ответил».
 */

export const HUB_ORDERS_INTERVAL_MS = 5 * 60_000

export const hubOrderStreamKey = (modelId: string) => `hub-orders:${modelId}`

export type HubOrdersClientFactory = () => HubClient | null

/**
 * The client of the orders: the same key as the poll, short tries — a hub that is away (a
 * deploy) costs one run a few seconds, not minutes of backoff.
 */
export function envHubOrdersClient(env: {
  HUB_BASE_URL?: string | undefined
  HUB_API_KEY?: string | undefined
}): HubOrdersClientFactory {
  const { HUB_BASE_URL: baseUrl, HUB_API_KEY: key } = env
  if (!baseUrl || !key) return () => null
  const client = createHubClient({
    baseUrl,
    key,
    timeoutMs: 20_000,
    retry: { attempts: 2, baseDelayMs: 1_000, maxDelayMs: 5_000 },
  })
  return () => client
}

/** Models with a page of Hub: their orders are read every 5 minutes. */
export async function hubOrderStreams(
  db: Db,
  options: { configured: boolean },
): Promise<PeriodicStream[]> {
  if (!options.configured) return []
  const { rows } = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT m.id FROM models m JOIN accounts a ON a.model_id = m.id
     WHERE a.hub_page_ref IS NOT NULL AND a.archived_at IS NULL AND m.archived_at IS NULL
     ORDER BY m.id`)
  return rows.map((row) => ({
    streamKey: hubOrderStreamKey(row.id),
    kind: 'hub_orders' as const,
    modelId: row.id,
    intervalMs: HUB_ORDERS_INTERVAL_MS,
    priority: 15,
  }))
}

/** A run now, in the caller's transaction: after a delivery, a retraction, «Обновить». */
export async function enqueueHubOrders(q: Queryable, modelId: string, reason: string) {
  return enqueueWork(q, {
    modelId,
    kind: 'hub_orders',
    workKey: `hub-orders:${reason}`,
    streamKey: hubOrderStreamKey(modelId),
    // A person waits for the answer: ahead of the hourly reads in the hub's slot.
    priority: 30,
  })
}

// ---------------------------------------------------------------------------
// Which model an order is of
// ---------------------------------------------------------------------------

export interface ModelMapping {
  /** The hub's page label → the model. */
  byPage: Map<string, string>
  /** The model's code → its id. */
  byCode: Map<string, string>
  /** A Telegram chat of the model's old orders → the models that use it. */
  byChat: Map<string, Set<string>>
}

export async function modelMapping(q: Queryable): Promise<ModelMapping> {
  const { rows: pages } = await q.execute<{ hub: string; model_id: string }>(sql`
    SELECT a.hub_page_ref AS hub, a.model_id FROM accounts a JOIN models m ON m.id = a.model_id
     WHERE a.hub_page_ref IS NOT NULL AND m.archived_at IS NULL`)
  const { rows: models } = await q.execute<{ id: string; code: string }>(sql`
    SELECT id, code FROM models WHERE archived_at IS NULL`)
  const { rows: chats } = await q.execute<{ model_id: string; chat: string }>(sql`
    SELECT DISTINCT model_id, tg_chat AS chat FROM custom_orders`)
  const byChat = new Map<string, Set<string>>()
  for (const row of chats) {
    const set = byChat.get(row.chat) ?? new Set<string>()
    set.add(row.model_id)
    byChat.set(row.chat, set)
  }
  return {
    byPage: new Map(pages.map((row) => [row.hub, row.model_id])),
    byCode: new Map(models.map((row) => [row.code, row.id])),
    byChat,
  }
}

/**
 * The model of an order: its page; an order of no known page — the model of ContentOps' old
 * order it was imported from, else the one model whose old orders came from its Telegram chat.
 * A page ContentOps does not have (Lilly) or an unknown chat — none: the hub's board has it.
 */
export function modelOfOrder(order: HubCustomOrder, mapping: ModelMapping): string | null {
  if (order.pageLabel) return mapping.byPage.get(order.pageLabel) ?? null
  if (order.contentopsRef) {
    const code = order.contentopsRef.split('/')[0] ?? ''
    const id = mapping.byCode.get(code)
    if (id) return id
  }
  const found = new Set<string>()
  for (const ref of order.telegramRefs) {
    const chat = parseTelegramRef(ref)?.chat
    for (const id of chat ? (mapping.byChat.get(chat) ?? []) : []) found.add(id)
  }
  return found.size === 1 ? ([...found][0] ?? null) : null
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function isControl(error: unknown): boolean {
  return (
    error instanceof WorkDeferred ||
    error instanceof LeaseLostError ||
    error instanceof RunnerStoppedError ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

/** A failure of the hub in the words of the screen. */
export function hubFailureWords(error: unknown, at: Date): string {
  const time = at.toLocaleTimeString('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
  })
  if (error instanceof HubError) {
    switch (error.kind) {
      case 'auth_rejected':
        return `Hub не принял ключ ContentOps в ${time}: нужно право write:customs`
      case 'refused':
        return `Hub отказал в ${time}: ${error.code ?? error.status ?? ''}`.trim()
      case 'bad_response':
        return `Hub ответил не по договору в ${time}`
      default:
        return `Hub не ответил в ${time}`
    }
  }
  return `Hub не ответил в ${time}`
}

interface PendingReport extends Record<string, unknown> {
  id: string
  order_code: string
  body: HubOrderReportBody
}

/** The event a report names, as the hub writes it: its eventRef, else its Telegram link. */
function eventOf(body: HubOrderReportBody): string | null {
  if (body.eventRef) return body.eventRef
  const ref = body.message?.telegramRef ? parseTelegramRef(body.message.telegramRef) : null
  return ref ? telegramRefText(ref) : null
}

interface SendOutcome {
  sent: number
  refused: number
  waiting: number
}

async function sendReports(
  db: Db,
  client: HubClient,
  modelId: string,
  signal: AbortSignal,
): Promise<SendOutcome> {
  const { rows } = await db.execute<PendingReport>(sql`
    SELECT id, order_code, body FROM hub_order_reports
     WHERE model_id = ${modelId}::uuid AND state = 'pending'
     ORDER BY created_at, id LIMIT 100`)
  const outcome: SendOutcome = { sent: 0, refused: 0, waiting: 0 }
  for (const [index, report] of rows.entries()) {
    signal.throwIfAborted()
    try {
      const answer = await client.reportCustomOrder(report.order_code, report.body, signal)
      const wanted = eventOf(report.body)
      if (wanted === null || answer.event?.ref !== wanted) {
        // A 200 is not enough: the hub keeps no such event (a note under a link it has another
        // message under, an older hub). Refused in words, never «sent».
        outcome.refused++
        const words = `Hub не сохранил это событие (ответ «${answer.outcome}»): отметьте в Hub вручную`
        await db.execute(sql`
          UPDATE hub_order_reports
             SET state = 'refused', tried_at = now(), attempts = attempts + 1, error = ${words},
                 outcome = ${answer.outcome}, hub_state = ${answer.order.state}
           WHERE model_id = ${modelId}::uuid AND id = ${report.id}::uuid`)
        continue
      }
      outcome.sent++
      await db.execute(sql`
        UPDATE hub_order_reports
           SET state = 'sent', sent_at = now(), tried_at = now(), attempts = attempts + 1,
               error = NULL, outcome = ${answer.outcome}, hub_state = ${answer.order.state}
         WHERE model_id = ${modelId}::uuid AND id = ${report.id}::uuid`)
    } catch (error) {
      if (isControl(error) || !isHubError(error)) throw error
      const words =
        error.kind === 'refused'
          ? `Hub отказал: ${error.message}`
          : hubFailureWords(error, new Date())
      const final = error.kind === 'refused'
      await db.execute(sql`
        UPDATE hub_order_reports
           SET state = ${final ? 'refused' : 'pending'}, tried_at = now(),
               attempts = attempts + 1, error = ${words.slice(0, 500)}
         WHERE model_id = ${modelId}::uuid AND id = ${report.id}::uuid`)
      if (final) {
        outcome.refused++
        continue
      }
      // The hub is away: the rest waits for the next run, in order.
      outcome.waiting = rows.length - index
      break
    }
  }
  return outcome
}

async function readOrders(
  db: Db,
  client: HubClient,
  modelId: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; orders: number; unassigned: number; error: string | null }> {
  try {
    const list = await client.customOrders({ state: 'open', limit: 500 }, signal)
    const mapping = await modelMapping(db)
    const mine: HubCustomOrder[] = []
    let unassigned = 0
    for (const order of list.orders) {
      const model = modelOfOrder(order, mapping)
      if (model === modelId) mine.push(order)
      if (model === null) unassigned++
    }
    await db.execute(sql`
      INSERT INTO hub_order_reads (model_id, read_at, orders, unassigned, tried_at, error)
      VALUES (${modelId}::uuid, now(), ${JSON.stringify(mine)}::jsonb, ${unassigned}, now(), NULL)
      ON CONFLICT (model_id) DO UPDATE
        SET read_at = now(), orders = EXCLUDED.orders, unassigned = EXCLUDED.unassigned,
            tried_at = now(), error = NULL`)
    return { ok: true, orders: mine.length, unassigned, error: null }
  } catch (error) {
    if (isControl(error) || !isHubError(error)) throw error
    const words = hubFailureWords(error, new Date())
    await db.execute(sql`
      INSERT INTO hub_order_reads (model_id, tried_at, error)
      VALUES (${modelId}::uuid, now(), ${words})
      ON CONFLICT (model_id) DO UPDATE SET tried_at = now(), error = EXCLUDED.error`)
    return { ok: false, orders: 0, unassigned: 0, error: error.message }
  }
}

export function hubOrdersHandler(options: { client: HubOrdersClientFactory }): WorkHandler {
  return async ({ work, db, signal }) => {
    const modelId = work.modelId
    if (!modelId) return { report: { skipped: 'no model' } }
    const client = options.client()
    if (!client) return { report: { skipped: 'нет HUB_API_KEY в окружении' } }
    const { rows } = await db.execute<{ code: string }>(sql`
      SELECT code FROM models WHERE id = ${modelId}::uuid`)
    const code = rows[0]?.code ?? ''
    const reports = await sendReports(db, client, modelId, signal)
    const read = await readOrders(db, client, modelId, signal)
    let matters: MattersOutcome | null = null
    if (read.ok) {
      try {
        matters = await keepMatters(db, client, { id: modelId, code }, signal)
      } catch (error) {
        if (isControl(error) || !isHubError(error)) throw error
        matters = { opened: 0, closed: 0, error: error.message }
      }
    }
    return { report: { reports, read, matters } }
  }
}
