import { z } from 'zod'
import {
  AddToPromoCommandSchema,
  PrepareHandoffCommandSchema,
  RemoveFromCollectionCommandSchema,
} from '../../commands/promo'
import { pageSchema } from '../../domain/pagination'
import {
  ChannelContentsSchema,
  ContractorSchema,
  HandoffOverlapSchema,
  HandoffSchema,
  PromoChannelSchema,
  PromoCollectionSchema,
} from '../../domain/promo'
import { HandoffStartedSchema } from '../responses'
import { defineRoute } from '../route'

/** Promo: channels, collections of links and handoffs to contractors. */
export const promoRoutes = {
  channels: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/promo/channels',
    response: pageSchema(PromoChannelSchema),
  }),
  channel: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/promo/channels/{channel}',
    response: ChannelContentsSchema,
  }),
  collection: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/promo/collections/{collection}',
    response: PromoCollectionSchema,
  }),
  add: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/promo/collections:add',
    body: AddToPromoCommandSchema,
    response: PromoCollectionSchema,
  }),
  remove: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/promo/collections/{collection}:remove',
    body: RemoveFromCollectionCommandSchema,
    response: PromoCollectionSchema,
  }),
  handoffCheck: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/promo/collections/{collection}/handoff-check',
    query: z.object({ contractor: z.string() }),
    response: HandoffOverlapSchema,
  }),
  prepareHandoff: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/promo/collections/{collection}/handoffs',
    body: PrepareHandoffCommandSchema,
    response: HandoffStartedSchema,
    success: 202,
  }),
  markSent: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/promo/collections/{collection}/handoffs/{handoff}:mark-sent',
    response: HandoffSchema,
  }),
  handoffs: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/promo/handoffs',
    response: pageSchema(HandoffSchema),
  }),
  /** Contractors with their remembered format, for «Подрядчик ▾» of a handoff. */
  contractors: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/promo/contractors',
    response: pageSchema(ContractorSchema),
  }),
}
