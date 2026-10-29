import { z } from 'zod'
import { InstantSchema, LocalDateSchema, ModelCodeSchema, ThumbRefSchema } from './common'
import { ItemIdSchema, ItemTypeSchema } from './item-type'
import { MarkupStateSchema } from './markup'
import { PageSummaryEntrySchema } from './placement'

export const PpvKindSchema = z.enum(['bundle', 'dm'])
export type PpvKind = z.infer<typeof PpvKindSchema>

export const PPV_KIND_LABEL: Record<PpvKind, string> = {
  bundle: 'бандл',
  dm: 'в личку',
}

export const RawPurposeSchema = z.enum(['fyp', 'ppv', 'mailing', 'unknown'])
export type RawPurpose = z.infer<typeof RawPurposeSchema>

export const RAW_PURPOSE_LABEL: Record<RawPurpose, string> = {
  fyp: 'фупы',
  ppv: 'PPV',
  mailing: 'рассылка',
  unknown: 'неизвестно',
}

/** «Имя фана в ролике»: есть / нет / не знаю. */
export const FanNameSchema = z.enum(['yes', 'no', 'unknown'])
export type FanName = z.infer<typeof FanNameSchema>

/** В строке и на плашке: «имени нет» (Переделка в PPV). */
export const FAN_NAME_LABEL: Record<FanName, string> = {
  yes: 'имя есть',
  no: 'имени нет',
  unknown: 'имя: не знаю',
}

/** Чипы поля «Имя фана в ролике» (DESIGN §4.4): есть / нет / не знаю — везде одни. */
export const FAN_NAME_CHOICE_LABEL: Record<FanName, string> = {
  yes: 'есть',
  no: 'нет',
  unknown: 'не знаю',
}

export const FAN_NAME_CHOICES: readonly { value: FanName; label: string }[] =
  FanNameSchema.options.map((value) => ({ value, label: FAN_NAME_CHOICE_LABEL[value] }))

/**
 * One object of the catalog index (DESIGN §10.2, first resource).
 * Holds every field that instant filters and sorts need; `null` means «не про этот тип».
 */
export const CatalogEntrySchema = z.object({
  id: ItemIdSchema,
  type: ItemTypeSchema,
  title: z.string(),
  /** Необязательное короткое английское название для slug скачивания (naming §4). */
  title_en: z.string().nullish(),
  tags: z.array(z.string()),
  markup: MarkupStateSchema,
  cover: ThumbRefSchema,
  duration_s: z.number().nonnegative().nullable(),
  photo_count: z.int().nonnegative().nullable(),
  video_count: z.int().nonnegative().nullable(),
  version_count: z.int().positive(),
  has_teaser: z.boolean(),
  arrived_on: LocalDateSchema,
  shot_on: LocalDateSchema.nullable(),
  ppv_kind: PpvKindSchema.nullable(),
  raw_purpose: RawPurposeSchema.nullable(),
  /** Custom: PPV made from it (`PPV-076`), or `null` while it is «готов для PPV». */
  ppv_made_as: ItemIdSchema.nullable(),
  fan_name: FanNameSchema.nullable(),
  second_person: z.boolean(),
  delivered_on: LocalDateSchema.nullable(),
  /** Set: frames picked for posting and frames processed. */
  selected_count: z.int().nonnegative().nullable(),
  processed_count: z.int().nonnegative().nullable(),
  /** Life: frames without purpose, for chats (or both), for the feed. */
  life_unassigned: z.int().nonnegative().nullable(),
  life_chat_count: z.int().nonnegative().nullable(),
  life_feed_count: z.int().nonnegative().nullable(),
  steady_content: z.boolean(),
  photo_custom: z.boolean(),
  /** Old numbers and album names found by instant search: `PPV-066`, `S12`. */
  aliases: z.array(z.string()),
  order_id: z.string().nullable(),
  /** Promo collection: channel code and total size. */
  channel: z.string().nullable(),
  size_bytes: z.int().nonnegative().nullable(),
})
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>

/** `GET /api/v1/<model>/index` — the whole catalog, loaded into the browser at once. */
export const CatalogIndexSchema = z.object({
  model: ModelCodeSchema,
  etag: z.string(),
  generated_at: InstantSchema,
  items: z.array(CatalogEntrySchema),
})
export type CatalogIndex = z.infer<typeof CatalogIndexSchema>

/** `GET /api/v1/<model>/index/pages` — «объект × страница», second resource with its own ETag. */
export const PageSummaryIndexSchema = z.object({
  model: ModelCodeSchema,
  etag: z.string(),
  generated_at: InstantSchema,
  entries: z.array(PageSummaryEntrySchema),
})
export type PageSummaryIndex = z.infer<typeof PageSummaryIndexSchema>

/** «Недавние»: objects the current person touched, with the reason for the hover hint. */
export const RecentItemSchema = z.object({
  item_id: ItemIdSchema,
  reason: z.string(),
  at: InstantSchema,
})
export type RecentItem = z.infer<typeof RecentItemSchema>

export const DeletedItemSchema = z.object({
  item_id: ItemIdSchema,
  title: z.string(),
  deleted_at: InstantSchema,
  deleted_by: z.string(),
  merged_into: ItemIdSchema.nullable(),
})
export type DeletedItem = z.infer<typeof DeletedItemSchema>
