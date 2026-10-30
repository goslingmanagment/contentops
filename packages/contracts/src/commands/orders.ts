import { z } from 'zod'
import { FanNameSchema } from '../domain/catalog'
import { AccountCodeSchema, InstantSchema, LocalDateSchema } from '../domain/common'
import { ItemIdSchema } from '../domain/item-type'
import { OrderPartKindSchema, RevisionBasisSchema } from '../domain/orders'

/**
 * Commands of custom orders (SPEC §8.2, DESIGN §4.16). People and the routine
 * `customs-daily` use the same ones; an agent's change is marked by its actor in the journal.
 */

/** What the card says, as the «Новый заказ» form shows it after parsing the text. */
const OrderCardFieldsSchema = z.object({
  buyer: z.string().trim().nullable(),
  /** The page the card names; `null` when it does not say. */
  account: AccountCodeSchema.nullable(),
  /** ТЗ: the order's title is taken from it. */
  brief: z.string().trim().min(1, 'Нужно ТЗ'),
  /** «8-10 минут», «10 минут - 20 фото»; empty when the card has no duration. */
  duration_raw: z.string(),
  wants_video: z.boolean(),
  /** Photos ordered; 0 — no photos. */
  wants_photos: z.int().nonnegative(),
  /** «до 19.09»: the order is late after the end of this day in Moscow. */
  deadline: LocalDateSchema.nullable(),
  fan_name: FanNameSchema,
  /** Who posted the card (the chatter) and when; unknown in the form — empty and now. */
  card_author: z.string().trim().nullable().optional(),
  card_at: InstantSchema.nullable().optional(),
})

/** An order wants a video, photos or both (schema §9.2). */
export function orderWantsSomething(fields: { wants_video: boolean; wants_photos: number }) {
  return fields.wants_video || fields.wants_photos > 0
}

/** «Новый заказ» and the routine: the card link is the order's address and is required. */
export const OrderFieldsSchema = OrderCardFieldsSchema.extend({
  message_url: z
    .string({ error: 'Нужна ссылка на карточку' })
    .trim()
    .min(1, 'Нужна ссылка на карточку'),
  card_text: z.string().nullable(),
}).refine(orderWantsSomething, { message: 'Нужно видео или фото', path: ['wants_video'] })
export type OrderFields = z.infer<typeof OrderFieldsSchema>

/** Step one of «Новый заказ»: paste the card text, get the fields back. */
export const ParseOrderCardCommandSchema = z.object({
  card_text: z.string().trim().min(1, 'Вставьте текст карточки'),
  message_url: z.string().nullable(),
})
export type ParseOrderCardCommand = z.infer<typeof ParseOrderCardCommandSchema>

/** What the card parser found: the form checks it before saving. */
export const ParsedOrderCardSchema = OrderCardFieldsSchema.extend({
  brief: z.string().nullable(),
  message_url: z.string().nullable(),
  card_text: z.string().nullable(),
})
export type ParsedOrderCard = z.infer<typeof ParsedOrderCardSchema>

/**
 * Fields of the order, each on its own: an agent does not overwrite a field a person edited
 * last (SPEC §8.2) — such a change is refused with `edited_by_person`.
 */
export const UpdateOrderCommandSchema = OrderCardFieldsSchema.partial()
export type UpdateOrderCommand = z.infer<typeof UpdateOrderCommandSchema>

export const AddRevisionCommandSchema = z.object({
  text: z.string().trim().min(1, 'Опишите правку'),
  /** The message with the request; `null` when it came another way. */
  message_url: z.string().trim().nullable(),
  /** One message may carry several requirements: 1, 2, … */
  ordinal: z.int().min(1).optional(),
  /** When it was asked; now when omitted. */
  requested_at: InstantSchema.nullable().optional(),
})
export type AddRevisionCommand = z.infer<typeof AddRevisionCommandSchema>

export const CompleteRevisionCommandSchema = z.object({
  basis: RevisionBasisSchema,
  /**
   * «новая версия»: the delivery that fixed it; the last live delivery after the request when
   * omitted. A new version alone does not close a revision (SPEC §8.2).
   */
  delivery_id: z.string().nullable().optional(),
})
export type CompleteRevisionCommand = z.infer<typeof CompleteRevisionCommandSchema>

/**
 * A delivery of an accepted CUS (SPEC §8.2, schema §3.7): the current versions of its files of
 * the part are sealed in a composition. The intake transaction writes the same record when a
 * draft is accepted with an order chosen.
 */
export const LinkDeliveryCommandSchema = z.object({
  item_id: ItemIdSchema,
  /** By the files when omitted: a CUS with videos and photos gives two deliveries. */
  part: OrderPartKindSchema.nullable().optional(),
  /**
   * When the files appeared: the time of the Telegram message for a delivery from Telegram.
   * Omitted — from the source of the files (`remote_created_at`, else the upload time).
   */
  delivered_at: InstantSchema.nullable().optional(),
  /** The message that brought it, kept as a significant message. */
  message_url: z.string().trim().nullable().optional(),
  /** Which signals matched: reply, words of the file name, section, duration, window. */
  matched: z.array(z.string().trim().min(1)).optional(),
  /** `tg:…`, paths, resource ids. */
  evidence: z.array(z.string().trim().min(1)).optional(),
  /**
   * The link was ambiguous and the caller confirms it: «подтвердила Диана» or, for an agent,
   * «подтверждено агентом» (SPEC §11.1).
   */
  confirmed: z.boolean().optional(),
  /**
   * Is the part delivered whole now. Omitted: photos — when the ordered number came; video —
   * yes. Several clips ordered: `false` until the last one came.
   */
  complete: z.boolean().nullable().optional(),
})
export type LinkDeliveryCommand = z.infer<typeof LinkDeliveryCommandSchema>

export const RetractDeliveryCommandSchema = z.object({
  reason: z.string().trim().min(1, 'Нужна причина'),
})
export type RetractDeliveryCommand = z.infer<typeof RetractDeliveryCommandSchema>

/** The part delivered whole, or not yet (SPEC §8.2, schema §9.2). */
export const MarkOrderPartCommandSchema = z.object({ complete: z.boolean() })
export type MarkOrderPartCommand = z.infer<typeof MarkOrderPartCommandSchema>

/** «Снять…»: return, the fan's refusal, a duplicate card — the reason is required (SPEC §5). */
export const CancelOrderCommandSchema = z.object({
  reason: z.string().trim().min(1, 'Нужна причина'),
})
export type CancelOrderCommand = z.infer<typeof CancelOrderCommandSchema>

/** A significant message: a repost of the card, a delivery, a revision, a confirmation. */
export const AddOrderMessageCommandSchema = z.object({
  message_url: z.string().trim().min(1),
  kind: z.enum(['repost', 'delivery', 'revision', 'confirmation', 'note']),
  at: InstantSchema,
  author: z.string().trim().min(1),
  excerpt: z.string().trim().min(1),
})
export type AddOrderMessageCommand = z.infer<typeof AddOrderMessageCommandSchema>
