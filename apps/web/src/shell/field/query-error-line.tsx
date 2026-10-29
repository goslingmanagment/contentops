import { formatClock, type Instant, instantFromMs, instantMs } from '@contentops/contracts'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import { useClock } from '@/data/api-session'

/** Что нужно от запроса: итог чтения, время последних данных и повтор. */
export interface QueryErrorSource {
  isError: boolean
  dataUpdatedAt: number
  refetch: () => unknown
}

interface QueryErrorLineProps {
  query: QueryErrorSource
  /**
   * Есть ли показанные данные: тогда ошибка — строка над ними, иначе — «Не загрузилось» по
   * центру.
   */
  hasData?: boolean
  /** Время данных от сервера (`generatedAt`), если оно есть. */
  shownAt?: Instant
  className?: string
}

/** Время прототипа, когда пришли показанные данные: часы прототипа, а не браузера. */
function receivedAt(now: Instant, updatedAtMs: number): Instant {
  return instantFromMs(instantMs(now) - (Date.now() - updatedAtMs))
}

/**
 * Ошибка чтения (DESIGN §3.10): «Не удалось обновить — показано на 16:02 · Повторить» над
 * прежними данными или «Не загрузилось · Повторить» по центру, если данных нет. Время —
 * по часам прототипа, как на всём остальном экране.
 */
export function QueryErrorLine({ query, hasData = true, shownAt, className }: QueryErrorLineProps) {
  const clock = useClock()
  if (!query.isError) return null
  const retry = () => void query.refetch()
  if (!hasData) {
    return <ErrorLine layout="center" message="Не загрузилось" onRetry={retry} />
  }
  const at = shownAt ?? receivedAt(clock.now(), query.dataUpdatedAt)
  return (
    <ErrorLine
      message={`Не удалось обновить — показано на ${formatClock(at)}`}
      onRetry={retry}
      className={className}
    />
  )
}
