import { getRouteApi } from '@tanstack/react-router'
import { useCallback } from 'react'
import { useCurrentModel } from '@/shell/model/model-context'
import { accountOfTab } from './backlog'
import { type BacklogSearch, BacklogView } from './backlog-view'

const routeApi = getRouteApi('/_shell/$model/library/not-uploaded')

/**
 * Папка «Ещё не залито» `#/<модель>/library/not-uploaded?page=lora-2` (DESIGN §4.3).
 * У каждой вкладки своё выделение и место прокрутки, поэтому вид пересоздаётся по странице.
 */
export function NotUploadedScreen() {
  const model = useCurrentModel()
  const search = routeApi.useSearch()
  const navigate = routeApi.useNavigate()
  const change = useCallback(
    (patch: Partial<BacklogSearch>) =>
      void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true }),
    [navigate],
  )
  const account = accountOfTab(model.accounts, search.page)
  return account ? (
    <BacklogView key={account.code} account={account} search={search} onSearchChange={change} />
  ) : null
}
