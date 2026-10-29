import { getRouteApi } from '@tanstack/react-router'
import { lazy, Suspense } from 'react'

const CustomsSectionScreen = lazy(() =>
  import('@/screens/library').then((screens) => ({ default: screens.CustomsSectionScreen })),
)
const OrdersScreen = lazy(() =>
  import('@/screens/orders').then((screens) => ({ default: screens.OrdersScreen })),
)
const ToPpvScreen = lazy(() =>
  import('@/screens/orders').then((screens) => ({ default: screens.ToPpvScreen })),
)

const routeApi = getRouteApi('/_shell/$model/library/customs')

/**
 * Раздел «Кастомы» (DESIGN §4.2, §4.16): одна папка, три вида — плитки раздела, «Заказы»
 * и «Переделка в PPV». Переключатель вида живёт в адресе (`?view=orders`).
 */
export function CustomsRoute() {
  const { view } = routeApi.useSearch()
  return (
    <Suspense fallback={null}>
      {view === 'orders' ? <OrdersScreen /> : null}
      {view === 'to-ppv' ? <ToPpvScreen /> : null}
      {view !== 'orders' && view !== 'to-ppv' ? <CustomsSectionScreen /> : null}
    </Suspense>
  )
}
