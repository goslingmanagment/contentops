import { formatPercent, type ModelCode } from '@contentops/contracts'
import { ProgressRing } from '@contentops/ui/components/progress-ring'
import { useQueryClient } from '@tanstack/react-query'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { itemQueryKeys } from '@/data/object'
import { useOperation } from '@/data/operations'
import { useObjectPage } from '../object-context'

/**
 * Долгие операции над файлами объекта (DESIGN §3.13, п. 7): «Сделать фото», «Сделать
 * обложкой», версии фупа отвечают 202 — на плитках, к которым они относятся, стоит
 * кольцо с ходом, а когда операция закончилась, объект перечитывается.
 */
interface PendingOperation {
  id: string
  /** Файлы и кадры, на которых стоит кольцо: `frame03`, `master`, `versions`. */
  keys: readonly string[]
  label: string
}

interface PendingOperationsApi {
  operations: readonly PendingOperation[]
  add(operation: PendingOperation): void
  remove(id: string): void
}

const PendingOperationsContext = createContext<PendingOperationsApi | null>(null)

export function PendingOperationsProvider({ children }: { children: ReactNode }) {
  const [operations, setOperations] = useState<readonly PendingOperation[]>([])
  const add = useCallback(
    (operation: PendingOperation) => setOperations((current) => [...current, operation]),
    [],
  )
  const remove = useCallback(
    (id: string) => setOperations((current) => current.filter((operation) => operation.id !== id)),
    [],
  )
  const api = useMemo(() => ({ operations, add, remove }), [operations, add, remove])
  return <PendingOperationsContext value={api}>{children}</PendingOperationsContext>
}

export function usePendingOperations(): PendingOperationsApi {
  const api = useContext(PendingOperationsContext)
  if (!api) {
    throw new Error('Файлы объекта вне PendingOperationsProvider')
  }
  return api
}

/** Кольцо на плитке, пока идёт операция над этим файлом; иначе ничего. */
export function PendingRing({ fileKey }: { fileKey: string }) {
  const { operations } = usePendingOperations()
  const operation = operations.find((candidate) => candidate.keys.includes(fileKey))
  return operation ? <OperationVeil operation={operation} /> : null
}

function OperationVeil({ operation }: { operation: PendingOperation }) {
  const { model, detail } = useObjectPage()
  const { remove } = usePendingOperations()
  const progress = useOperation(model.code, operation.id).data
  useFinishedOperation(model.code, detail.entry.id, operation.id, progress?.state, remove)
  const value = progress ? progress.progress * 100 : undefined
  return (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-scrim text-scrim-foreground text-xs tabular-nums">
      <ProgressRing label={operation.label} value={value} />
      {progress ? formatPercent(progress.progress) : null}
    </span>
  )
}

function useFinishedOperation(
  model: ModelCode,
  itemId: string,
  operationId: string,
  state: 'running' | 'done' | 'failed' | undefined,
  remove: (id: string) => void,
) {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (state !== 'done' && state !== 'failed') {
      return
    }
    remove(operationId)
    for (const queryKey of itemQueryKeys(model, itemId)) {
      void queryClient.invalidateQueries({ queryKey })
    }
  }, [itemId, model, operationId, queryClient, remove, state])
}
