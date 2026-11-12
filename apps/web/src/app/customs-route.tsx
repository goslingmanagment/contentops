import { getRouteApi } from '@tanstack/react-router'
import { lazy, Suspense } from 'react'

const CustomsSectionScreen = lazy(() =>
  import('@/screens/library').then((screens) => ({ default: screens.CustomsSectionScreen })),
)
const OrdersScreen = lazy(() =>
  import('@/screens/orders').then((screens) => ({ default: screens.OrdersScreen })),
)
const HubOrdersScreen = lazy(() =>
  import('@/screens/orders').then((screens) => ({ default: screens.HubOrdersScreen })),
)
const ToPpvScreen = lazy(() =>
  import('@/screens/orders').then((screens) => ({ default: screens.ToPpvScreen })),
)

const routeApi = getRouteApi('/_shell/$model/library/customs')

/**
 * Раздел «Кастомы» (DESIGN §4.2, §4.16): одна папка, три вида — плитки раздела, «Заказы»
 * и «Переделка в PPV». Переключатель вида живёт в адресе (`?view=orders`). «Заказы» — это
 * заказы Hub (пакет N, 12.11.2026); заказы ContentOps до Hub — `?view=archive`.
 */
export function CustomsRoute() {
  const { view } = routeApi.useSearch()
  return (
    <Suspense fallback={null}>
      {view === 'orders' ? <HubOrdersScreen /> : null}
      {view === 'archive' ? <OrdersScreen /> : null}
      {view === 'to-ppv' ? <ToPpvScreen /> : null}
      {view !== 'orders' && view !== 'archive' && view !== 'to-ppv' ? (
        <CustomsSectionScreen />
      ) : null}
    </Suspense>
  )
}
