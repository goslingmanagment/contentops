import { z } from 'zod'
import {
  AccountCodeSchema,
  ActorRefSchema,
  InstantSchema,
  LocalDateSchema,
  StatusWordSchema,
} from './common'
import { ItemIdSchema } from './item-type'
import { OrderPartKindSchema } from './orders'

/**
 * The hub's custom orders in ContentOps (ecosystem plan 12.11.2026, package N; SPEC §8.2). The
 * order's home is Agency Hub: it is born there (`K-<n>`), moves there, is given to the fan and
 * closed there. ContentOps shows the orders that are in production with the files it holds for
 * them and tells the hub what a file means; its own orders stay as history («Архив заказов»).
 */

/** The hub's states (hub `CUSTOM_ORDER_STATES`). */
export const HubOrderStateSchema = z.enum([
  'recorded',
  'paid',
  'at_model',
  'partly',
  'shot',
  'revision',
  'refused',
  'given',
  'closed',
  'cancelled',
])
export type HubOrderState = z.infer<typeof HubOrderStateSchema>

/** In production — what «Заказы» shows: at the model, partly shot, a revision, shot and not given. */
export const HUB_PRODUCTION_STATES: readonly HubOrderState[] = [
  'at_model',
  'partly',
  'revision',
  'shot',
]

/** The order's code in the hub: `K-123`, never one of ContentOps' `CUS-217`. */
export const HubOrderCodeSchema = z.string().regex(/^K-[1-9]\d{0,15}$/)
export type HubOrderCode = z.infer<typeof HubOrderCodeSchema>

/** What the hub knows of a delivery or a retraction ContentOps reported. */
export const HubReportSchema = z.object({
  /** `pending` — not in the hub yet (retried), `sent` — the hub took it, `refused` — it said no. */
  state: z.enum(['pending', 'sent', 'refused']),
  /** When the hub took it, or the last attempt. */
  at: InstantSchema.nullable(),
  /** The hub's refusal or the last failure in words. */
  error: z.string().nullable(),
  /** The hub kept nothing new: the same step or message was there already. */
  unchanged: z.boolean(),
})
export type HubReport = z.infer<typeof HubReportSchema>

/** A file ContentOps holds for a hub order: one part of a CUS. */
export const HubOrderFileSchema = z.object({
  id: z.string(),
  item_id: ItemIdSchema,
  part: OrderPartKindSchema,
  /** The part is whole with it (several clips: not until the last one). */
  complete: z.boolean(),
  files: z.int().nonnegative(),
  /** When the model delivered: the message, else when the files appeared in the source. */
  delivered_at: InstantSchema,
  linked_at: InstantSchema,
  linked_by: ActorRefSchema,
  /** The Telegram message that brought it; empty for «Только чтение». */
  message_url: z.string().nullable(),
  retracted: z
    .object({ at: InstantSchema, by: ActorRefSchema, reason: z.string().nullable() })
    .nullable(),
  /** A delivery of ContentOps' old order (before the hub): kept there, never reported. */
  archive_order: z.string().nullable(),
  /** What the hub knows of it; `null` — an old delivery from the archive. */
  report: HubReportSchema.nullable(),
  retraction_report: HubReportSchema.nullable(),
})
export type HubOrderFile = z.infer<typeof HubOrderFileSchema>

export const HubOrderMessageSchema = z.object({
  kind: z.enum(['repost', 'delivery', 'revision', 'confirmation', 'note']),
  part: OrderPartKindSchema.nullable(),
  at: InstantSchema.nullable(),
  author: z.string().nullable(),
  /** `null` for «Только чтение», which sees no order texts. */
  excerpt: z.string().nullable(),
  url: z.string().nullable(),
  /** A revision request: when it was fixed; `null` — still open. */
  done_at: InstantSchema.nullable(),
})
export type HubOrderMessage = z.infer<typeof HubOrderMessageSchema>

/** A hub order as a production card of ContentOps. */
export const HubOrderSchema = z.object({
  code: HubOrderCodeSchema,
  state: HubOrderStateSchema,
  state_at: InstantSchema,
  /** The state in words, computed by the server: «у модели», «снято — отдать фану». */
  status: StatusWordSchema,
  /** The task's first line. */
  title: z.string(),
  /** ContentOps' page of the hub's page; `null` — the hub does not know the page. */
  account: AccountCodeSchema.nullable(),
  hub_page: z.string().nullable(),
  /** The fan or the buyer as the card names them; `null` for «Только чтение». */
  buyer: z.string().nullable(),
  /** The card as the hub prints it, with the code; `null` for «Только чтение». */
  card_text: z.string().nullable(),
  duration: z.string().nullable(),
  deadline: LocalDateSchema.nullable(),
  overdue_days: z.int().positive().nullable(),
  wants_video: z.boolean(),
  wants_photos: z.int().nonnegative(),
  /** The parts the hub has as delivered whole. */
  parts_done: z.array(OrderPartKindSchema),
  open_revisions: z.int().nonnegative(),
  /** The order's messages in the models' groups as the hub keeps them, newest first. */
  messages: z.array(HubOrderMessageSchema),
  /** The first Telegram card of the order; empty for «Только чтение». */
  card_url: z.string().nullable(),
  /** The order on the hub's board «Кастомы». */
  hub_url: z.string().nullable(),
  /** ContentOps' old order of the same card (`tg-…`), in the archive. */
  archive_order: z.string().nullable(),
  files: z.array(HubOrderFileSchema),
  /** Reports of its files the hub has not taken yet. */
  pending_reports: z.int().nonnegative(),
  version: z.int().positive(),
})
export type HubOrder = z.infer<typeof HubOrderSchema>

/** `GET /api/v1/<model>/hub-orders`: the last read of the hub, never a live call. */
export const HubOrderListSchema = z.object({
  items: z.array(HubOrderSchema),
  /** The hub's key and address are in the environment. */
  configured: z.boolean(),
  /** The last read that came back; `null` — never read yet. */
  read_at: InstantSchema.nullable(),
  /** The last read did not come back: «Hub не ответил …»; `null` — it did. */
  read_error: z.string().nullable(),
  /** A read is queued or running. */
  refreshing: z.boolean(),
  /** Open hub orders no model could be told for: they are on the hub's board. */
  unassigned: z.int().nonnegative(),
  /** The hub's board «Кастомы»: «Новый заказ» is made there. */
  board_url: z.string().nullable(),
})
export type HubOrderList = z.infer<typeof HubOrderListSchema>

/** «Привязать файл…»: a CUS of the model becomes a delivery of the hub order. */
export const LinkHubDeliveryCommandSchema = z.object({
  item_id: ItemIdSchema,
  /** By the files when omitted: a CUS with videos and photos gives two deliveries. */
  part: OrderPartKindSchema.nullable().optional(),
  /**
   * The part is whole now. Omitted: video — yes; photos — when the ordered number came.
   * Several clips ordered: `false` until the last one.
   */
  complete: z.boolean().nullable().optional(),
  /** The Telegram message that brought it: the hub keeps the delivery under it. */
  message_url: z.string().trim().nullable().optional(),
  /** When the model delivered; omitted — the message, else the source of the files. */
  delivered_at: InstantSchema.nullable().optional(),
})
export type LinkHubDeliveryCommand = z.infer<typeof LinkHubDeliveryCommandSchema>

export const RetractHubDeliveryCommandSchema = z.object({
  reason: z.string().trim().min(1, 'Нужна причина'),
})
export type RetractHubDeliveryCommand = z.infer<typeof RetractHubDeliveryCommandSchema>
