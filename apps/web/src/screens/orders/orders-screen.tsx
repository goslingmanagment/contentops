import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import type { OrderTab } from '@/data/orders'
import { useHistoryState } from '@/lib/use-history-state'
import { OrdersView } from './orders-view'

const routeApi = getRouteApi('/_shell/$model/library/customs')

const SelectedOrderSchema = z.string().nullable()

/**
 * Архив заказов `/<модель>/library/customs?view=archive` (DESIGN §4.16; пакет N): заказы
 * ContentOps до Hub, только для чтения. Открытый заказ — выделение: живёт в записи
 * истории, адрес не меняется, «Назад» его возвращает.
 */
export function OrdersScreen() {
  const search = routeApi.useSearch()
  const navigate = useNavigate({ from: '/$model/library/customs' })
  const [selected, setSelected] = useHistoryState(
    'orders:selected',
    SelectedOrderSchema,
    () => null,
  )
  const tab: OrderTab = search.tab ?? 'open'
  const changeTab = (next: OrderTab) =>
    void navigate({
      search: (previous) => ({ ...previous, tab: next === 'open' ? undefined : next }),
      replace: true,
    })
  const changeQuery = (q: string) =>
    void navigate({
      search: (previous) => ({ ...previous, q: q || undefined }),
      replace: true,
    })
  return (
    <OrdersView
      archive
      tab={tab}
      query={search.q ?? ''}
      onQueryChange={changeQuery}
      selectedId={selected}
      onSelect={setSelected}
      onClosePanel={() => setSelected(null)}
      onTabChange={changeTab}
    />
  )
}
