import { versionTag } from '@contentops/contracts/api/headers'
import { orderRoutes } from '@contentops/contracts/api/routes/orders'
import type { UpdateOrderCommand } from '@contentops/contracts/commands/orders'
import { orderTitleOf, parseDuration, parseOrderCard } from '@contentops/contracts/order-card'
import { orderAddress, parseTelegramRef, telegramUrl } from '@contentops/contracts/order-link'
import { computeOrderStatus } from '@contentops/contracts/order-status'
import { notFound, rule } from '../domain-error'
import type { ModelWorld, OrderRecord } from '../fixtures/world-types'
import { type BoundRoute, bind, todayOf } from '../handler'
import type { MockState } from '../state'
import { orderFacts, orderList, orderView } from '../views/orders'
import { actorSays } from './actor-says'

/**
 * Custom orders (DESIGN §4.16) in the prototype's world. The product answers these routes on
 * the server (stage 4б); the mock keeps the screens' tests and `?demo=` running.
 */

function orderOf(model: ModelWorld, id: string): OrderRecord {
  const order = model.orders.find((candidate) => candidate.id === id)
  if (!order) throw notFound('Такого заказа нет')
  return order
}

function view(state: MockState, model: ModelWorld, order: OrderRecord) {
  return orderView(order, state.clock.now(), model.model.name_genitive, state.principal.role)
}

function applyFields(order: OrderRecord, fields: UpdateOrderCommand) {
  if (fields.buyer !== undefined) order.buyer = fields.buyer
  if (fields.account !== undefined) order.account = fields.account
  if (fields.brief !== undefined) {
    order.brief = fields.brief
    order.title = orderTitleOf(fields.brief)
  }
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

function requireOpen(order: OrderRecord) {
  if (order.closed_at) throw rule('order_closed', 'Не выполнено: заказ уже закрыт')
  if (order.cancelled) throw rule('order_closed', 'Не выполнено: заказ снят')
}

export function orderHandlers(): BoundRoute[] {
  return [
    bind(orderRoutes.list, 'read', ({ state, model, query }) =>
      orderList(
        state.world,
        model(),
        state.clock.now(),
        state.principal.role,
        query.tab ?? 'open',
        query.q,
      ),
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
      const ref = parseTelegramRef(body.message_url)
      if (!ref) throw rule('invalid_request', 'Нужна ссылка на карточку в Telegram')
      const id = orderAddress(ref)
      if (model.orders.some((order) => order.id === id)) {
        throw rule('order_exists', 'По этой карточке заказ уже заведён')
      }
      const now = state.clock.now()
      const parsed = parseDuration(body.duration_raw)
      const order: OrderRecord = {
        id,
        title: orderTitleOf(body.brief),
        buyer: body.buyer,
        account: body.account,
        card: {
          url: telegramUrl(ref),
          author: body.card_author ?? '',
          posted_at: body.card_at ?? now,
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
    bind(orderRoutes.markPart, 'staff', (context) => {
      const model = context.model()
      const order = orderOf(model, context.params.order)
      requireOpen(order)
      const part = order.parts.find((candidate) => candidate.kind === context.params.part)
      if (!part) throw notFound('Такой части в заказе нет')
      part.complete = context.body.complete
      part.completed_by = context.body.complete ? context.state.actor : null
      return changed(context.state, model, order)
    }),
    bind(orderRoutes.addRevision, 'staff', (context) => {
      const model = context.model()
      const order = orderOf(model, context.params.order)
      requireOpen(order)
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
      requireOpen(order)
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
        delete part.complete
      }
      order.deliveries.push({
        id: `dl-${record.entry.id}-${order.deliveries.length + 1}`,
        item_id: record.entry.id,
        part: part?.kind ?? 'video',
        matched: context.body.matched ?? ['привязано вручную'],
        linked_by: context.state.actor,
        confirmed_by: context.body.confirmed ? context.state.actor : null,
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
    bind(orderRoutes.retractDelivery, 'staff', (context) => {
      const model = context.model()
      const order = orderOf(model, context.params.order)
      requireOpen(order)
      const delivery = order.deliveries.find(
        (candidate) => candidate.id === context.params.delivery,
      )
      if (!delivery) throw notFound('Такой сдачи нет')
      delivery.retracted = {
        at: context.state.clock.now(),
        by: context.state.actor,
        reason: context.body.reason,
      }
      for (const part of order.parts) {
        if (part.item_id !== delivery.item_id) continue
        part.delivered = 0
        part.item_id = null
        part.delivered_on = null
        delete part.complete
      }
      return changed(context.state, model, order)
    }),
    bind(orderRoutes.addMessage, 'staff', (context) => {
      const model = context.model()
      const order = orderOf(model, context.params.order)
      order.messages.push({
        at: context.body.at,
        kind: context.body.kind,
        excerpt: context.body.excerpt,
        author: context.body.author,
      })
      return changed(context.state, model, order)
    }),
    bind(orderRoutes.close, 'staff', (context) => {
      const model = context.model()
      const order = orderOf(model, context.params.order)
      requireOpen(order)
      const now = context.state.clock.now()
      const status = computeOrderStatus(orderFacts(order, now), now, model.model.name_genitive)
      if (status.close_block)
        throw rule('order_not_complete', `Не выполнено: ${status.close_block.toLowerCase()}`)
      order.closed_at = now
      context.log({
        area: 'orders',
        action: 'order.close',
        phrase: `${actorSays(context.state, 'закрыл')} заказ «${order.title}»`,
      })
      return changed(context.state, model, order)
    }),
    bind(orderRoutes.cancel, 'staff', (context) => {
      const model = context.model()
      const order = orderOf(model, context.params.order)
      if (order.closed_at) throw rule('order_closed', 'Не выполнено: заказ уже закрыт')
      order.cancelled = { at: context.state.clock.now(), reason: context.body.reason }
      context.log({
        area: 'orders',
        action: 'order.cancel',
        phrase: `${actorSays(context.state, 'снял')} заказ «${order.title}»`,
      })
      return changed(context.state, model, order)
    }),
  ]
}
