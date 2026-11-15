import { mskDate } from '@contentops/contracts'
import { getRouteApi, Navigate } from '@tanstack/react-router'
import { useClock } from '@/data/api-session'
import { useSession } from '@/data/session'
import { publicationsSearchOf, statsSearchOf } from '@/screens/hub-entry-search'
import { defaultSettingsTab } from '@/screens/settings/settings-tabs'
import { readLastSection, type SectionKey } from '@/shell/last-section'
import { useModelIndexPrefetch } from '@/shell/model/model-scope'

/**
 * Адреса без экрана ведут дальше (план продуктов §2.4): `/` и `/<модель>` — на «Сегодня» модели,
 * где человек был в прошлый раз (у «Только кастомы» — на «Ждут вас»), `/<модель>/plan` — на сегодня.
 */

function SectionRedirect({ model, section }: { model: string; section: SectionKey }) {
  const today = mskDate(useClock().now())
  switch (section) {
    case 'today':
      return <Navigate to="/$model/today" params={{ model }} replace />
    case 'waiting':
      return <Navigate to="/$model/waiting" params={{ model }} replace />
    case 'shooting':
      return <Navigate to="/$model/shooting" params={{ model }} replace />
    case 'inbox':
      return <Navigate to="/$model/inbox" params={{ model }} replace />
    case 'plan':
      return <Navigate to="/$model/plan/$date" params={{ model, date: today }} replace />
    case 'publications':
      return <Navigate to="/$model/publications" params={{ model }} replace />
    case 'stats':
      return <Navigate to="/$model/stats" params={{ model }} replace />
    case 'journal':
      return <Navigate to="/$model/journal" params={{ model }} replace />
    case 'library':
      return <Navigate to="/$model/library" params={{ model }} replace />
  }
}

export function EntryRedirect() {
  const session = useSession()
  // Пока сессия идёт, индекс модели, где человек был в прошлый раз, уже запрашивается.
  useModelIndexPrefetch(readLastSection()?.model)
  if (!session.data) {
    return null
  }
  const models = session.data.models
  const last = readLastSection()
  const remembered = last && models.includes(last.model) ? last : null
  const model = remembered?.model ?? models[0]
  if (!model) {
    return <Navigate to="/login" replace />
  }
  return <SectionRedirect model={model} section={homeOf(session.data.person.role)} />
}

/** Дом человека: «Сегодня»; у «Только кастомы» — «Ждут вас». */
function homeOf(role: string): SectionKey {
  return role === 'customs' ? 'waiting' : 'today'
}

const modelRouteApi = getRouteApi('/_shell/$model')

export function ModelIndexRedirect() {
  const { model } = modelRouteApi.useParams()
  const role = useSession().data?.person.role
  if (!role) return null
  return <SectionRedirect model={model} section={homeOf(role)} />
}

export function PlanTodayRedirect() {
  const { model } = modelRouteApi.useParams()
  return <SectionRedirect model={model} section="plan" />
}

export function SettingsIndexRedirect() {
  const role = useSession().data?.person.role
  if (!role) {
    return null
  }
  return <Navigate to="/settings/$tab" params={{ tab: defaultSettingsTab(role) }} replace />
}

const hubEntryApi = getRouteApi('/hub/$screen')

/**
 * Старые адреса Hub (пакет C2): «Публикации» и «Статистика» Hub — теперь экраны ContentOps. Hub ведёт сюда через вход
 * (`/auth/hub/start?next=/hub/<экран>?model=<модель Hub>&…`): модель Hub переводится в модель здесь (`hub_models`
 * сессии, `HUB_MODEL_MAP`), остальное из адреса едет с ней. Без модели или с чужой — модель, где человек был в
 * прошлый раз (или первая его).
 */
export function HubEntryRedirect() {
  const { screen } = hubEntryApi.useParams()
  const search = hubEntryApi.useSearch()
  const session = useSession()
  if (!session.data) return null
  const models = session.data.models
  const asked = search.model?.toLowerCase()
  const mapped = asked ? (session.data.hub_models?.[asked] ?? asked) : undefined
  const last = readLastSection()
  const model =
    (mapped && models.includes(mapped) ? mapped : undefined) ??
    (last && models.includes(last.model) ? last.model : undefined) ??
    models[0]
  if (!model) return <Navigate to="/login" replace />
  const { model: _hubModel, ...rest } = search
  if (screen === 'stats') {
    return <Navigate to="/$model/stats" params={{ model }} search={statsSearchOf(rest)} replace />
  }
  return (
    <Navigate
      to="/$model/publications"
      params={{ model }}
      search={publicationsSearchOf(rest)}
      replace
    />
  )
}
