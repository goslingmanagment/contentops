import { getRouteApi, Navigate } from '@tanstack/react-router'
import { useCurrentModel } from '@/shell/model/model-context'

/**
 * Старые адреса заказов Hub (пакет N) с пакета C3 ведут в «Съёмку»: список
 * `/<модель>/library/customs?view=orders` — на `/<модель>/shooting`, заказ
 * `/<модель>/library/customs/orders/K-12` — туда же с открытым заказом. Экран один.
 */
export function HubOrdersScreen() {
  const model = useCurrentModel().code
  return <Navigate to="/$model/shooting" params={{ model }} replace />
}

const orderRoute = getRouteApi('/_shell/$model/library/customs/orders/$order')

export function HubOrderScreen() {
  const { order } = orderRoute.useParams()
  const model = useCurrentModel().code
  return <Navigate to="/$model/shooting" params={{ model }} search={{ order }} replace />
}
