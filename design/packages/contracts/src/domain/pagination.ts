import { z } from 'zod'

export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 500

/** Keyset pagination parameters (SPEC §11.2): opaque `cursor` plus `limit`. */
export const PageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
})
export type PageQuery = z.infer<typeof PageQuerySchema>

/** Every list answers `{items, next_cursor}`. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    next_cursor: z.string().nullable(),
  })
}

export interface Page<T> {
  items: T[]
  next_cursor: string | null
}

/** Result of a batch «по каждой записи»: `{results: [{id, ok, code}]}` (DESIGN §10.12). */
export const BatchResultSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      ok: z.boolean(),
      code: z.string().nullable(),
    }),
  ),
})
export type BatchResult = z.infer<typeof BatchResultSchema>
