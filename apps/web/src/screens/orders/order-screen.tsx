import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { type OrderTab, useOrder } from '@/data/orders'
import { useCurrentModel } from '@/shell/model/model-context'
import { HubOrderScreen } from './hub/hub-orders-screen'
import { OrdersView } from './orders-view'

const routeApi = getRouteApi('/_shell/$model/library/customs/orders/$order')

/**
 * Заказ по своему адресу `/<модель>/library/customs/orders/<id>`: код Hub `K-12` — заказ
 * Hub в «Заказах» (пакет N), адрес карточки `tg-…` — заказ ContentOps в архиве.
 */
export function OrderScreen() {
  const { order } = routeApi.useParams()
  return /^K-\d+$/.test(order) ? <HubOrderScreen /> : <ArchiveOrderScreen order={order} />
}

/**
 * Заказ до Hub по своему адресу (DESIGN §2.4): тот же список архива с открытой панелью.
 * Сюда ведут ссылки из «Приехало», поиска, объекта и карточки заказа Hub; другой заказ
 * открывается заменой адреса, закрытие панели возвращает в архив на то же место. «Найти
 * заказ» стоит и здесь: ряд чипов не меняется, слово уходит в адрес списка при закрытии.
 */
function ArchiveOrderScreen({ order }: { order: string }) {
  const model = useCurrentModel().code
  const navigate = useNavigate()
  const scrolled = useRef(0)
  const [query, setQuery] = useState('')
  const state = useOrder(model, order).data?.state
  const tab: OrderTab = state === 'closed' || state === 'cancelled' ? state : 'open'

  const toList = (next: OrderTab) =>
    void navigate({
      from: '/$model/library/customs/orders/$order',
      to: '/$model/library/customs',
      params: { model },
      search: (previous) => ({
        ...previous,
        view: 'archive' as const,
        tab: next === 'open' ? undefined : next,
        q: query || undefined,
      }),
      state: { [`orders:scroll:${next}`]: next === tab ? scrolled.current : 0 },
      replace: true,
    })

  return (
    <OrdersView
      archive
      tab={tab}
      query={query}
      onQueryChange={setQuery}
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
