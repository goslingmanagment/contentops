import { z } from 'zod'

/**
 * Запрос поиска живёт в `history.state`, а не в адресе (DESIGN §2.4): в адрес и журналы
 * сервера он не попадает, «Назад» возвращает его вместе с экраном.
 */
export const SEARCH_QUERY_STATE_KEY = 'searchQuery'

export const SearchQueryStateSchema = z.object({ [SEARCH_QUERY_STATE_KEY]: z.string() })

/** Запрос из состояния записи истории; пустая строка, если его нет. */
export function searchQueryOf(state: unknown): string {
  return SearchQueryStateSchema.safeParse(state).data?.searchQuery ?? ''
}
