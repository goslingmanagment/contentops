import type { Order } from '@contentops/contracts'
import type { ItemMenuModel, MenuAction } from '@contentops/ui/components/item-menu'
import { ExternalLinkIcon } from 'lucide-react'

/** Что панель заказа открывает по пункту меню: форму правки, поиск сдачи или «Снять…». */
export type OrderPanelIntent = 'revision' | 'link' | 'cancel'

interface OrderMenuHandlers {
  /** «Открыть» — только у строки списка; в панели заказ уже открыт. */
  open?: () => void
  intent: (kind: OrderPanelIntent) => void
  close: () => void
  /** Правит ли смотрящий: «Только чтение» видит лишь «Открыть» и карточку. */
  editable: boolean
}

function openCard(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * Меню заказа (DESIGN §3.6): «Открыть · Карточка в Telegram ↗ · Добавить правку ·
 * Привязать сдачу… · Закрыть заказ · Снять…». Одна модель на «⋯» панели и правый клик по строке;
 * неприменимые пункты не показываются.
 */
export function orderMenu(order: Order, handlers: OrderMenuHandlers): ItemMenuModel {
  const open = order.state !== 'closed' && order.state !== 'cancelled'
  const actions: MenuAction[] = []
  if (handlers.open) actions.push({ id: 'open', label: 'Открыть', onSelect: handlers.open })
  if (order.card.url) {
    actions.push({
      id: 'card',
      label: 'Карточка в Telegram',
      icon: ExternalLinkIcon,
      onSelect: () => openCard(order.card.url),
    })
  }
  if (handlers.editable && open) {
    actions.push(
      { id: 'revision', label: 'Добавить правку', onSelect: () => handlers.intent('revision') },
      { id: 'link', label: 'Привязать сдачу…', onSelect: () => handlers.intent('link') },
    )
    if (order.close_block === null) {
      actions.push({ id: 'close', label: 'Закрыть заказ', onSelect: handlers.close })
    }
    actions.push({ id: 'cancel', label: 'Снять…', onSelect: () => handlers.intent('cancel') })
  }
  return { actions }
}
