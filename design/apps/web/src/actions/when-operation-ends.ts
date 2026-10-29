import type { ModelCode, Operation } from '@contentops/contracts'
import { hashKey, type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { queryKeys } from '@/data/query-keys'

type OperationEnd = (operation: Operation) => void

function ended(operation: Operation | undefined): operation is Operation {
  return operation !== undefined && operation.state !== 'running'
}

/**
 * Один раз позвать `onEnd`, когда долгая операция (202) закончится. Ход операции опрашивает
 * лоток (`trackOperation`), здесь только слушается кэш запросов: подписка живёт дольше
 * экрана и окна, которые её поставили, — человек может уйти, полоска всё равно придёт.
 * Возвращает отписку.
 */
export function whenOperationEnds(
  queryClient: QueryClient,
  model: ModelCode,
  operationId: string,
  onEnd: OperationEnd,
): () => void {
  const queryKey = queryKeys.operation(model, operationId)
  const read = () => queryClient.getQueryData<Operation>(queryKey)
  const current = read()
  if (ended(current)) {
    onEnd(current)
    return () => {}
  }
  const hash = hashKey(queryKey)
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.query.queryHash !== hash) {
      return
    }
    const operation = read()
    if (ended(operation)) {
      unsubscribe()
      onEnd(operation)
    }
  })
  return unsubscribe
}

/** `whenOperationEnds` с клиентом запросов из контекста. */
export function useWhenOperationEnds() {
  const queryClient = useQueryClient()
  return useCallback(
    (model: ModelCode, operationId: string, onEnd: OperationEnd) =>
      whenOperationEnds(queryClient, model, operationId, onEnd),
    [queryClient],
  )
}
