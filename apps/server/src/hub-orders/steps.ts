import type { HubOrderStepCommand } from '@contentops/contracts/domain/hub-orders'
import type { Db, Queryable } from '@contentops/db'
import { type HubClient, type HubCustomOrder, isHubError } from '@contentops/hub'
import { sql } from 'drizzle-orm'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import { readHubOrders } from './view'

/**
 * «Съёмка» (products plan 13.11, §4.5, package C3): a step of the content side — handed to the
 * model with a deadline, delivered in part, shot, a revision, the model's refusal — written to the
 * hub NOW as the signed-in person (their hub login, `principals.hub_login`). The hub owns the
 * order and decides whose the step is: it refuses whoever does not lead it (the content manager of
 * the model, else its customs lead, else the owner). The answer replaces the order in the last
 * read (`storeHubOrder`), so the screen shows what the hub holds at once. Never through the
 * outbox: a person waits for the hub's yes or no.
 */
export async function sendHubStep(
  db: Db,
  client: HubClient | null,
  model: ModelScope,
  code: string,
  body: HubOrderStepCommand,
  actor: Actor,
): Promise<HubCustomOrder> {
  if (!client) throw new ApiProblem('unavailable', 'Не удалось записать шаг: заказы не подключены')
  if (actor.type !== 'person' || actor.role === 'reader') {
    throw new ApiProblem('forbidden', 'Шаги заказа делает человек, который ведёт съёмку')
  }
  const { rows } = await db.execute<{ hub_login: string | null }>(sql`
    SELECT hub_login FROM principals WHERE id = ${actor.id}::uuid`)
  const login = rows[0]?.hub_login ?? null
  if (!login) {
    throw new ApiProblem('forbidden', 'Шаг пишется в Hub от вашего имени: войдите через Hub')
  }
  const read = await readHubOrders(db, model.id)
  if (!read.orders.some((order) => order.code === code)) {
    throw new ApiProblem('not_found', `Заказа ${code} у этой модели нет`)
  }
  const note = body.note?.trim() || undefined
  if (body.step === 'refused' && !note) {
    throw new ApiProblem('invalid_request', 'Нужна причина отказа', { field: 'note' })
  }
  let order: HubCustomOrder
  try {
    const answer = await client.reportCustomOrder(code, {
      action: 'person_step',
      step: body.step,
      onBehalfOf: login,
      ...(body.step === 'at_model' && body.deadline ? { deadlineOn: body.deadline } : {}),
      ...(note ? { note } : {}),
      ...(body.step === 'revision' && body.part ? { part: body.part } : {}),
    })
    order = answer.order
  } catch (error) {
    if (!isHubError(error)) throw error
    if (error.status === 404) throw new ApiProblem('not_found', `Заказа ${code} нет`)
    if (error.status === 409 || error.status === 403) {
      throw new ApiProblem(
        'forbidden',
        'Шаг не принят: его ведёт другой человек, или заказ уже на другом шаге. Обновите заказ',
      )
    }
    if (error.status === 400) throw new ApiProblem('invalid_request', 'Шаг не принят')
    throw new ApiProblem('unavailable', 'Не удалось записать шаг, попробуйте ещё раз')
  }
  return order
}

/**
 * The hub's answer is the order now: it replaces the order in the last read, in one statement (a
 * read of the worker at the same moment writes the whole list; the next one has the step anyway).
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
