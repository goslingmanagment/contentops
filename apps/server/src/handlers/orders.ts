import type { OrderTab } from '@contentops/contracts/domain/orders'
import { DEFAULT_PAGE_LIMIT } from '@contentops/contracts/domain/pagination'
import { parseOrderCard } from '@contentops/contracts/order-card'
import type { Queryable, Tx } from '@contentops/db'
import { type SQL, sql } from 'drizzle-orm'
import { modelOf } from '../catalog/ids'
import { filterDigest, readCursor, writeCursor } from '../catalog/paging'
import { requireActor } from '../commands'
import type { Actor, ModelScope, RequestContext } from '../context'
import type { HandlerRegistry } from '../handlers'
import { agentSilence, orderView, orderViews, type ViewContext } from '../orders/view'
import {
  addOrderMessage,
  addRevision,
  cancelOrder,
  closeOrder,
  completeRevision,
  createOrder,
  linkDelivery,
  markPart,
  reopenRevision,
  retractDelivery,
  updateOrder,
} from '../orders/writes'
import type { Services } from '../services'
import { modelViews } from './models'

/**
 * «Кастомы › Заказы» (DESIGN §4.16) and the routine `customs-daily` (SPEC §8.2): the same
 * commands for people and agents; every change answers with the whole order as saved.
 */

const TAB_STATUSES: Record<OrderTab, readonly string[]> = {
  open: ['open', 'delivered'],
  closed: ['closed'],
  cancelled: ['cancelled'],
}

async function viewContext(q: Queryable, ctx: RequestContext): Promise<ViewContext> {
  const model = modelOf(ctx.model)
  const actor = requireActor(ctx)
  const [view] = await modelViews(q, [model.code])
  return { model: { ...model, genitive: view?.name_genitive ?? model.name }, role: actor.role }
}

/** `q` across the buyer, the brief and the card text; `%` and `_` are literal. */
function searchCondition(q: string | undefined): SQL {
  if (!q) return sql`true`
  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`
  return sql`(o.buyer_name ILIKE ${pattern} OR o.brief ILIKE ${pattern}
              OR EXISTS (SELECT 1 FROM custom_order_messages m
                          WHERE m.model_id = o.model_id AND m.order_id = o.id AND m.kind = 'card'
                            AND m.excerpt ILIKE ${pattern}))`
}

export function orderHandlers({ db, command }: Services): HandlerRegistry {
  /** A command on one order, answered with the order as it is after the commit. */
  const onOrder = <T>(
    input: { ctx: RequestContext; body: unknown },
    run: (tx: Tx, model: ModelScope, actor: Actor) => Promise<T>,
    target: string | ((result: T) => string),
  ) =>
    command(input, async (tx, actor) => {
      const model = modelOf(input.ctx.model)
      const result = await run(tx, model, actor)
      const address = typeof target === 'string' ? target : target(result)
      return (await orderView(tx, await viewContext(tx, input.ctx), address)).order
    })

  return {
    orders: {
      list: async ({ query, ctx }) => {
        const context = await viewContext(db, ctx)
        const tab = query.tab ?? 'open'
        const limit = query.limit ?? DEFAULT_PAGE_LIMIT
        const digest = filterDigest(context.model.code, { tab, q: query.q ?? null })
        const cursor = readCursor(query.cursor, digest)
        // `q` finds in every tab at once (DESIGN §4.16).
        const statuses = query.q ? ['open', 'delivered', 'closed', 'cancelled'] : TAB_STATUSES[tab]
        const after = cursor
          ? sql`(o.card_at, o.id) < (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`
          : sql`true`
        const { orders, rows } = await orderViews(
          db,
          context,
          sql`o.status = ANY(${sql.param([...statuses])}::text[]) AND ${searchCondition(query.q)}
              AND ${after}`,
          sql`ORDER BY o.card_at DESC, o.id DESC LIMIT ${limit + 1}`,
        )
        const { rows: counts } = await db.execute<{ status: string; count: number }>(sql`
          SELECT status, count(*)::int AS count FROM custom_orders
           WHERE model_id = ${context.model.id}::uuid GROUP BY status`)
        const count = (...statuses: string[]) =>
          counts
            .filter((row) => statuses.includes(row.status))
            .reduce((sum, row) => sum + row.count, 0)
        const open =
          tab === 'open' && !query.q && !cursor && rows.length <= limit
            ? orders
            : (await orderViews(db, context, sql`o.status IN ('open', 'delivered')`)).orders
        const last = rows[Math.min(rows.length, limit) - 1]
        const actor = requireActor(ctx)
        return {
          items: orders.slice(0, limit),
          next_cursor:
            rows.length > limit && last ? writeCursor([last.card_at, last.id], digest) : null,
          open_count: count('open', 'delivered'),
          closed_count: count('closed'),
          cancelled_count: count('cancelled'),
          overdue_count: open.filter((order) => order.state === 'overdue').length,
          agent_silence:
            actor.role === 'reader'
              ? null
              : await agentSilence(db, context.model, new Date().toISOString()),
        }
      },

      get: async ({ params, ctx }) =>
        (await orderView(db, await viewContext(db, ctx), params.order)).order,

      parseCard: async ({ body, ctx }) => {
        const model = modelOf(ctx.model)
        const [view] = await modelViews(db, [model.code])
        const year = Number(new Date().toISOString().slice(0, 4))
        return parseOrderCard(body.card_text, body.message_url, year, view?.accounts ?? [])
      },

      create: ({ body, ctx }) =>
        onOrder(
          { ctx, body },
          (tx, model, actor) => createOrder(tx, model, body, actor),
          (address) => address,
        ),

      update: ({ params, body, ctx }) =>
        onOrder(
          { ctx, body },
          (tx, model, actor) => updateOrder(tx, ctx, model, params.order, body, actor),
          params.order,
        ),

      markPart: ({ params, body, ctx }) =>
        onOrder(
          { ctx, body },
          (tx, model, actor) =>
            markPart(tx, model, params.order, params.part, body.complete, actor),
          params.order,
        ),

      linkDelivery: ({ params, body, ctx }) =>
        onOrder(
          { ctx, body },
          (tx, model, actor) => linkDelivery(tx, model, params.order, body, actor),
          params.order,
        ),

      retractDelivery: ({ params, body, ctx }) =>
        onOrder(
          { ctx, body },
          (tx, model, actor) =>
            retractDelivery(tx, model, params.order, params.delivery, body.reason, actor),
          params.order,
        ),

      addRevision: ({ params, body, ctx }) =>
        onOrder(
          { ctx, body },
          (tx, model, actor) => addRevision(tx, model, params.order, body, actor),
          params.order,
        ),

      completeRevision: ({ params, body, ctx }) =>
        onOrder(
          { ctx, body },
          (tx, model, actor) =>
            completeRevision(tx, model, params.order, params.revision, body, actor),
          params.order,
        ),

      reopenRevision: ({ params, ctx }) =>
        onOrder(
          { ctx, body: null },
          (tx, model) => reopenRevision(tx, model, params.order, params.revision),
          params.order,
        ),

      addMessage: ({ params, body, ctx }) =>
        onOrder(
          { ctx, body },
          (tx, model, actor) => addOrderMessage(tx, model, params.order, body, actor),
          params.order,
        ),

      close: ({ params, ctx }) =>
        onOrder(
          { ctx, body: null },
          (tx, model, actor) => closeOrder(tx, model, params.order, actor),
          params.order,
        ),

      cancel: ({ params, body, ctx }) =>
        onOrder(
          { ctx, body },
          (tx, model, actor) => cancelOrder(tx, model, params.order, body.reason, actor),
          params.order,
        ),
    },
  }
}
