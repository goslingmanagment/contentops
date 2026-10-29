import type { BatchResult, MarkKind, PlanRow } from '@contentops/contracts'
import { useActionToast } from '@/actions/action-toast-context'
import { failedIds } from '@/actions/batch-result'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { planChangedKeys, usePlanCommands } from '@/data/plan'
import { accountLabel } from '@/lib/words'
import { useCurrentModel } from '@/shell/model/model-context'
import { rowsWord } from '../plan-text'
import { rememberMarkKind } from '../row-action'

interface MarkRequest {
  row: PlanRow
  kind: MarkKind
  /** Время сториз и рассылки; по умолчанию «сейчас» (сервер ставит время отметки). */
  at: string | null
}

interface BatchRequest {
  rows: readonly PlanRow[]
  kind: MarkKind
}

interface BatchOptions {
  /** «Показать»: выделить строки, которые не прошли (§3.3). */
  onShowFailed?: (rowIds: readonly string[]) => void
}

function rowName(row: PlanRow): string {
  return row.manifest?.item_id ?? 'строка под монтаж'
}

/**
 * Отметки строк (DESIGN §3.8, §4.11): «Отметить ▾», «Отметить и подтвердить», пакеты и
 * «Снять отметку». После каждой — полоска с отменой; итог пакета «Отмечено 11 из 12».
 */
export function useMarkActions({ onShowFailed }: BatchOptions = {}) {
  const model = useCurrentModel()
  const commands = usePlanCommands(model.code)
  const toast = useActionToast()
  const invalidates = () => planChangedKeys(model.code)
  const where = (row: PlanRow) => `${rowName(row)} · ${accountLabel(model.accounts, row.account)}`

  const unmark = useIntentMutation<{ rows: readonly PlanRow[] }, PlanRow[]>({
    failed: 'Отметка не снялась',
    run: ({ rows }, key) =>
      Promise.all(rows.map((row) => commands.unmark({ key: `${key}:${row.id}`, row: row.id }))),
    invalidates,
    onSuccess: (rows) =>
      toast.show({
        message: rows.length === 1 ? 'Отметка снята' : `Отметка снята · ${rowsWord(rows.length)}`,
      }),
  })

  const undoWith = (rows: readonly PlanRow[]) => ({
    label: 'Отменить',
    onSelect: () => unmark.start({ rows }),
  })

  const mark = useIntentMutation<MarkRequest, PlanRow>({
    failed: 'Не отметилось',
    run: ({ row, kind, at }, key) => commands.mark({ key, row: row.id, kind, at }),
    invalidates,
    onSuccess: (updated, { kind }) => {
      rememberMarkKind(kind)
      const how = kind === 'scheduled' ? 'В планировщике' : 'Отмечено'
      toast.show({
        message: `${how} · ${where(updated)}`,
        action: undoWith([updated]),
        undoable: true,
      })
    },
  })

  const markConfirm = useIntentMutation<{ row: PlanRow; at: string | null }, PlanRow>({
    failed: 'Не отметилось',
    run: ({ row, at }, key) => commands.markConfirm({ key, row: row.id, at }),
    invalidates,
    onSuccess: (updated) =>
      toast.show({
        message: `Отмечено и подтверждено · ${where(updated)}`,
        action: undoWith([updated]),
        undoable: true,
      }),
  })

  const batchToast = (rows: readonly PlanRow[], result: BatchResult, done: string) => {
    const failed = failedIds(result)
    const passed = rows.filter((row) => !failed.includes(row.id))
    if (failed.length === 0) {
      toast.show({
        message: `${done} · ${rowsWord(passed.length)}`,
        action: undoWith(passed),
        undoable: true,
      })
      return
    }
    toast.show({
      message: `${done} ${passed.length} из ${rows.length} · ${failed.length} уже изменили`,
      action: onShowFailed
        ? { label: 'Показать', onSelect: () => onShowFailed(failed) }
        : undefined,
    })
  }

  const markMany = useIntentMutation<BatchRequest, BatchResult>({
    failed: 'Не отметилось',
    run: ({ rows, kind }, key) => commands.markMany({ key, rows: rows.map((row) => row.id), kind }),
    invalidates,
    onSuccess: (result, { rows, kind }) => {
      rememberMarkKind(kind)
      batchToast(rows, result, kind === 'scheduled' ? 'В планировщике' : 'Отмечено')
    },
  })

  const markConfirmMany = useIntentMutation<{ rows: readonly PlanRow[] }, BatchResult>({
    failed: 'Не отметилось',
    run: ({ rows }, key) => commands.markConfirmMany({ key, rows: rows.map((row) => row.id) }),
    invalidates,
    onSuccess: (result, { rows }) => batchToast(rows, result, 'Отмечено и подтверждено'),
  })

  return {
    mark: (row: PlanRow, kind: MarkKind, at: string | null = null) => mark.start({ row, kind, at }),
    markConfirm: (row: PlanRow, at: string | null = null) => markConfirm.start({ row, at }),
    markMany: (rows: readonly PlanRow[], kind: MarkKind) => markMany.start({ rows, kind }),
    markConfirmMany: (rows: readonly PlanRow[]) => markConfirmMany.start({ rows }),
    unmark: (rows: readonly PlanRow[]) => unmark.start({ rows }),
    pending: mark.isPending || markConfirm.isPending || markMany.isPending,
  }
}
