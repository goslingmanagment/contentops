import { DEFAULT_PAGE_LIMIT, type Page } from '../../../domain/pagination'
import { DomainError } from '../domain-error'

/**
 * Keyset pagination over an ordered list (SPEC §11.2): the cursor is the key of the last
 * item, opaque for the client, so a list that grows at the head does not shift pages.
 */
export function paginate<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  cursor: string | undefined,
  limit: number | undefined,
): Page<T> {
  const size = limit ?? DEFAULT_PAGE_LIMIT
  let start = 0
  if (cursor) {
    let key: string
    try {
      key = atob(cursor)
    } catch {
      throw new DomainError('invalid_request', 'Неверный курсор')
    }
    const index = items.findIndex((item) => keyOf(item) === key)
    if (index < 0) throw new DomainError('invalid_request', 'Курсор устарел')
    start = index + 1
  }
  const page = items.slice(start, start + size)
  const last = page.at(-1)
  const hasMore = start + size < items.length
  return { items: [...page], next_cursor: hasMore && last !== undefined ? btoa(keyOf(last)) : null }
}

/** A short list answered whole: the same `{items, next_cursor}` shape, no further pages. */
export function wholeList<T>(items: readonly T[]): Page<T> {
  return { items: [...items], next_cursor: null }
}
