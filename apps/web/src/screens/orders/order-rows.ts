import { ORDER_GROUP_ORDER, type Order, type OrderState } from '@contentops/contracts'

/** Строка списка заказов: заголовок группы или сам заказ (DESIGN §4.16). */
export type OrderListRow =
  | { kind: 'group'; key: string; state: OrderState; count: number }
  | { kind: 'order'; key: string; order: Order }

/** Высоты строк постоянны (§7.3): заказ 64, заголовок группы 44. */
export const ORDER_ROW_HEIGHT = 64
export const GROUP_ROW_HEIGHT = 44

const orderRow = (order: Order): OrderListRow => ({ kind: 'order', key: order.id, order })

/** Внутри группы — ближайший срок первым, без срока — в конце. */
function byDeadline(left: Order, right: Order): number {
  return (left.deadline ?? '9999').localeCompare(right.deadline ?? '9999')
}

/** Открытые: Просрочено, Правка, Ждём, Сдано частично, Сдано — можно закрыть. */
export function openOrderRows(orders: readonly Order[]): OrderListRow[] {
  return ORDER_GROUP_ORDER.flatMap((state) => {
    const inGroup = orders.filter((order) => order.state === state).sort(byDeadline)
    if (inGroup.length === 0) return []
    return [
      { kind: 'group' as const, key: `group-${state}`, state, count: inGroup.length },
      ...inGroup.map(orderRow),
    ]
  })
}

/** Закрытые — одним списком, последние закрытые сверху. */
export function closedOrderRows(orders: readonly Order[]): OrderListRow[] {
  return [...orders]
    .sort((left, right) => (right.closed_at ?? '').localeCompare(left.closed_at ?? ''))
    .map(orderRow)
}

/** Снятые — последние снятые сверху. */
export function cancelledOrderRows(orders: readonly Order[]): OrderListRow[] {
  return [...orders]
    .sort((left, right) => (right.cancelled?.at ?? '').localeCompare(left.cancelled?.at ?? ''))
    .map(orderRow)
}

/** Найденное словом — из всех вкладок, в порядке сервера: новые карточки сверху. */
export function foundOrderRows(orders: readonly Order[]): OrderListRow[] {
  return orders.map(orderRow)
}

export function rowHeight(row: OrderListRow): number {
  return row.kind === 'group' ? GROUP_ROW_HEIGHT : ORDER_ROW_HEIGHT
}
