import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import type { OrderTab } from '@/data/orders'
import { useHistoryState } from '@/lib/use-history-state'
import { OrdersView } from './orders-view'

const routeApi = getRouteApi('/_shell/$model/library/customs')

const SelectedOrderSchema = z.string().nullable()

/**
 * Кастомы › Заказы `#/<модель>/library/customs?view=orders` (DESIGN §4.16). Открытый
 * заказ — выделение: живёт в записи истории, адрес не меняется, «Назад» его возвращает.
 */
export function OrdersScreen() {
  const search = routeApi.useSearch()
  const navigate = useNavigate({ from: '/$model/library/customs' })
  const [selected, setSelected] = useHistoryState(
    'orders:selected',
    SelectedOrderSchema,
    () => null,
  )
  const tab: OrderTab = search.tab === 'closed' ? 'closed' : 'open'
  const changeTab = (next: OrderTab) =>
    void navigate({
      search: (previous) => ({ ...previous, tab: next === 'closed' ? 'closed' : undefined }),
      replace: true,
    })
  return (
    <OrdersView
      tab={tab}
      selectedId={selected}
      onSelect={setSelected}
      onClosePanel={() => setSelected(null)}
      onTabChange={changeTab}
    />
  )
}
