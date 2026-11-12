import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { useHistoryState } from '@/lib/use-history-state'
import { useCurrentModel } from '@/shell/model/model-context'
import { HubOrdersView } from './hub-orders-view'

const SelectedSchema = z.string().nullable()

/**
 * Кастомы › Заказы `/<модель>/library/customs?view=orders` (пакет N): заказы Hub в
 * производстве. Открытый заказ — выделение в записи истории, как у заказов до Hub.
 */
export function HubOrdersScreen() {
  const [selected, setSelected] = useHistoryState('hub-orders:selected', SelectedSchema, () => null)
  return (
    <HubOrdersView
      selectedCode={selected}
      onSelect={setSelected}
      onClosePanel={() => setSelected(null)}
    />
  )
}

const orderRoute = getRouteApi('/_shell/$model/library/customs/orders/$order')

/** Заказ Hub по своему адресу `/<модель>/library/customs/orders/K-12`. */
export function HubOrderScreen() {
  const { order } = orderRoute.useParams()
  const model = useCurrentModel().code
  const navigate = useNavigate()
  return (
    <HubOrdersView
      selectedCode={order}
      onSelect={(code) =>
        void navigate({
          to: '/$model/library/customs/orders/$order',
          params: { model, order: code },
          replace: true,
        })
      }
      onClosePanel={() =>
        void navigate({
          to: '/$model/library/customs',
          params: { model },
          search: { view: 'orders' as const },
          replace: true,
        })
      }
    />
  )
}
