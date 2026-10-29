import { formatDate, mskDate, type Order } from '@contentops/contracts'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { useToday } from '@/data/api-session'

/**
 * Низ панели (DESIGN §4.16, п. 7): «Закрыть заказ» доступна, когда всё сдано и открытых
 * правок нет — тогда она главной кнопкой стоит наверху. Иначе здесь причина словами.
 */
export function OrderCloseNote({ order }: { order: Order }) {
  const today = useToday()
  if (order.closed_at) {
    return (
      <InfoSection title="Закрыть заказ">
        <p className="text-muted-foreground">
          Заказ закрыт {formatDate(mskDate(order.closed_at), today)}
        </p>
      </InfoSection>
    )
  }
  if (order.close_block === null) return null
  return (
    <InfoSection title="Закрыть заказ">
      <p className="text-muted-foreground">{order.close_block}</p>
    </InfoSection>
  )
}
