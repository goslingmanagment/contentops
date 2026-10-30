import { z } from 'zod'
import { FanNameSchema } from './catalog'
import {
  AccountCodeSchema,
  ActorRefSchema,
  InstantSchema,
  LocalDateSchema,
  RecordVersionSchema,
  StatusWordSchema,
} from './common'
import { ItemIdSchema } from './item-type'

/**
 * States of an order on screen (DESIGN §5.5). The stored status is `open → delivered →
 * closed` or `cancelled` (SPEC §5); «правка», «просрочено», «сдано частично» are computed by
 * the server from deliveries, revisions, the deadline and the delivery dates.
 */
export const OrderStateSchema = z.enum([
  'waiting',
  'partial',
  'delivered',
  'revision',
  'overdue',
  'closed',
  'cancelled',
])
export type OrderState = z.infer<typeof OrderStateSchema>

export const OrderPartKindSchema = z.enum(['video', 'photos'])
export type OrderPartKind = z.infer<typeof OrderPartKindSchema>

export const OrderPartSchema = z.object({
  kind: OrderPartKindSchema,
  /** Photos ordered; `null` for the video part and for photos without a number. */
  required: z.int().nonnegative().nullable(),
  /** Distinct files of the part in the live deliveries: clips or photos. */
  delivered: z.int().nonnegative(),
  item_id: ItemIdSchema.nullable(),
  /** Day the last live delivery of the part appeared in the source (not when it was accepted). */
  delivered_on: LocalDateSchema.nullable(),
  duration_s: z.number().nonnegative().nullable(),
  /**
   * The part is delivered whole (SPEC §8.2): several clips are one part «видео», marked when
   * all of them came; photos — when the ordered number came.
   */
  complete: z.boolean(),
  completed_by: ActorRefSchema.nullable(),
})
export type OrderPart = z.infer<typeof OrderPartSchema>

export const OrderDeliverySchema = z.object({
  id: z.string(),
  item_id: ItemIdSchema,
  part: OrderPartKindSchema,
  /** «ответ на карточку», «слова в имени файла», «15:37 ≈ 15 мин», «раздел Customs». */
  matched: z.array(z.string()),
  /** Where the facts come from: `tg:…` messages, paths, resource ids. */
  evidence: z.array(z.string()),
  linked_by: ActorRefSchema,
  /** «подтвердила: Диана»; an agent's confirmation is «подтверждено агентом» (SPEC §11.1). */
  confirmed_by: ActorRefSchema.nullable(),
  /** When it was linked. */
  at: InstantSchema,
  /** When the files appeared in the source or the message was sent: the overdue date. */
  delivered_at: InstantSchema,
  files: z.int().nonnegative(),
  /** A wrong link is retracted by a new record, the delivery stays in the history. */
  retracted: z
    .object({ at: InstantSchema, by: ActorRefSchema, reason: z.string().nullable() })
    .nullable(),
})
export type OrderDelivery = z.infer<typeof OrderDeliverySchema>

export const RevisionBasisSchema = z.enum(['checked', 'new_version'])
export type RevisionBasis = z.infer<typeof RevisionBasisSchema>

export const OrderRevisionSchema = z.object({
  id: z.string(),
  /** «без музыки, только звук комнаты»; `null` for «Только чтение», which sees no order texts. */
  text: z.string().nullable(),
  message_url: z.string().nullable(),
  created_at: InstantSchema,
  created_by: ActorRefSchema,
  done: z
    .object({
      basis: RevisionBasisSchema,
      by: ActorRefSchema,
      at: InstantSchema,
      /** «новая версия CUS-195». */
      version_label: z.string().nullable(),
      /** The delivery that fixed it, when the basis is a new version. */
      delivery_id: z.string().nullable(),
    })
    .nullable(),
})
export type OrderRevision = z.infer<typeof OrderRevisionSchema>

export const OrderMessageKindSchema = z.enum([
  'card',
  'repost',
  'delivery',
  'revision',
  'confirmation',
  'note',
])
export type OrderMessageKind = z.infer<typeof OrderMessageKindSchema>

export const OrderMessageSchema = z.object({
  at: InstantSchema,
  kind: OrderMessageKindSchema,
  excerpt: z.string(),
  author: z.string(),
  /** The message in Telegram; `null` when the reference is not a Telegram link. */
  url: z.string().nullable(),
})
export type OrderMessage = z.infer<typeof OrderMessageSchema>

/** A custom order, as the Telegram card describes it. */
export const OrderSchema = z.object({
  /** `tg-<chat>-<topic>-<message>`: the card is the order's address (SPEC §4.1). */
  id: z.string(),
  /** Short name from the brief: «вся в красном». */
  title: z.string(),
  /** Buyer as the card names them; `null` for «Только чтение». */
  buyer: z.string().nullable(),
  account: AccountCodeSchema.nullable(),
  card: z.object({
    /** Link to the card in Telegram; empty when it is hidden from the reader. */
    url: z.string(),
    /** `tg:<chat>/<topic>/<message>`. */
    ref: z.string(),
    author: z.string(),
    posted_at: InstantSchema,
    text: z.string().nullable(),
  }),
  brief: z.string().nullable(),
  duration: z.object({
    raw: z.string(),
    min_s: z.number().nonnegative().nullable(),
    max_s: z.number().nonnegative().nullable(),
  }),
  wants_video: z.boolean(),
  wants_photos: z.int().nonnegative(),
  deadline: LocalDateSchema.nullable(),
  fan_name: FanNameSchema,
  parts: z.array(OrderPartSchema),
  deliveries: z.array(OrderDeliverySchema),
  revisions: z.array(OrderRevisionSchema),
  messages: z.array(OrderMessageSchema),
  closed_at: InstantSchema.nullable(),
  /** «снят»: a return, the fan's refusal, a wrong card; the reason is required (SPEC §5). */
  cancelled: z
    .object({ at: InstantSchema, by: ActorRefSchema, reason: z.string().nullable() })
    .nullable(),
  /**
   * Days past the deadline while the order is not delivered; a draft in «Приехало» that
   * chose this order already counts as its part's delivery (SPEC §8.2). `null` — not overdue.
   */
  overdue_days: z.int().nonnegative().nullable(),
  /** Delivered after the deadline by the source date of the files: days late, else `null`. */
  late_days: z.int().positive().nullable(),
  /** A draft in «Приехало» chose this order and is not accepted yet. */
  in_inbox: z.boolean(),
  created_by: ActorRefSchema.nullable(),
  version: RecordVersionSchema,
  state: OrderStateSchema,
  status: StatusWordSchema,
  /** Why «Закрыть заказ» is not available yet, in words; `null` when it is. */
  close_block: z.string().nullable(),
})
export type Order = z.infer<typeof OrderSchema>

export const ORDER_GROUP_ORDER: readonly OrderState[] = [
  'overdue',
  'revision',
  'waiting',
  'partial',
  'delivered',
]

/** Group headers of the orders list; «Ждём от Лоры» takes the model name in genitive. */
export function orderGroupLabel(state: OrderState, modelGenitive: string): string {
  const labels: Record<OrderState, string> = {
    overdue: 'Просрочено',
    revision: 'Правка',
    waiting: `Ждём от ${modelGenitive}`,
    partial: 'Сдано частично',
    delivered: 'Сдано — можно закрыть',
    closed: 'Закрытые',
    cancelled: 'Снятые',
  }
  return labels[state]
}

export const OrderTabSchema = z.enum(['open', 'closed', 'cancelled'])
export type OrderTab = z.infer<typeof OrderTabSchema>

/** `GET /api/v1/<model>/orders` */
export const OrderListSchema = z.object({
  items: z.array(OrderSchema),
  next_cursor: z.string().nullable(),
  open_count: z.int().nonnegative(),
  closed_count: z.int().nonnegative(),
  cancelled_count: z.int().nonnegative(),
  overdue_count: z.int().nonnegative(),
  /** Owner and managers: «Агент заказов не отмечался 2 дня». */
  agent_silence: z.string().nullable(),
})
export type OrderList = z.infer<typeof OrderListSchema>
