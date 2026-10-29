import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { IntakeView } from './intake-view'

const inboxRoute = getRouteApi('/_shell/$model/inbox')
const groupRoute = getRouteApi('/_shell/$model/inbox/g/$group')

/** Приехало › Новое `#/<модель>/inbox` (DESIGN §4.8). */
export function InboxScreen() {
  const { view } = inboxRoute.useSearch()
  const navigate = useNavigate({ from: '/$model/inbox' })
  return (
    <IntakeView
      viewParam={view}
      onViewParamChange={(next) =>
        void navigate({ search: (previous) => ({ ...previous, view: next }), replace: true })
      }
    />
  )
}

/** Группа `#/<модель>/inbox/g/<id>`: то же «Новое», панель сразу показывает эту группу. */
export function InboxGroupScreen() {
  const { group } = groupRoute.useParams()
  const { view } = groupRoute.useSearch()
  const navigate = useNavigate({ from: '/$model/inbox/g/$group' })
  return (
    <IntakeView
      key={group}
      viewParam={view}
      initialGroupId={group}
      onViewParamChange={(next) =>
        void navigate({ search: (previous) => ({ ...previous, view: next }), replace: true })
      }
    />
  )
}
