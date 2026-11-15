import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { useRole } from '@/data/session'
import { HubOrdersView } from '@/screens/orders/hub/hub-orders-view'
import { useCurrentModel } from '@/shell/model/model-context'
import { TasksView } from './tasks-view'

const routeApi = getRouteApi('/_shell/$model/shooting')

/**
 * «Съёмка» `/<модель>/shooting` (план продуктов §2.4, пакет C3): вкладка «Кастомы» — заказы Hub
 * от «Проверен» до «Снят» со стороны съёмки (`?order=K-12` — заказ в панели); вкладка «ТЗ» —
 * задания модели, что не заказ фана. Старые «Заказы» Кастомов ведут сюда.
 */
export function ShootingScreen() {
  const { tab, order } = routeApi.useSearch()
  const model = useCurrentModel().code
  const navigate = useNavigate()
  // «Только кастомы» видит одни заказы: вкладки «ТЗ» у роли нет.
  const role = useRole()
  if (tab === 'tasks' && role !== 'customs') return <TasksView />
  const select = (code: string | null) =>
    void navigate({
      to: '/$model/shooting',
      params: { model },
      search: code ? { order: code } : {},
      replace: true,
    })
  return (
    <HubOrdersView
      selectedCode={order ?? null}
      onSelect={(code) => select(code)}
      onClosePanel={() => select(null)}
    />
  )
}
