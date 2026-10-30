import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { useRef } from 'react'
import { type OrderTab, useOrder } from '@/data/orders'
import { useCurrentModel } from '@/shell/model/model-context'
import { OrdersView } from './orders-view'

const routeApi = getRouteApi('/_shell/$model/library/customs/orders/$order')

/**
 * Заказ по своему адресу `/<модель>/library/customs/orders/<id>` (DESIGN §2.4): тот же
 * список с открытой панелью. Сюда ведут ссылки из «Приехало», поиска и объекта; другой
 * заказ открывается заменой адреса, закрытие панели возвращает в список на то же место.
 */
export function OrderScreen() {
  const { order } = routeApi.useParams()
  const model = useCurrentModel().code
  const navigate = useNavigate()
  const scrolled = useRef(0)
  const state = useOrder(model, order).data?.state
  const tab: OrderTab = state === 'closed' || state === 'cancelled' ? state : 'open'

  const toList = (next: OrderTab) =>
    void navigate({
      from: '/$model/library/customs/orders/$order',
      to: '/$model/library/customs',
      params: { model },
      search: (previous) => ({
        ...previous,
        view: 'orders' as const,
        tab: next === 'open' ? undefined : next,
      }),
      state: { [`orders:scroll:${next}`]: next === tab ? scrolled.current : 0 },
      replace: true,
    })

  return (
    <OrdersView
      tab={tab}
      selectedId={order}
      onSelect={(id) =>
        void navigate({
          to: '/$model/library/customs/orders/$order',
          params: { model, order: id },
          replace: true,
        })
      }
      onClosePanel={() => toList(tab)}
      onTabChange={toList}
      onScrolled={(offset) => {
        scrolled.current = offset
      }}
    />
  )
}
