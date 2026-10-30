import { useLocation } from '@tanstack/react-router'
import { searchQueryOf } from '@/shell/search/search-state'
import { SearchResults } from './search-results'

/**
 * Поиск `/<модель>/search` (DESIGN §4.7). Запрос живёт в `history.state`: новый запрос —
 * новая запись истории со своими чипами, выделением и прокруткой, «Назад» возвращает
 * прежний результат целиком.
 */
export function SearchScreen() {
  const query = useLocation({ select: (location) => searchQueryOf(location.state) })
  return <SearchResults key={query} query={query} />
}
