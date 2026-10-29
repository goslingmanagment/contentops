import { z } from 'zod'
import { FanNameSchema } from '../domain/catalog'
import { AccountCodeSchema, LocalDateSchema } from '../domain/common'
import { ItemIdSchema } from '../domain/item-type'
import { RevisionBasisSchema } from '../domain/orders'

/** Fields of an order as the «Новый заказ» form checks them after parsing the card. */
export const OrderFieldsSchema = z.object({
  title: z.string().trim().min(1, 'Нужно название'),
  buyer: z.string().trim().nullable(),
  account: AccountCodeSchema,
  brief: z.string().nullable(),
  duration_raw: z.string(),
  wants_video: z.boolean(),
  wants_photos: z.int().nonnegative(),
  deadline: LocalDateSchema.nullable(),
  fan_name: FanNameSchema,
  message_url: z.string().nullable(),
  card_text: z.string().nullable(),
})
export type OrderFields = z.infer<typeof OrderFieldsSchema>

/** Step one of «Новый заказ»: paste the card text, get the fields back. */
export const ParseOrderCardCommandSchema = z.object({
  card_text: z.string().trim().min(1, 'Вставьте текст карточки'),
  message_url: z.string().nullable(),
})
export type ParseOrderCardCommand = z.infer<typeof ParseOrderCardCommandSchema>

export const UpdateOrderCommandSchema = OrderFieldsSchema.partial()
export type UpdateOrderCommand = z.infer<typeof UpdateOrderCommandSchema>

export const AddRevisionCommandSchema = z.object({
  text: z.string().trim().min(1, 'Опишите правку'),
  message_url: z.string().nullable(),
})
export type AddRevisionCommand = z.infer<typeof AddRevisionCommandSchema>

export const CompleteRevisionCommandSchema = z.object({ basis: RevisionBasisSchema })
export type CompleteRevisionCommand = z.infer<typeof CompleteRevisionCommandSchema>

export const LinkDeliveryCommandSchema = z.object({ item_id: ItemIdSchema })
export type LinkDeliveryCommand = z.infer<typeof LinkDeliveryCommandSchema>
