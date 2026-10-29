import type {
  CreatePlanRowsResult,
  CreateReleaseCommand,
  NewPlanRow,
  PlanRow,
  ReleaseResult,
} from '@contentops/contracts'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { planChangedKeys, usePlanCommands } from '@/data/plan'
import { accountLabel } from '@/lib/words'
import { useCurrentModel } from '@/shell/model/model-context'
import { rowsWord, slotText } from '../plan-text'

interface CreateOptions {
  /** Строки поставлены: закрыть окно, выделить новые строки. */
  onCreated?: (rows: readonly PlanRow[]) => void
  /** Пакет не прошёл: какие строки и почему (всё или ничего, §3.3). */
  onRejected?: (result: CreatePlanRowsResult) => void
}

/**
 * «Поставить N» и «Поставить выпуск» (DESIGN §3.8): полоска «Поставлено · Fansly 2 ·
 * ср 23, 03:00 · Отменить». Отмена в течение 6 с удаляет строки, дальше — отмена строки.
 */
export function useCreateRows({ onCreated, onRejected }: CreateOptions = {}) {
  const model = useCurrentModel()
  const commands = usePlanCommands(model.code)
  const toast = useActionToast()
  const invalidates = () => planChangedKeys(model.code)

  const undo = useIntentMutation<{ rows: readonly PlanRow[] }, void>({
    failed: 'Не удалилось',
    run: async ({ rows }, key) => {
      await Promise.all(
        rows.map((row) => commands.undoCreate({ key: `${key}:${row.id}`, row: row.id })),
      )
    },
    invalidates,
    onSuccess: (_, { rows }) =>
      toast.show({
        message: rows.length === 1 ? 'Строка убрана' : `Убрано · ${rowsWord(rows.length)}`,
      }),
  })

  const placedMessage = (rows: readonly PlanRow[]) => {
    const first = rows[0]
    if (rows.length === 1 && first) {
      return `Поставлено · ${accountLabel(model.accounts, first.account)} · ${slotText(first.date, first.time)}`
    }
    return `Поставлено · ${rowsWord(rows.length)}`
  }

  const showPlaced = (rows: readonly PlanRow[], message: string) => {
    toast.show({
      message,
      undoable: true,
      action: { label: 'Отменить', onSelect: () => undo.start({ rows }) },
    })
    onCreated?.(rows)
  }

  const create = useIntentMutation<{ rows: readonly NewPlanRow[] }, CreatePlanRowsResult>({
    failed: 'Не поставилось',
    run: ({ rows }, key) => commands.createRows({ key, rows }),
    invalidates,
    onSuccess: (result) => {
      if (!result.created) {
        onRejected?.(result)
        return
      }
      showPlaced(result.rows, placedMessage(result.rows))
    },
  })

  const release = useIntentMutation<{ command: CreateReleaseCommand }, ReleaseResult>({
    failed: 'Выпуск не поставился',
    run: ({ command }, key) => commands.createRelease({ key, command }),
    invalidates,
    onSuccess: (result) =>
      showPlaced(
        result.rows,
        `Выпуск ${result.release.item_id} поставлен · ${rowsWord(result.rows.length)}`,
      ),
  })

  return {
    create: (rows: readonly NewPlanRow[]) => create.start({ rows }),
    createRelease: (command: CreateReleaseCommand) => release.start({ command }),
    pending: create.isPending || release.isPending,
  }
}
