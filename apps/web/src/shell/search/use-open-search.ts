import type { ModelCode } from '@contentops/contracts'
import { useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { SEARCH_QUERY_STATE_KEY } from './search-state'

/** Открыть экран поиска модели с запросом в `history.state`. */
export function useOpenSearch() {
  const navigate = useNavigate()
  return useCallback(
    (model: ModelCode, query: string) => {
      void navigate({
        to: '/$model/search',
        params: { model },
        state: (previous) => ({ ...previous, [SEARCH_QUERY_STATE_KEY]: query.trim() }),
      })
    },
    [navigate],
  )
}
