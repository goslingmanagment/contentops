import type { ActionToastOptions } from '@contentops/ui/components/action-toast'
import { createContext, useContext } from 'react'

export interface FailureToastOptions {
  /** Что не вышло: «Не отметилось», «Не скачалось». */
  failed: string
  /** «Повторить» с тем же ключом повтора; для 429 вызывается сам. */
  retry?: () => void
  /**
   * Ключ намерения: автоповтор после 429 держится на нём, и следующий отказ другого
   * действия его не отменяет.
   */
  intentKey?: string
}

/** Полоска после действия (DESIGN §3.8), одна на экран: новая заменяет старую. */
export interface ActionToastApi {
  show(options: ActionToastOptions): void
  showFailure(error: unknown, options: FailureToastOptions): void
  dismiss(): void
}

export const ActionToastContext = createContext<ActionToastApi | null>(null)

export function useActionToast(): ActionToastApi {
  const api = useContext(ActionToastContext)
  if (!api) {
    throw new Error('ActionToastContext не подключён: экран вне ActionToastProvider')
  }
  return api
}
