import { mskDate } from '@contentops/contracts'
import { getRouteApi, Navigate } from '@tanstack/react-router'
import { useClock } from '@/data/api-session'
import { useSession } from '@/data/session'
import { defaultSettingsTab } from '@/screens/settings/settings-tabs'
import { readLastSection, type SectionKey } from '@/shell/last-section'
import { useModelIndexPrefetch } from '@/shell/model/model-scope'

/**
 * Адреса без экрана ведут дальше: `/` — в последний раздел или Библиотеку первой
 * доступной модели, `/<модель>` — в Библиотеку, `/<модель>/plan` — на сегодня.
 */

function SectionRedirect({ model, section }: { model: string; section: SectionKey }) {
  const today = mskDate(useClock().now())
  switch (section) {
    case 'inbox':
      return <Navigate to="/$model/inbox" params={{ model }} replace />
    case 'plan':
      return <Navigate to="/$model/plan/$date" params={{ model, date: today }} replace />
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
  return <SectionRedirect model={model} section={remembered?.section ?? 'library'} />
}

const modelRouteApi = getRouteApi('/_shell/$model')

export function ModelIndexRedirect() {
  const { model } = modelRouteApi.useParams()
  return <Navigate to="/$model/library" params={{ model }} replace />
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
