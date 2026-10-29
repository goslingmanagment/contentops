import { z } from 'zod'
import {
  AddRevisionCommandSchema,
  CompleteRevisionCommandSchema,
  LinkDeliveryCommandSchema,
  OrderFieldsSchema,
  ParseOrderCardCommandSchema,
  UpdateOrderCommandSchema,
} from '../../commands/orders'
import { OrderListSchema, OrderSchema } from '../../domain/orders'
import { defineRoute } from '../route'

/** Custom orders, a view of the «Кастомы» folder. */
export const orderRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/orders',
    query: z.object({ tab: z.enum(['open', 'closed']).optional() }),
    response: OrderListSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/orders/{order}',
    response: OrderSchema,
    versioned: true,
  }),
  parseCard: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/orders:parse',
    body: ParseOrderCardCommandSchema,
    response: OrderFieldsSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/orders',
    body: OrderFieldsSchema,
    response: OrderSchema,
    success: 201,
  }),
  update: defineRoute({
    method: 'PATCH',
    path: '/api/v1/{model}/orders/{order}',
    body: UpdateOrderCommandSchema,
    response: OrderSchema,
    versioned: true,
  }),
  addRevision: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/orders/{order}/revisions',
    body: AddRevisionCommandSchema,
    response: OrderSchema,
    success: 201,
  }),
  completeRevision: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/orders/{order}/revisions/{revision}:complete',
    body: CompleteRevisionCommandSchema,
    response: OrderSchema,
  }),
  reopenRevision: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/orders/{order}/revisions/{revision}:reopen',
    response: OrderSchema,
  }),
  linkDelivery: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/orders/{order}/deliveries',
    body: LinkDeliveryCommandSchema,
    response: OrderSchema,
    success: 201,
  }),
  unlinkDelivery: defineRoute({
    method: 'DELETE',
    path: '/api/v1/{model}/orders/{order}/deliveries/{delivery}',
    response: OrderSchema,
  }),
  close: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/orders/{order}:close',
    response: OrderSchema,
  }),
}
