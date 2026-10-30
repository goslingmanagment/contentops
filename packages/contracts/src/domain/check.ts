import { z } from 'zod'
import {
  AccountCodeSchema,
  ActorRefSchema,
  InstantSchema,
  LocalDateSchema,
  LocalTimeSchema,
  ThumbRefSchema,
} from './common'
import { ItemIdSchema } from './item-type'
import type { PlacementLevel } from './placement'
import { PlacementVerdictSchema, SurfaceKindSchema } from './placement'

/** Cases of «Сверить» (DESIGN §4.15, §9.7); one per ◆ level of the placement function. */
export const CheckCaseKindSchema = z.enum([
  'candidate',
  'variants',
  'partial',
  'mismatch',
  'conflict',
  'surface',
  'unplanned',
  'vault_missing',
  'vault_stale',
])
export type CheckCaseKind = z.infer<typeof CheckCaseKindSchema>

export const CHECK_KIND_BY_LEVEL: Partial<Record<PlacementLevel, CheckCaseKind>> = {
  candidate: 'candidate',
  candidates_multiple: 'variants',
  partial_match: 'partial',
  mismatch: 'mismatch',
  conflict: 'conflict',
  surface_unknown: 'surface',
  unplanned_post: 'unplanned',
  vault_missing: 'vault_missing',
  vault_stale: 'vault_stale',
}

/** What Hub saw on the platform side of the pair. */
export const HubPostSchema = z.object({
  evidence_id: z.string(),
  post_at: InstantSchema,
  offset_min: z.number().nullable(),
  /** The post's own composition: «видео 0:09», «видео 9:41 и 2 фото», «22 фото». */
  summary: z.string(),
  /** Length of the post's video in seconds, when Hub knows it: the platform side in numbers. */
  duration_s: z.number().nonnegative().nullable(),
  /** Photos in the post (0 for a video alone), when Hub knows the composition. */
  photo_count: z.int().nonnegative().nullable(),
  caption: z.string().nullable(),
  platform_file_name: z.string().nullable(),
  url: z.string(),
})
export type HubPost = z.infer<typeof HubPostSchema>

export const CheckCaseSchema = z.object({
  id: z.string(),
  kind: CheckCaseKindSchema,
  account: AccountCodeSchema,
  surface: SurfaceKindSchema,
  plan_row_id: z.string().nullable(),
  /** `null` for a post without plan until it is bound. */
  item_id: ItemIdSchema.nullable(),
  title: z.string(),
  /** «FYP-0801 версия 1». */
  version_label: z.string().nullable(),
  thumb: ThumbRefSchema.nullable(),
  slot: z.object({ date: LocalDateSchema, time: LocalTimeSchema.nullable() }).nullable(),
  verdict: PlacementVerdictSchema,
  /** «Пост 03:06 (+6 мин) · видео 0:09 — совпадает». */
  pair_phrase: z.string().nullable(),
  pair_matches: z.boolean().nullable(),
  posts: z.array(HubPostSchema),
  /** k из n: attachments with ✓ / ✗. */
  attachments: z.array(z.object({ no: z.int().positive(), label: z.string(), ok: z.boolean() })),
  album: z.string().nullable(),
  /** Fansly, one variant, equal attachments, time and duration within tolerance. */
  unambiguous: z.boolean(),
  details: z.object({
    issued_name: z.string().nullable(),
    issued_to: z.string().nullable(),
    sizes: z.string().nullable(),
    how_checked: z.array(z.string()),
  }),
  /** «в 23:40 был похожий пост». */
  hint: z.string().nullable(),
})
export type CheckCase = z.infer<typeof CheckCaseSchema>

export const ResolvedCaseSchema = z.object({
  case_id: z.string(),
  item_id: ItemIdSchema.nullable(),
  title: z.string(),
  account: AccountCodeSchema,
  /** «FYP-0801 версия 1». */
  version_label: z.string().nullable(),
  surface: SurfaceKindSchema,
  slot: z.object({ date: LocalDateSchema, time: LocalTimeSchema.nullable() }).nullable(),
  /** The post the decision is about, as Hub saw it: a post without plan is told apart by it. */
  post: HubPostSchema.nullable(),
  by: ActorRefSchema,
  at: InstantSchema,
  /** «осмотренная пара», «отчёт о выполнении», «Не то», «Не наше». */
  how: z.string(),
  how_checked: z.array(z.string()),
})
export type ResolvedCase = z.infer<typeof ResolvedCaseSchema>

/** «Hub не смог проверить 38» with groups by reason. */
export const UnverifiedSummarySchema = z.object({
  total: z.int().nonnegative(),
  groups: z.array(z.object({ reason: z.string(), count: z.int().nonnegative() })),
})
export type UnverifiedSummary = z.infer<typeof UnverifiedSummarySchema>

/**
 * A row inside «Hub не смог проверить» (`GET …/reconcile/unverified`): nothing to do, it is
 * shown only on «Почему». `case_id` links the row to its case, if there is one.
 */
export const UnverifiedRowSchema = z.object({
  id: z.string(),
  case_id: z.string().nullable(),
  reason: z.string(),
  item_id: ItemIdSchema.nullable(),
  title: z.string(),
  thumb: ThumbRefSchema.nullable(),
  account: AccountCodeSchema,
  surface: SurfaceKindSchema,
  slot: z.object({ date: LocalDateSchema, time: LocalTimeSchema.nullable() }).nullable(),
})
export type UnverifiedRow = z.infer<typeof UnverifiedRowSchema>

/** `GET /api/v1/<model>/reconcile` */
export const CheckListSchema = z.object({
  items: z.array(CheckCaseSchema),
  next_cursor: z.string().nullable(),
  unverified: UnverifiedSummarySchema,
  resolved_count: z.int().nonnegative(),
  not_ours_count: z.int().nonnegative(),
  unambiguous_ids: z.array(z.string()),
})
export type CheckList = z.infer<typeof CheckListSchema>

/**
 * «Подтвердить однозначные · N»: the result of every pair «по каждой записи» (DESIGN §3.3)
 * with its new verdict, so the rows turn grey in place instead of jumping away.
 */
export const CaseBatchResultSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      ok: z.boolean(),
      code: z.string().nullable(),
      verdict: PlacementVerdictSchema.nullable(),
    }),
  ),
})
export type CaseBatchResult = z.infer<typeof CaseBatchResultSchema>
