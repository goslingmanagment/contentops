import type { HubOrder } from '@contentops/contracts/domain/hub-orders'
import { type Db, schema, type Tx, withActorTx } from '@contentops/db'
import type { HubCustomOrder } from '@contentops/hub'
import { and, eq, sql } from 'drizzle-orm'
import { digestOf, journalActor } from '../commands'
import type { Actor, RequestContext } from '../context'
import { ApiProblem } from '../errors'
import { isOutcomeUnknown, outcomeUnknown } from './steps'

/**
 * A step of «Съёмка» written THROUGH HUB once (package C3): the repeat key of the request is taken
 * BEFORE Hub is called, Hub is never called inside a database transaction, and an answer that is
 * lost is its own state — never a refusal, never sent again by itself:
 *
 * 1. the key is claimed in a short transaction of its own: a repeat that finds the stored answer
 *    replays it; one that finds the key claimed with no answer (a step in flight, or one whose
 *    answer was lost) answers «Ответа нет: неизвестно, записан ли шаг. Обновите заказ» — Hub is
 *    not asked again;
 * 2. Hub is called as the person; a definite refusal frees the key (nothing was written: the same
 *    key may try again), a lost answer keeps it claimed with no answer;
 * 3. the order as Hub answered is stored and journaled, and the answer kept under the key.
 *
 * The same pipeline as `command` (commands.ts) but with the outside call between the claim and the
 * write; a request without a key (an older interface) simply runs.
 */
const keys = schema.idempotencyKeys

export async function stepOnce<P>(
  db: Db,
  ctx: RequestContext,
  actor: Actor,
  body: unknown,
  send: () => Promise<HubCustomOrder>,
  /** What the answer needs from outside the database (the person's fresh read): before the write. */
  prepare: () => Promise<P>,
  store: (tx: Tx, order: HubCustomOrder, prepared: P) => Promise<HubOrder>,
): Promise<HubOrder> {
  const journal = { actor: journalActor(actor), action: ctx.route, requestId: ctx.requestId }
  const key = ctx.idempotencyKey
  if (!key) {
    const order = await send()
    const prepared = await prepare()
    return withActorTx(db, journal, (tx) => store(tx, order, prepared))
  }
  const digest = digestOf(ctx, body)
  const where = and(
    eq(keys.principalId, actor.id),
    eq(keys.operation, ctx.route),
    eq(keys.key, key),
  )
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(keys)
      .values({
        modelId: ctx.model?.id ?? null,
        principalId: actor.id,
        operation: ctx.route,
        key,
        requestDigest: digest,
        state: 'committed',
      })
      .onConflictDoNothing({ target: [keys.principalId, keys.operation, keys.key] })
      .returning({ id: keys.id })
    if (row) return row.id
    const [found] = await tx
      .select({ digest: keys.requestDigest, response: keys.response })
      .from(keys)
      .where(where)
    if (!found) throw new Error('idempotency key vanished')
    if (!Buffer.from(found.digest).equals(digest)) {
      throw new ApiProblem('idempotency_conflict', 'Ключ повтора уже использован другим запросом')
    }
    if (found.response) return { replay: (found.response as { body: HubOrder }).body }
    // Claimed and never answered: in flight, or its answer was lost. Never sent again from here.
    throw outcomeUnknown()
  })
  if (typeof claimed !== 'string') return claimed.replay

  let order: HubCustomOrder
  try {
    order = await send()
  } catch (error) {
    // A definite answer (a refusal, a check before the call): nothing was written, the key is free.
    if (!isOutcomeUnknown(error)) await db.delete(keys).where(eq(keys.id, claimed))
    throw error
  }
  // The step is in Hub now: what is read after it is read outside the transaction; a failure of that
  // read leaves the answer to the last background read, never «not written».
  const prepared = await prepare()
  return withActorTx(db, journal, async (tx) => {
    const answer = await store(tx, order, prepared)
    await tx
      .update(keys)
      .set({ committedAt: sql`now()`, response: { body: answer } })
      .where(eq(keys.id, claimed))
    return answer
  })
}
