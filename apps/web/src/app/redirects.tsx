import { mskDate } from '@contentops/contracts'
import { getRouteApi, Navigate } from '@tanstack/react-router'
import { useClock } from '@/data/api-session'
import { useSession } from '@/data/session'
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
