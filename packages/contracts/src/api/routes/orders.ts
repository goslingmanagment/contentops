import { z } from 'zod'
import {
  AddOrderMessageCommandSchema,
  AddRevisionCommandSchema,
  CancelOrderCommandSchema,
  CompleteRevisionCommandSchema,
  LinkDeliveryCommandSchema,
  MarkOrderPartCommandSchema,
  OrderFieldsSchema,
  ParsedOrderCardSchema,
  ParseOrderCardCommandSchema,
  RetractDeliveryCommandSchema,
  UpdateOrderCommandSchema,
} from '../../commands/orders'
import { OrderListSchema, OrderSchema, OrderTabSchema } from '../../domain/orders'
import { PageQuerySchema } from '../../domain/pagination'
import { defineRoute } from '../route'

/**
 * Custom orders, a view of the «Кастомы» folder (SPEC §8.2, DESIGN §4.16). `{order}` is the
 * card's address `tg-<chat>-<topic>-<message>`; every change answers with the whole order.
 */
export const orderRoutes = {
  /** «Открытые» / «Закрытые» / «Снятые»; `q` finds by buyer, brief and card text in all of them. */
  list: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/orders',
    query: PageQuerySchema.extend({
      tab: OrderTabSchema.optional(),
      q: z.string().trim().min(1).optional(),
    }),
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
    response: ParsedOrderCardSchema,
  }),
  /** A card that already has an order answers 422 `order_exists` with its address. */
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
  /** «Видео ✓»: the part is delivered whole, or not yet (`{part}` is `video` or `photos`). */
  markPart: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/orders/{order}/parts/{part}',
    body: MarkOrderPartCommandSchema,
    response: OrderSchema,
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
  /** «Отвязать…»: a new record retracts the delivery; the delivery itself stays. */
  retractDelivery: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/orders/{order}/deliveries/{delivery}:retract',
    body: RetractDeliveryCommandSchema,
    response: OrderSchema,
  }),
  addMessage: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/orders/{order}/messages',
    body: AddOrderMessageCommandSchema,
    response: OrderSchema,
    success: 201,
  }),
  /** Only a delivered order without open revisions (SPEC §5). */
  close: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/orders/{order}:close',
    response: OrderSchema,
  }),
  cancel: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/orders/{order}:cancel',
    body: CancelOrderCommandSchema,
    response: OrderSchema,
  }),
}
