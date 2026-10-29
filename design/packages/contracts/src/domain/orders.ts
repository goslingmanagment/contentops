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

/** States of an order (DESIGN §5.5). */
export const OrderStateSchema = z.enum([
  'waiting',
  'partial',
  'delivered',
  'revision',
  'overdue',
  'closed',
])
export type OrderState = z.infer<typeof OrderStateSchema>

export const OrderPartSchema = z.object({
  kind: z.enum(['video', 'photos']),
  /** Photos ordered; `null` for the video part. */
  required: z.int().nonnegative().nullable(),
  delivered: z.int().nonnegative(),
  item_id: ItemIdSchema.nullable(),
  delivered_on: LocalDateSchema.nullable(),
  duration_s: z.number().nonnegative().nullable(),
})
export type OrderPart = z.infer<typeof OrderPartSchema>

export const OrderDeliverySchema = z.object({
  id: z.string(),
  item_id: ItemIdSchema,
  /** «ответ на карточку», «слова в имени файла», «15:37 ≈ 15 мин», «раздел Customs». */
  matched: z.array(z.string()),
  linked_by: ActorRefSchema,
  confirmed_by: ActorRefSchema.nullable(),
  at: InstantSchema,
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
    })
    .nullable(),
})
export type OrderRevision = z.infer<typeof OrderRevisionSchema>

export const OrderMessageSchema = z.object({
  at: InstantSchema,
  kind: z.enum(['card', 'repost', 'delivery', 'revision']),
  excerpt: z.string(),
})
export type OrderMessage = z.infer<typeof OrderMessageSchema>

/** A custom order, as the Telegram card describes it. */
export const OrderSchema = z.object({
  /** `tg-<chat>-<topic>-<message>`. */
  id: z.string(),
  title: z.string(),
  /** Buyer as a number, never a name in the prototype: «фан №1482». */
  buyer: z.string().nullable(),
  account: AccountCodeSchema,
  card: z.object({
    /** Link to the card in Telegram; empty when there is none or it is hidden from the reader. */
    url: z.string(),
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
  }
  return labels[state]
}

/** `GET /api/v1/<model>/orders` */
export const OrderListSchema = z.object({
  items: z.array(OrderSchema),
  next_cursor: z.string().nullable(),
  open_count: z.int().nonnegative(),
  closed_count: z.int().nonnegative(),
  overdue_count: z.int().nonnegative(),
  /** Only for the owner: «Агент заказов не отмечался 2 дня». */
  agent_silence: z.string().nullable(),
})
export type OrderList = z.infer<typeof OrderListSchema>
