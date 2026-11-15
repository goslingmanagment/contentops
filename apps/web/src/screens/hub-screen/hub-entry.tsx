import { getRouteApi, Navigate } from '@tanstack/react-router'
import { useModels, useSession } from '@/data/session'
import { readLastSection } from '@/shell/last-section'

const routeApi = getRouteApi('/hub/$screen')

/**
 * Hub's old addresses of «Публикации» and «Статистика» and its matters about a publication land here
 * (`/hub/publications?page=lora-1&publication=12`, Hub's old-addresses.ts): the model of the page named
 * in `?page=` (its Hub page), else the model the person was in last, else their first; then the screen
 * of that model with the same query.
 */
export function HubEntryRedirect() {
  const { screen } = routeApi.useParams()
  const search = routeApi.useSearch()
  const session = useSession()
  const models = useModels()
  if (!session.data || !models.data) return null
  const allowed = new Set(session.data.models)
  const mine = models.data.filter((model) => allowed.has(model.code))
  const page = search.page
  const ofPage = page
    ? mine.find((model) => model.accounts.some((account) => account.hub_page === page))
    : undefined
  const last = readLastSection()
  const model = ofPage ?? mine.find((one) => one.code === last?.model) ?? mine[0]
  if (!model) return <Navigate to="/login" replace />
  return screen === 'stats' ? (
    <Navigate to="/$model/stats" params={{ model: model.code }} search={search as never} replace />
  ) : (
    <Navigate
      to="/$model/publications"
      params={{ model: model.code }}
      search={search as never}
      replace
    />
  )
}
