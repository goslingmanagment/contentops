import { getRouteApi } from '@tanstack/react-router'
import { PlanDayView } from './day/plan-day-view'

const routeApi = getRouteApi('/_shell/$model/plan/$date')

/**
 * План › День `/<модель>/plan/<дата>` (DESIGN §4.11). Каждый день — свой экран: выделение,
 * прокрутка и открытая правка не переезжают на соседний день.
 */
export function PlanDayScreen() {
  const { date } = routeApi.useParams()
  return <PlanDayView key={date} date={date} />
}
