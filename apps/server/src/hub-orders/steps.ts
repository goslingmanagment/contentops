import type { HubOrderStepCommand } from '@contentops/contracts/domain/hub-orders'
import type { Db, Queryable } from '@contentops/db'
import { type HubCustomOrder, isHubError, type PersonDoor } from '@contentops/hub'
import { sql } from 'drizzle-orm'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import { type HubOrderRead, NO_GRANT_STEPS } from './view'
import { modelMapping, modelOfOrder } from './work'

/**
 * «Съёмка» AS THE SIGNED-IN PERSON (products plan §2.4, §4.5, package C3): the list and the steps of
 * the content side go through Hub's person's door with the person's live grant (their session's
 * `hub_grant`), never with ContentOps' agent key, so Hub's rights and the test realm's wall are the
 * person's own. The worker's periodic read with the agent key stays for what it serves in the
 * background («Приехало», the placements) and for a person with no grant.
 */

/** The person's grant of Hub's registry, from their session; `null` — an own account, an agent. */
export async function grantOf(q: Queryable, actor: Actor): Promise<string | null> {
  if (actor.type !== 'person' || actor.sessionId === null) return null
  const { rows } = await q.execute<{ hub_grant: string | null }>(sql`
    SELECT hub_grant FROM sessions WHERE id = ${actor.sessionId}::uuid AND revoked_at IS NULL`)
  return rows[0]?.hub_grant ?? null
}

/**
 * The step's answer was lost (a timeout, a cut, Hub's 5xx): Hub may have written it. Its own state,
 * never a refusal and never resent by itself: the person refreshes the order and sees.
 */
export const STEP_OUTCOME_UNKNOWN = 'Ответа нет: неизвестно, записан ли шаг. Обновите заказ'

export function outcomeUnknown(): ApiProblem {
  return new ApiProblem('unavailable', STEP_OUTCOME_UNKNOWN, { outcome: 'unknown' })
}

export function isOutcomeUnknown(error: unknown): boolean {
  return error instanceof ApiProblem && error.details?.outcome === 'unknown'
}

function doorProblem(error: unknown, words: { refused: string }): never {
  if (!isHubError(error)) throw error
  if (error.status === 401)
    throw new ApiProblem('unauthenticated', 'Вход закончился: войдите снова')
  if (error.status === 404) throw new ApiProblem('not_found', 'Такого заказа нет')
  if (error.status === 409 || error.status === 403) throw new ApiProblem('forbidden', words.refused)
  if (error.status === 400) throw new ApiProblem('invalid_request', 'Шаг не принят')
  // No answer that says what became of it: the step may be written.
  throw outcomeUnknown()
}

/** Hub's slug of a model of ContentOps: the reverse of `HUB_MODEL_MAP` (`smoke` → `test`), else its code. */
export function hubSlugOf(modelCode: string, modelMap: Readonly<Record<string, string>>): string {
  const code = modelCode.toLowerCase()
  return Object.entries(modelMap).find(([, to]) => to === code)?.[0] ?? code
}

/**
 * The person's own read: their open orders through the door, of this model BY HUB'S ANSWER — an order
 * with a page is this model's when Hub names this model's slug (`HUB_MODEL_MAP` read backwards), never
 * through the accounts' binding (`hub_page_ref`, which a test model's accounts do not carry); an order
 * of no known page as the background read places it (the old order of the import, the chats). `null`
 * — the person reads the last background read (no door, no grant).
 */
export async function personRead(
  db: Db,
  door: PersonDoor | null,
  model: ModelScope,
  grant: string | null,
  modelMap: Readonly<Record<string, string>> = {},
): Promise<HubOrderRead | null> {
  if (!door || !grant) return null
  let orders: HubCustomOrder[]
  try {
    orders = (await door.customOrders(grant)).orders
  } catch (error) {
    if (isHubError(error) && error.status === 401) {
      throw new ApiProblem('unauthenticated', 'Вход закончился: войдите снова')
    }
    if (!isHubError(error)) throw error
    // The person's own read failed or was refused: said in words, with nothing shown. Never the
    // background read in its place — an old snapshot of another key's read, not the person's orders.
    const now = new Date().toISOString()
    return {
      read_at: null,
      orders: [],
      unassigned: 0,
      tried_at: now,
      error: readFailureWords(error.status),
    }
  }
  const mapping = await modelMapping(db)
  const slug = hubSlugOf(model.code, modelMap)
  const now = new Date().toISOString()
  return {
    read_at: now,
    orders: orders.filter((order) =>
      order.pageLabel !== null
        ? order.modelSlug?.toLowerCase() === slug
        : modelOfOrder(order, mapping) === model.id,
    ),
    unassigned: 0,
    tried_at: now,
    error: null,
  }
}

/** Why the person's own read gave nothing, in words: «Hub не показал заказы: …». */
export function readFailureWords(status: number | null | undefined): string {
  const why =
    status === 403
      ? 'съёмка этой учётной записи не открыта, спросите владельца'
      : status === 404
        ? 'такой модели в Hub нет'
        : 'Hub не ответил, обновите чуть позже'
  return `Hub не показал заказы: ${why}`
}

/**
 * A step of the content side — handed to the model with a deadline, delivered in part, shot, a
 * revision, the model's refusal — written to Hub NOW as the person. Hub decides whose the step is
 * (the model's content manager, else its customs lead, else the owner) and refuses anyone else.
 */
export async function sendHubStep(
  db: Db,
  door: PersonDoor | null,
  code: string,
  body: HubOrderStepCommand,
  actor: Actor,
): Promise<HubCustomOrder> {
  if (actor.type !== 'person' || actor.role === 'reader') {
    throw new ApiProblem('forbidden', 'Шаги заказа делает человек, который ведёт съёмку')
  }
  const grant = await grantOf(db, actor)
  if (!grant) throw new ApiProblem('forbidden', NO_GRANT_STEPS)
  if (!door) throw new ApiProblem('unavailable', 'Не удалось записать шаг: заказы не подключены')
  const note = body.note?.trim() || undefined
  if (body.step === 'refused' && !note) {
    throw new ApiProblem('invalid_request', 'Нужна причина отказа', { field: 'note' })
  }
  try {
    const answer = await door.customOrderStep(grant, {
      code,
      step: body.step,
      ...(body.step === 'at_model' && body.deadline ? { deadlineOn: body.deadline } : {}),
      ...(note ? { note } : {}),
      ...(body.step === 'revision' && body.part ? { part: body.part } : {}),
    })
    return answer.order
  } catch (error) {
    doorProblem(error, {
      refused:
        'Шаг не принят: его ведёт другой человек, или заказ уже на другом шаге. Обновите заказ',
    })
  }
}

/**
 * The hub's answer is the order now: it replaces the order in the last background read, in one
 * statement, where that read has it (a test model's background read has none of the person's).
 */
export async function storeHubOrder(q: Queryable, model: ModelScope, order: HubCustomOrder) {
  await q.execute(sql`
    UPDATE hub_order_reads
       SET orders = (
         SELECT coalesce(jsonb_agg(
                  CASE WHEN one->>'code' = ${order.code} THEN ${JSON.stringify(order)}::jsonb
                       ELSE one END ORDER BY ord), '[]'::jsonb)
           FROM jsonb_array_elements(orders) WITH ORDINALITY AS t(one, ord))
     WHERE model_id = ${model.id}::uuid`)
}
