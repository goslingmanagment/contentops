import { z } from 'zod'
import { InstantSchema } from './common'
import { PublicationsHubStateSchema } from './publications-screen'

/**
 * «Статистика» (products plan §2.4, package C2): ContentOps' own screen over Hub's Fansly numbers of a model's page —
 * which media are watched, bought and commented. Read AS THE SIGNED-IN PERSON through Hub's person's door, one Fansly
 * page at a time; Hub cuts the pages (the owner every page, a content manager her models'). Nothing is stored here.
 */

export const StatsDaysSchema = z.union([
  z.literal(7),
  z.literal(30),
  z.literal(90),
  z.literal(180),
  z.literal(365),
])
export type StatsDays = z.infer<typeof StatsDaysSchema>

export const StatsScreenQuerySchema = z.object({
  page: z.string().min(1).max(100).optional(),
  days: z.coerce
    .number()
    .int()
    .refine((value) => [7, 30, 90, 180, 365].includes(value))
    .default(30),
})

/** UTC days of Fansly's statistics, as Hub counts them. */
export const StatsWindowSchema = z.object({
  from_day: z.string(),
  to_day: z.string(),
  days: z.int(),
})

const count = z.number().nullable()

/** What names a media: kind (1 photo, 2 video), length, post, dates, the post's text. */
const MediaHeadShape = {
  media_offer_id: z.string(),
  media_type: z.int().nullable(),
  duration_ms: z.number().nullable(),
  post_id: z.string().nullable(),
  posted_at: InstantSchema.nullable(),
  deleted_at: InstantSchema.nullable(),
  caption: z.string().nullable(),
}

export const StatsMediaRowSchema = z.object({
  ...MediaHeadShape,
  views: count,
  for_you_views: count,
  timeline_views: count,
  other_views: count,
  video_views: count,
  completed_views: count,
  /** Sum of each view's watched share in hundredths of a percent. */
  watch_pct_sum: count,
  likes: count,
  all_time_views: count,
})
export type StatsMediaRow = z.infer<typeof StatsMediaRowSchema>

export const StatsSoldRowSchema = z.object({
  ...MediaHeadShape,
  price_mills: count,
  sales_count: count,
  net_mills: count,
  /** Hub's calculation (net ÷ 0.8), shown apart, never summed with net. */
  gross_mills: count,
  window_views: count,
})
export type StatsSoldRow = z.infer<typeof StatsSoldRowSchema>

export const StatsCommentPostSchema = z.object({
  post_ref: z.string(),
  comment_count: z.int(),
  possibly_truncated_count: z.int(),
  missing_count: z.int(),
  caption: z.string().nullable(),
  published_at: InstantSchema.nullable(),
})
export type StatsCommentPost = z.infer<typeof StatsCommentPostSchema>

export const StatsPageSchema = z.object({
  hub_page: z.string(),
  label: z.string(),
})

export const StatsScreenSchema = z.object({
  hub: PublicationsHubStateSchema,
  /** The model's Fansly pages, as Hub cuts them for the person. */
  pages: z.array(StatsPageSchema),
  /** The page shown (the first one when none was asked). */
  page: z.string().nullable(),
  window: StatsWindowSchema.nullable(),
  /** The media walk's first pass: «прочитано N из M». */
  walk: z.object({ visited: z.int(), queued: z.int() }).nullable(),
  media: z.array(StatsMediaRowSchema),
  top_sales: z.array(StatsSoldRowSchema),
  top_sales_total: z.int(),
  /** The comments of the window by post; `never_read` is not a zero. */
  comments: z.object({
    state: z.enum(['ok', 'in_progress', 'never_read', 'failed']),
    posts: z.array(StatsCommentPostSchema),
  }),
  updated_at: InstantSchema.nullable(),
})
export type StatsScreen = z.infer<typeof StatsScreenSchema>

/** One media's card: days by surface (0 For You, 1 лента подписок, 2 рекомендации, 3 поиск, 4 другое). */
export const StatsMediaCardSchema = z.object({
  media_offer_id: z.string(),
  window: StatsWindowSchema,
  daily: z.array(z.object({ day: z.string(), source: z.int(), views: count })),
  hourly: z.array(z.object({ hour: z.string(), source: z.int(), views: count })),
  retention: z.array(
    z.object({
      source: z.int(),
      sample_size: count,
      points: z.array(z.object({ percent: z.number(), still_watching: z.number() })),
    }),
  ),
  tags: z.array(z.object({ tag: z.string(), source: z.int(), views: count })),
})
export type StatsMediaCard = z.infer<typeof StatsMediaCardSchema>
