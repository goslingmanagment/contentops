import type { BatchResult, PlanRow } from '@contentops/contracts'
import { useActionToast } from '@/actions/action-toast-context'
import { failedIds } from '@/actions/batch-result'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { planChangedKeys, usePlanCommands } from '@/data/plan'
import { accountLabel } from '@/lib/words'
import { useCurrentModel } from '@/shell/model/model-context'
import { rowsWord } from '../plan-text'

/**
 * Публикация строки через Hub (DESIGN §4.11, SPEC §7): «Подготовить» — Hub получает файлы и
 * делает черновик с проверками; «Отправить» — человек видел проверки и подтверждает;
 * «Отменить публикацию» — пока Hub не поставил её в расписание площадки. Работа идёт в фоне:
 * строка сама сменит «Hub готовит…» на проверки или статус.
 */
export function usePublishActions({
  onShowFailed,
}: {
  /** «Показать»: выделить строки пакета, которые не прошли (§3.3). */
  onShowFailed?: (rowIds: readonly string[]) => void
} = {}) {
  const model = useCurrentModel()
  const commands = usePlanCommands(model.code)
  const toast = useActionToast()
  const invalidates = () => planChangedKeys(model.code)
  const where = (row: PlanRow) =>
    `${row.manifest?.item_id ?? 'строка'} · ${accountLabel(model.accounts, row.account)}`

  const prepare = useIntentMutation<{ row: PlanRow }, PlanRow>({
    failed: 'Не подготовилось',
    run: ({ row }, key) => commands.prepare({ key, row: row.id }),
    invalidates,
    onSuccess: (updated) => toast.show({ message: `Hub готовит черновик · ${where(updated)}` }),
  })

  const send = useIntentMutation<{ row: PlanRow; version: number }, PlanRow>({
    failed: 'Не отправилось',
    run: ({ row, version }, key) => commands.send({ key, row: row.id, version }),
    invalidates,
    onSuccess: (updated) => toast.show({ message: `Отправляется в Hub · ${where(updated)}` }),
  })

  const cancel = useIntentMutation<{ row: PlanRow }, PlanRow>({
    failed: 'Публикация не отменилась',
    run: ({ row }, key) => commands.cancelPublication({ key, row: row.id }),
    invalidates,
    onSuccess: (updated) => toast.show({ message: `Публикация отменяется · ${where(updated)}` }),
  })

  /** Итог пакета: «Hub готовит · 12 строк» или «… 11 из 12 · 1 не прошла · Показать». */
  const batchToast = (rows: readonly PlanRow[], result: BatchResult, done: string) => {
    const failed = failedIds(result)
    const passed = rows.length - failed.length
    toast.show({
      message:
        failed.length === 0
          ? `${done} · ${rowsWord(passed)}`
          : `${done} ${passed} из ${rows.length} · не прошли: ${rowsWord(failed.length)}`,
      action:
        failed.length > 0 && onShowFailed
          ? { label: 'Показать', onSelect: () => onShowFailed(failed) }
          : undefined,
    })
  }

  const prepareMany = useIntentMutation<{ rows: readonly PlanRow[] }, BatchResult>({
    failed: 'Не подготовилось',
    run: ({ rows }, key) => commands.prepareMany({ key, rows: rows.map((row) => row.id) }),
    invalidates,
    onSuccess: (result, { rows }) => batchToast(rows, result, 'Hub готовит черновики'),
  })

  const sendMany = useIntentMutation<{ rows: readonly PlanRow[] }, BatchResult>({
    failed: 'Не отправилось',
    run: ({ rows }, key) =>
      commands.sendMany({
        key,
        rows: rows.map((row) => ({ id: row.id, version: row.hub?.publication?.version ?? 1 })),
      }),
    invalidates,
    onSuccess: (result, { rows }) => batchToast(rows, result, 'Отправляется в Hub'),
  })

  return {
    prepareMany: (rows: readonly PlanRow[]) => prepareMany.start({ rows }),
    sendMany: (rows: readonly PlanRow[]) => sendMany.start({ rows }),
    batchPending: prepareMany.isPending || sendMany.isPending,
    prepare: (row: PlanRow) => prepare.start({ row }),
    send: (row: PlanRow, version: number) => send.start({ row, version }),
    cancel: (row: PlanRow) => cancel.start({ row }),
    preparing: prepare.isPending,
    sending: send.isPending,
    cancelling: cancel.isPending,
  }
}
