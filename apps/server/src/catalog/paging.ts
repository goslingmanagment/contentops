import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ApiProblem } from '../errors'

/**
 * Keyset cursors (SPEC §11.2): an opaque base64url of the last row's key, bound to the model
 * and the filters it was given with; another query's cursor is a 400.
 */

const CursorSchema = z.object({ k: z.array(z.string()), f: z.string() })

export function filterDigest(model: string, filters: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([model, filters]))
    .digest('base64url')
    .slice(0, 12)
}

export function readCursor(value: string | undefined, digest: string): string[] | null {
  if (value === undefined) return null
  try {
    const parsed = CursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
    if (parsed.f !== digest) throw new Error('cursor of another query')
    return parsed.k
  } catch {
    throw new ApiProblem('invalid_request', 'Курсор от другого запроса', { field: 'cursor' })
  }
}

export function writeCursor(key: readonly string[], digest: string): string {
  return Buffer.from(JSON.stringify({ k: key, f: digest })).toString('base64url')
}

/** `limit + 1` rows were read: the page and the cursor of its last row, if there is more. */
export function pageOf<Row, Item>(
  rows: readonly Row[],
  limit: number,
  item: (row: Row) => Item,
  key: (row: Row) => string[],
  digest: string,
): { items: Item[]; next_cursor: string | null } {
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map(item),
    next_cursor: rows.length > limit && last ? writeCursor(key(last), digest) : null,
  }
}
