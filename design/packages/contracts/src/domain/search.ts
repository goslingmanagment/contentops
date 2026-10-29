import { z } from 'zod'
import { AccountCodeSchema } from './common'
import { IntegrationLineSchema } from './integrations'
import { ItemIdSchema, ItemTypeSchema } from './item-type'

/** `GET /api/v1/<model>/resolve?q=ппв 73` — what the query means, before full-text search. */
export const ResolveResultSchema = z.object({
  query: z.string(),
  /** Exact object: `Enter` opens it at once. */
  item_id: ItemIdSchema.nullable(),
  /** «ппв 73 → PPV-073». */
  parsed: z.string().nullable(),
  /** «Старый номер PPV-032 был у трёх папок». */
  old_number: z.object({ number: z.string(), items: z.array(ItemIdSchema) }).nullable(),
  /** The query names a section: «план», «заказы», «приехало». */
  section: z.enum(['inbox', 'library', 'plan', 'check', 'orders', 'promo', 'journal']).nullable(),
})
export type ResolveResult = z.infer<typeof ResolveResultSchema>

export const TimelineHitSchema = z.object({
  item_id: ItemIdSchema,
  t_s: z.number().nonnegative(),
  label: z.string(),
})
export type TimelineHit = z.infer<typeof TimelineHitSchema>

/** `GET /api/v1/<model>/search?q=` — server part of search: descriptions, old names, timeline. */
export const SearchResultSchema = z.object({
  resolve: ResolveResultSchema,
  groups: z.array(
    z.object({
      type: ItemTypeSchema,
      item_ids: z.array(ItemIdSchema),
      total: z.int().nonnegative(),
    }),
  ),
  timeline: z.array(TimelineHitSchema),
  inbox: z.array(z.object({ group_id: z.string(), title: z.string() })),
})
export type SearchResult = z.infer<typeof SearchResultSchema>

/** `GET /api/v1/<model>/not-uploaded?account=` — one tab of «Ещё не залито». */
export const NotUploadedPageSchema = z.object({
  account: AccountCodeSchema,
  tabs: z.array(z.object({ account: AccountCodeSchema, count: z.int().nonnegative() })),
  groups: z.array(
    z.object({
      type: ItemTypeSchema,
      item_ids: z.array(ItemIdSchema),
      count: z.int().nonnegative(),
    }),
  ),
  /** «ещё 12 уже в плане». */
  planned_hidden: z.int().nonnegative(),
  /** «vault Fansly 1 Hub обошёл не полностью — часть может быть уже залита». */
  coverage_note: z.string().nullable(),
  integration: IntegrationLineSchema.nullable(),
})
export type NotUploadedPage = z.infer<typeof NotUploadedPageSchema>
