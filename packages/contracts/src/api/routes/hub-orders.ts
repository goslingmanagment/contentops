import {
  HubOrderListSchema,
  HubOrderSchema,
  LinkHubDeliveryCommandSchema,
  RetractHubDeliveryCommandSchema,
} from '../../domain/hub-orders'
import { defineRoute } from '../route'

/**
 * The hub's custom orders in production (ecosystem plan 12.11.2026, package N): `{code}` is the
 * hub's `K-<n>`. Reads answer from the last read of the hub, never a live call; a delivery and a
 * retraction go to the hub through the outbox and answer with the order as ContentOps has it.
 */
export const hubOrderRoutes = {
  /** «Заказы»: at the model, partly shot, a revision, shot and not given — with their files. */
  list: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/hub-orders',
    response: HubOrderListSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/hub-orders/{code}',
    response: HubOrderSchema,
  }),
  /** «Обновить»: read the hub now and send what waits; answers the last read as it is. */
  refresh: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/hub-orders:refresh',
    response: HubOrderListSchema,
    success: 202,
  }),
  /** «Привязать файл…»: a CUS as a delivery of the order; the hub learns it (`delivery`). */
  linkDelivery: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/hub-orders/{code}/deliveries',
    body: LinkHubDeliveryCommandSchema,
    response: HubOrderSchema,
    success: 201,
  }),
  /** «Отвязать…»: a new record retracts it; the hub gets a note of the order. */
  retractDelivery: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/hub-orders/{code}/deliveries/{delivery}:retract',
    body: RetractHubDeliveryCommandSchema,
    response: HubOrderSchema,
  }),
}
