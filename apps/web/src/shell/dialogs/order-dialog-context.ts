import { createContext, useContext } from 'react'

/** С чего заводится заказ: пусто или текст карточки Telegram из группы «Приехало». */
export interface NewOrderSeed {
  /** Группа «Приехало», из которой открыто окно (◆ «Какой заказ?»), чтобы потом привязать сдачу. */
  inboxGroupId?: string
}

/**
 * Окно «Новый заказ» / «Завести заказ из карточки» (DESIGN §3.9, §4.16) открывается из
 * Кастомов и из «Приехало», а живёт в папке заказов. Оболочка держит его одно.
 */
export interface NewOrderDialogApi {
  openNewOrderDialog(seed?: NewOrderSeed): void
}

export const NewOrderDialogContext = createContext<NewOrderDialogApi | null>(null)

export function useNewOrderDialog(): NewOrderDialogApi {
  const api = useContext(NewOrderDialogContext)
  if (!api) {
    throw new Error('NewOrderDialogContext не подключён: экран вне оболочки')
  }
  return api
}
