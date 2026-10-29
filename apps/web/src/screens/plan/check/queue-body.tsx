import type { CheckList } from '@contentops/contracts'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import type { UseQueryResult } from '@tanstack/react-query'
import type { ComponentProps } from 'react'
import { QueryErrorLine } from '@/shell/field/query-error-line'
import { CaseNotice } from './case-notice'
import { CaseQueue } from './case-queue'
import { CheckSkeleton } from './check-skeleton'

interface QueueBodyProps extends ComponentProps<typeof CaseQueue> {
  list: UseQueryResult<CheckList>
  /** Случай из адреса, которого нет в очереди: ответ сервера о нём. */
  missingCase: unknown | null
  onShowDone: () => void
}

/**
 * Очередь «Сверить» со всеми состояниями (DESIGN §3.10): заготовки при первой загрузке,
 * «Не загрузилось · Повторить» без данных, строка над списком, если данные есть, но
 * обновить не удалось, и строка о случае из адреса, который уже решён.
 */
export function QueueBody({ list, missingCase, onShowDone, ...queue }: QueueBodyProps) {
  if (list.isPending) {
    return <CheckSkeleton />
  }
  if (list.isError && list.data === undefined) {
    return (
      <ErrorLine layout="center" message="Не загрузилось" onRetry={() => void list.refetch()} />
    )
  }
  return (
    <>
      <QueryErrorLine query={list} className="mb-2" />
      {missingCase ? <CaseNotice error={missingCase} onShowDone={onShowDone} /> : null}
      <CaseQueue {...queue} />
    </>
  )
}
