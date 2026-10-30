import { versionTag } from '@contentops/contracts/api/headers'
import { orderRoutes } from '@contentops/contracts/api/routes/orders'
import type { OrderFields } from '@contentops/contracts/commands/orders'
import { parseDuration, parseOrderCard } from '@contentops/contracts/order-card'
import { computeOrderStatus } from '@contentops/contracts/order-status'
import { notFound, rule } from '../domain-error'
import type { ModelWorld, OrderRecord } from '../fixtures/world-types'
import { type BoundRoute, bind, todayOf } from '../handler'
import type { MockState } from '../state'
import { orderList, orderView } from '../views/orders'
import { actorSays } from './actor-says'

/** Custom orders (DESIGN §4.16): a person creates and edits them with the agent's commands. */

function orderOf(model: ModelWorld, id: string): OrderRecord {
  const order = model.orders.find((candidate) => candidate.id === id)
  if (!order) throw notFound('Такого заказа нет')
  return order
}

function view(state: MockState, model: ModelWorld, order: OrderRecord) {
  return orderView(order, state.clock.now(), model.model.name_genitive, state.principal.role)
}

function applyFields(order: OrderRecord, fields: Partial<OrderFields>) {
  if (fields.title !== undefined) order.title = fields.title
  if (fields.buyer !== undefined) order.buyer = fields.buyer
  if (fields.account !== undefined) order.account = fields.account
  if (fields.brief !== undefined) order.brief = fields.brief
  if (fields.duration_raw !== undefined) {
    const parsed = parseDuration(fields.duration_raw)
    order.duration = {
      raw: fields.duration_raw,
      min_s: parsed?.min_s ?? null,
      max_s: parsed?.max_s ?? null,
    }
  }
  if (fields.wants_video !== undefined) order.wants_video = fields.wants_video
  if (fields.wants_photos !== undefined) order.wants_photos = fields.wants_photos
  if (fields.deadline !== undefined) order.deadline = fields.deadline
  if (fields.fan_name !== undefined) order.fan_name = fields.fan_name
}

function changed(state: MockState, model: ModelWorld, order: OrderRecord) {
  order.version += 1
  return view(state, model, order)
}

export function orderHandlers(): BoundRoute[] {
  return [
    bind(orderRoutes.list, 'read', ({ state, model, query }) =>
      orderList(state.world, model(), state.clock.now(), state.principal.role, query.tab ?? 'open'),
    ),
    bind(
      orderRoutes.get,
      'read',
      ({ state, model, params }) => view(state, model(), orderOf(model(), params.order)),
      {
        etag: (body) => versionTag(body.version),
      },
    ),
    bind(orderRoutes.parseCard, 'staff', ({ body, state, model }) =>
      parseOrderCard(
        body.card_text,
        body.message_url,
        Number(todayOf(state).slice(0, 4)),
        model().model.accounts,
      ),
    ),
    bind(orderRoutes.create, 'staff', (context) => {
      const model = context.model()
      const { body, state } = context
      const now = state.clock.now()
      const parsed = parseDuration(body.duration_raw)
      const order: OrderRecord = {
        id: `tg-manual-${model.orders.length + 1}`,
        title: body.title,
        buyer: body.buyer,
        account: body.account,
        card: {
          url: body.message_url ?? '',
          author: state.principal.name,
          posted_at: now,
          text: body.card_text,
        },
        brief: body.brief,
        duration: {
          raw: body.duration_raw,
          min_s: parsed?.min_s ?? null,
          max_s: parsed?.max_s ?? null,
        },
        wants_video: body.wants_video,
        wants_photos: body.wants_photos,
        deadline: body.deadline,
        fan_name: body.fan_name,
        parts: [
          ...(body.wants_video
            ? [
                {
                  kind: 'video' as const,
                  required: null,
                  delivered: 0,
                  item_id: null,
                  delivered_on: null,
                  duration_s: null,
                },
              ]
            : []),
          ...(body.wants_photos > 0
            ? [
                {
                  kind: 'photos' as const,
                  required: body.wants_photos,
                  delivered: 0,
                  item_id: null,
                  delivered_on: null,
                  duration_s: null,
                },
              ]
            : []),
        ],
        deliveries: [],
        revisions: [],
        messages: body.card_text
          ? [{ at: now, kind: 'card', excerpt: body.card_text.split('\n').slice(0, 2).join(' · ') }]
          : [],
        closed_at: null,
        version: 1,
      }
      model.orders.unshift(order)
      context.log({
        area: 'orders',
        action: 'order.create',
        phrase: `${actorSays(state, 'создал')} заказ «${order.title}»`,
      })
      return view(state, model, order)
    }),
    bind(orderRoutes.update, 'staff', (context) => {
      const model = context.model()
      const order = orderOf(model, context.params.order)
      context.requireVersion(order.version)
      applyFields(order, context.body)
      context.log({
        area: 'orders',
        action: 'order.update',
        phrase: `${actorSays(context.state, 'изменил')} заказ «${order.title}»`,
      })
      return changed(context.state, model, order)
    }),
    bind(orderRoutes.addRevision, 'staff', (context) => {
      const model = context.model()
      const order = orderOf(model, context.params.order)
      if (order.closed_at) throw rule('order_closed', 'Не выполнено: заказ уже закрыт')
      const now = context.state.clock.now()
      order.revisions.push({
        id: `rev-${order.id}-${order.revisions.length + 1}`,
        text: context.body.text,
        message_url: context.body.message_url,
        created_at: now,
        created_by: context.state.actor,
        done: null,
      })
      // A revision with its Telegram message is a significant message of the order.
      if (context.body.message_url) {
        order.messages.push({ at: now, kind: 'revision', excerpt: context.body.text })
      }
      context.log({
        area: 'orders',
        action: 'order.revision.add',
        phrase: `${actorSays(context.state, 'добавил')} правку к заказу «${order.title}»`,
      })
      return changed(context.state, model, order)
    }),
    bind(orderRoutes.completeRevision, 'staff', (context) => {
      const model = context.model()
      const order = orderOf(model, context.params.order)
      const revision = order.revisions.find((candidate) => candidate.id === context.params.revision)
      if (!revision) throw notFound('Такой правки нет')
      const delivered = order.parts.find((part) => part.item_id)?.item_id ?? null
      revision.done = {
        basis: context.body.basis,
        by: context.state.actor,
        at: context.state.clock.now(),
        version_label:
          context.body.basis === 'new_version' && delivered ? `новая версия ${delivered}` : null,
      }
      context.log({
        area: 'orders',
        action: 'order.revision.done',
        phrase: `${actorSays(context.state, 'отметил')} правку выполненной${revision.text ? `: «${revision.text}»` : ''}`,
      })
      return changed(context.state, model, order)
    }),
    bind(orderRoutes.reopenRevision, 'staff', (context) => {
      const model = context.model()
      const order = orderOf(model, context.params.order)
      const revision = order.revisions.find((candidate) => candidate.id === context.params.revision)
      if (!revision) throw notFound('Такой правки нет')
      revision.done = null
      return changed(context.state, model, order)
    }),
    bind(orderRoutes.linkDelivery, 'staff', (context) => {
      const model = context.model()
      const order = orderOf(model, context.params.order)
      const record = model.items.get(context.body.item_id)
      if (record?.entry.type !== 'custom') throw rule('invalid_request', 'Сдача — это кастом')
      const part = order.parts.find((candidate) =>
        record.entry.photo_custom ? candidate.kind === 'photos' : candidate.kind === 'video',
      )
      if (part) {
        part.delivered = record.entry.photo_custom ? (record.entry.photo_count ?? 0) : 1
        part.item_id = record.entry.id
        part.delivered_on = record.entry.delivered_on ?? todayOf(context.state)
        part.duration_s = record.entry.duration_s
      }
      order.deliveries.push({
        id: `dl-${record.entry.id}`,
        item_id: record.entry.id,
        matched: ['привязано вручную'],
        linked_by: context.state.actor,
        confirmed_by: context.state.actor,
        at: context.state.clock.now(),
      })
      record.entry.order_id = order.id
      context.log({
        area: 'orders',
        action: 'order.link',
        phrase: `${actorSays(context.state, 'привязал')} сдачу ${record.entry.id} к заказу «${order.title}»`,
        item_id: record.entry.id,
      })
      return changed(context.state, model, order)
    }),
    bind(orderRoutes.unlinkDelivery, 'staff', (context) => {
      const model = context.model()
      const order = orderOf(model, context.params.order)
      const delivery = order.deliveries.find(
        (candidate) => candidate.id === context.params.delivery,
      )
      if (!delivery) throw notFound('Такой сдачи нет')
      order.deliveries = order.deliveries.filter((candidate) => candidate !== delivery)
      for (const part of order.parts) {
        if (part.item_id !== delivery.item_id) continue
        part.delivered = 0
        part.item_id = null
        part.delivered_on = null
      }
      return changed(context.state, model, order)
    }),
    bind(orderRoutes.close, 'staff', (context) => {
      const model = context.model()
      const order = orderOf(model, context.params.order)
      if (order.closed_at) throw rule('order_closed', 'Не выполнено: заказ уже закрыт')
      const status = computeOrderStatus(order, context.state.clock.now(), model.model.name_genitive)
      if (status.close_block)
        throw rule('order_not_complete', `Не выполнено: ${status.close_block.toLowerCase()}`)
      order.closed_at = context.state.clock.now()
      context.log({
        area: 'orders',
        action: 'order.close',
        phrase: `${actorSays(context.state, 'закрыл')} заказ «${order.title}»`,
      })
      return changed(context.state, model, order)
    }),
  ]
}
