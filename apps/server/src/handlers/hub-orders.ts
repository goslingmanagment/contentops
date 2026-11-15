import { HubOrderCodeSchema } from '@contentops/contracts/domain/hub-orders'
import type { Queryable } from '@contentops/db'
import { modelOf } from '../catalog/ids'
import { requireActor } from '../commands'
import type { RequestContext } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { grantOf, personRead, sendHubStep, storeHubOrder } from '../hub-orders/steps'
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

export function hubOrderHandlers({ db, command, secrets, personDoor }: Services): HandlerRegistry {
  // A registry built without services (the route tests) has no secrets: nothing configured.
  const configured = secrets?.hub === true
  const hubBase = secrets?.hubBaseUrl ?? null

  /**
   * The screen's context: a person signed in over Hub's grant reads their own orders through the door
   * (fresh, their realm) and is offered steps; an own account with no grant reads the last background
   * read and the words instead of the steps (package C3).
   */
  async function context(
    q: Queryable,
    ctx: RequestContext,
    options: { fresh?: boolean } = {},
  ): Promise<HubOrderContext> {
    const model = modelOf(ctx.model)
    const actor = requireActor(ctx)
    const [view] = await modelViews(q, [model.code])
    const grant = await grantOf(q, actor)
    const read =
      options.fresh === false ? null : await personRead(db, personDoor ?? null, model, grant)
    return {
      model: { ...model, genitive: view?.name_genitive ?? model.name },
      role: actor.role,
      hubBase,
      ...(read ? { read } : {}),
      steps:
        actor.type !== 'person' || actor.role === 'reader' ? 'none' : grant ? 'person' : 'no_grant',
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

      step: async ({ params, body, ctx }) => {
        const code = codeOf(params.code)
        const model = modelOf(ctx.model)
        // The hub first, as the person: it says yes or no; then the order as it answered, journaled.
        const order = await sendHubStep(db, personDoor ?? null, code, body, requireActor(ctx))
        return command({ ctx, body }, async (tx) => {
          await storeHubOrder(tx, model, order)
          return hubOrderView(tx, await context(tx, ctx), code)
        })
      },

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
