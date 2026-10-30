import { getRouteApi } from '@tanstack/react-router'
import { PlanWeekView } from './week/plan-week-view'

const routeApi = getRouteApi('/_shell/$model/plan/w/$week')

/**
 * План › Неделя `/<модель>/plan/w/<неделя>` (DESIGN §4.12). Каждая неделя — свой экран:
 * выделение и ящик не переезжают на соседнюю.
 */
export function PlanWeekScreen() {
  const { week } = routeApi.useParams()
  return <PlanWeekView key={week} week={week} />
}
