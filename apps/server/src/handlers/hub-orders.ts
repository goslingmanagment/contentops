import { HubOrderCodeSchema } from '@contentops/contracts/domain/hub-orders'
import type { Queryable } from '@contentops/db'
import { modelOf } from '../catalog/ids'
import { requireActor } from '../commands'
import type { RequestContext } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { type HubOrderContext, hubOrderList, hubOrderView } from '../hub-orders/view'
import { enqueueHubOrders } from '../hub-orders/work'
import { linkHubDelivery, retractHubDelivery } from '../hub-orders/writes'
import type { Services } from '../services'
import { modelViews } from './models'

/**
 * «Кастомы › Заказы» since the order's home is the hub (ecosystem plan 12.11.2026, package N):
 * the hub's orders in production as ContentOps' cards with their files; ContentOps' own orders
 * stay as history (`orders.*`, «Архив заказов»). People and agents use the same commands.
 */

function codeOf(raw: string): string {
  const parsed = HubOrderCodeSchema.safeParse(raw.trim().toUpperCase().replace(/^К/, 'K'))
  if (!parsed.success) throw new ApiProblem('not_found', 'Код заказа Hub — K-<число>')
  return parsed.data
}

export function hubOrderHandlers({ db, command, secrets }: Services): HandlerRegistry {
  // A registry built without services (the route tests) has no secrets: nothing configured.
  const configured = secrets?.hub === true
  const hubBase = secrets?.hubBaseUrl ?? null

  async function context(q: Queryable, ctx: RequestContext): Promise<HubOrderContext> {
    const model = modelOf(ctx.model)
    const actor = requireActor(ctx)
    const [view] = await modelViews(q, [model.code])
    return {
      model: { ...model, genitive: view?.name_genitive ?? model.name },
      role: actor.role,
      hubBase,
    }
  }

  return {
    hubOrders: {
      list: async ({ ctx }) => hubOrderList(db, await context(db, ctx), { configured }),

      get: async ({ params, ctx }) => hubOrderView(db, await context(db, ctx), codeOf(params.code)),

      refresh: ({ ctx }) =>
        command({ ctx, body: null }, async (tx) => {
          const model = modelOf(ctx.model)
          if (configured) await enqueueHubOrders(tx, model.id, `refresh:${ctx.requestId}`)
          return hubOrderList(tx, await context(tx, ctx), { configured })
        }),

      linkDelivery: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const code = codeOf(params.code)
          const model = modelOf(ctx.model)
          await linkHubDelivery(tx, model, code, body, actor, ctx.requestId)
          return hubOrderView(tx, await context(tx, ctx), code)
        }),

      retractDelivery: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx) => {
          const code = codeOf(params.code)
          const model = modelOf(ctx.model)
          await retractHubDelivery(tx, model, code, params.delivery, body, ctx.requestId)
          return hubOrderView(tx, await context(tx, ctx), code)
        }),
    },
  }
}
