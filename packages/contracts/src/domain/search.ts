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

/** SHA-256 of a file's bytes, lowercase hex: the browser hashes a dropped file (DESIGN §4.7). */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/)

/**
 * `GET /api/v1/<model>/search/file?sha256=` — «найдём такой же файл» (DESIGN §4.7, PRD §5
 * «совпадающие файлы»): who holds exactly these bytes — a master or a source of a version, a
 * copy issued for a page, a platform copy, a file of the old disk, a draft in «Приехало».
 */
export const FileMatchSchema = z.object({
  /** `null` — a draft in «Приехало» not accepted yet. */
  item_id: ItemIdSchema.nullable(),
  title: z.string(),
  /** «мастер», «исходник», «выданная копия», «копия для платформы», «в Приехало». */
  what: z.string(),
  /** Version of the asset; `null` for a draft. */
  version: z.int().positive().nullable(),
  /** A copy issued for a page: the page («Fansly 2») and the day. */
  issued: z
    .object({ account: AccountCodeSchema.nullable(), label: z.string().nullable(), on: z.string() })
    .nullable(),
  group_id: z.string().nullable(),
})
export type FileMatch = z.infer<typeof FileMatchSchema>

export const FileSearchResultSchema = z.object({
  sha256: Sha256HexSchema,
  matches: z.array(FileMatchSchema),
  /** «Этот файл: FYP-0412 версия 2 · Fansly 2 12.08» or «Такого файла нет». */
  text: z.string(),
})
export type FileSearchResult = z.infer<typeof FileSearchResultSchema>

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
