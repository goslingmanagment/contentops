import { z } from 'zod'
import {
  AccountCodeSchema,
  ActorRefSchema,
  InstantSchema,
  IsoWeekSchema,
  LocalDateSchema,
  LocalTimeSchema,
  RecordVersionSchema,
  SignSchema,
  ThumbRefSchema,
} from './common'
import { IntegrationLineSchema } from './integrations'
import { ItemIdSchema, ItemTypeSchema } from './item-type'
import { UniqLevelSchema } from './model'
import {
  CancelReasonSchema,
  CopyStateSchema,
  MarkKindSchema,
  PlacementVerdictSchema,
  SurfaceKindSchema,
} from './placement'

export const PersonRefSchema = z.object({ id: z.string(), name: z.string() })
export type PersonRef = z.infer<typeof PersonRefSchema>

/** Amber captions under the title: «слишком рано», «два поста в 20:00», «уже в плане». */
export const PlanWarningSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('too_early'),
    account: AccountCodeSchema,
    days: z.int().nonnegative(),
    text: z.string(),
  }),
  z.object({ kind: z.literal('same_time'), other_item: ItemIdSchema, text: z.string() }),
  z.object({ kind: z.literal('too_close'), other_item: ItemIdSchema, text: z.string() }),
  z.object({ kind: z.literal('already_planned'), date: LocalDateSchema, text: z.string() }),
  z.object({ kind: z.literal('threshold_unset'), text: z.string() }),
])
export type PlanWarning = z.infer<typeof PlanWarningSchema>

/** What a row ships: the object and the chosen version (FYP «версия 1 · мягко»). */
export const PlanManifestSchema = z.object({
  item_id: ItemIdSchema,
  item_type: ItemTypeSchema,
  title: z.string(),
  thumb: ThumbRefSchema,
  fyp_version: z.object({ no: z.int().positive(), level: UniqLevelSchema }).nullable(),
  /** Files of this page with their download names; the key is the download kind. */
  files: z.array(
    z.object({
      key: z.enum(['platform', 'teaser', 'photos']),
      label: z.string(),
      download_name: z.string(),
    }),
  ),
})
export type PlanManifest = z.infer<typeof PlanManifestSchema>

/**
 * Fields for publishing through Hub (5б, decision 29.10.2026): caption, Fansly audience —
 * `tiers` empty for subscribers, price in thousandths of a dollar as Hub has it (a price makes a
 * `paid_post`), the repeat flag; the vault album name is `album` of the row.
 */
export const PlanPublicationSchema = z.object({
  caption: z.string().nullable(),
  tiers: z.array(z.string()).nullable(),
  price_mills: z.int().nonnegative().nullable(),
  repost: z.boolean(),
})
export type PlanPublication = z.infer<typeof PlanPublicationSchema>

export const PlanRowSchema = z.object({
  id: z.string(),
  date: LocalDateSchema,
  /** `null` — «весь день». */
  time: LocalTimeSchema.nullable(),
  account: AccountCodeSchema,
  surface: SurfaceKindSchema,
  /** `null` while the row waits for a montage. */
  manifest: PlanManifestSchema.nullable(),
  awaiting_montage: z
    .object({
      from_item: ItemIdSchema,
      expected_type: z.enum(['fyp', 'ppv', 'teaser']),
      file_keys: z.array(z.string()),
    })
    .nullable(),
  /** Who posts: «Мои» filters by `id`, the group header shows `name`. */
  assignee: PersonRefSchema.nullable(),
  mark: z
    .object({
      kind: MarkKindSchema,
      at: InstantSchema,
      by: ActorRefSchema,
      stated_occurred_at: InstantSchema.nullable(),
      for_current_manifest: z.boolean(),
    })
    .nullable(),
  cancelled: z
    .object({ at: InstantSchema, by: ActorRefSchema, reason: CancelReasonSchema.nullable() })
    .nullable(),
  release_id: z.string().nullable(),
  requires_new_upload: z.boolean(),
  has_newer_version: z.boolean(),
  note: z.string().nullable(),
  album: z.string().nullable(),
  publication: PlanPublicationSchema,
  copy: CopyStateSchema.nullable(),
  downloaded: z
    .object({ at: InstantSchema, by: z.string(), meta_stripped: z.boolean() })
    .nullable(),
  warnings: z.array(PlanWarningSchema),
  /** «Отметить ▾» or «Отметить и подтвердить» (DESIGN §4.11). */
  mark_button: z.enum(['mark', 'mark_confirm']),
  created_by: ActorRefSchema,
  created_at: InstantSchema,
  version: RecordVersionSchema,
  verdict: PlacementVerdictSchema,
})
export type PlanRow = z.infer<typeof PlanRowSchema>

/** Kinds of norm cells: FYP, wall, life in vault, stories. */
export const NormKindSchema = z.enum(['fyp', 'wall', 'life_vault', 'story'])
export type NormKind = z.infer<typeof NormKindSchema>

export const NORM_KIND_LABEL: Record<NormKind, string> = {
  fyp: 'Фуп',
  wall: 'Стена (сет, лайф, бандл)',
  life_vault: 'Лайф в vault',
  story: 'Сториз',
}

/** Week norm of a page as JSON: count per type and weekday, time per type, PPV release apart. */
export const WeekNormSchema = z.object({
  account: AccountCodeSchema,
  cells: z.array(
    z.object({
      kind: NormKindSchema,
      /** Monday first. */
      per_day: z.array(z.int().nonnegative()).length(7),
      time: LocalTimeSchema.nullable(),
    }),
  ),
  release: z
    .object({
      every_weeks: z.int().positive(),
      weekday: z.int().min(0).max(6),
      time: LocalTimeSchema,
    })
    .nullable(),
  usual_assignee: z.string().nullable(),
  uniq_level: UniqLevelSchema,
  version: RecordVersionSchema,
})
export type WeekNorm = z.infer<typeof WeekNormSchema>

/** Kinds of empty places: a norm cell, or the PPV release due «раз в N недель». */
export const GapKindSchema = z.enum([...NormKindSchema.options, 'release'])
export type GapKind = z.infer<typeof GapKindSchema>

/** An empty place of the norm: «Здесь нужен лайф в vault», «Здесь нужен выпуск PPV». */
export const SlotGapSchema = z.object({
  date: LocalDateSchema,
  account: AccountCodeSchema,
  kind: GapKindSchema,
  surface: SurfaceKindSchema,
  time: LocalTimeSchema.nullable(),
  text: z.string(),
})
export type SlotGap = z.infer<typeof SlotGapSchema>

export const ReleaseSchema = z.object({
  id: z.string(),
  item_id: ItemIdSchema,
  date: LocalDateSchema,
  row_ids: z.array(z.string()),
  done: z.int().nonnegative(),
  accounts: z.int().nonnegative(),
})
export type Release = z.infer<typeof ReleaseSchema>

export const DayDotSchema = z.object({
  date: LocalDateSchema,
  sign: SignSchema.nullable(),
})
export type DayDot = z.infer<typeof DayDotSchema>

/** Group of the day by page: «Fansly 1 · LoraVie · Диана» plus the integration line. */
export const PlanAccountGroupSchema = z.object({
  account: AccountCodeSchema,
  assignee: PersonRefSchema.nullable(),
  integration: IntegrationLineSchema.nullable(),
  /** «Hub видел 1 пост без плана · Сверить». */
  unplanned_posts: z.int().nonnegative(),
})
export type PlanAccountGroup = z.infer<typeof PlanAccountGroupSchema>

/** `GET /api/v1/<model>/plan?date=` */
export const PlanDaySchema = z.object({
  date: LocalDateSchema,
  week_dots: z.array(DayDotSchema),
  /** Hub одинаково не работает на всех страницах: одна строка у заголовка дня (§3.11). */
  integration: IntegrationLineSchema.nullable(),
  groups: z.array(PlanAccountGroupSchema),
  rows: z.array(PlanRowSchema),
  gaps: z.array(SlotGapSchema),
  releases: z.array(ReleaseSchema),
  cancelled_count: z.int().nonnegative(),
  download_size_bytes: z.int().nonnegative(),
})
export type PlanDay = z.infer<typeof PlanDaySchema>

export const WeekColumnSchema = z.object({
  account: AccountCodeSchema,
  empty: z.int().nonnegative(),
  missed: z.int().nonnegative(),
  /** Norm in words for the hover hint. */
  norm_hint: z.string(),
  /** Hub of the page when it is not working, phrased without the page: the column names it. */
  integration: IntegrationLineSchema.nullable(),
})
export type WeekColumn = z.infer<typeof WeekColumnSchema>

/** `GET /api/v1/<model>/plan?week=` */
export const PlanWeekSchema = z.object({
  week: IsoWeekSchema,
  dates: z.array(LocalDateSchema).length(7),
  columns: z.array(WeekColumnSchema),
  rows: z.array(PlanRowSchema),
  gaps: z.array(SlotGapSchema),
  releases: z.array(ReleaseSchema),
})
export type PlanWeek = z.infer<typeof PlanWeekSchema>
