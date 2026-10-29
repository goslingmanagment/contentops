import {
  ActionToaster,
  dismissActionToast,
  showActionToast,
} from '@contentops/ui/components/action-toast'
import { type ReactNode, useEffect, useMemo, useRef } from 'react'
import { type ActionToastApi, ActionToastContext } from './action-toast-context'
import { describeFailure } from './failure-message'
import { RetryTimers } from './retry-timers'

/**
 * Даёт всем экранам полоску после действия и ставит её место один раз. Отказы
 * переводятся в слова §3.8; 429 повторяется сам через время из ответа — у каждого
 * намерения свой таймер: полоска одна, а повторы не отменяют друг друга.
 */
export function ActionToastProvider({ children }: { children: ReactNode }) {
  const retryTimers = useRef(new RetryTimers())
  useEffect(() => {
    const timers = retryTimers.current
    return () => timers.clearAll()
  }, [])

  const api = useMemo<ActionToastApi>(
    () => ({
      show: (options) => showActionToast(options),
      dismiss: () => dismissActionToast(),
      showFailure: (error, { failed, retry, intentKey }) => {
        const failure = describeFailure(error, failed)
        if (!failure) {
          return
        }
        if (failure.unexpected) {
          // Схема ответа или код: повтор не поможет, нужна запись для разработчика.
          console.error(error)
        }
        if (failure.autoRetryMs !== null && retry) {
          retryTimers.current.schedule(intentKey, failure.autoRetryMs, retry)
        }
        showActionToast({
          message: failure.message,
          tone: 'error',
          action: failure.retryable && retry ? { label: 'Повторить', onSelect: retry } : undefined,
          durationMs: failure.autoRetryMs ?? undefined,
        })
      },
    }),
    [],
  )

  return (
    <ActionToastContext value={api}>
      {children}
      <ActionToaster field="main" avoid='[data-slot="upload-tray"]' />
    </ActionToastContext>
  )
}
