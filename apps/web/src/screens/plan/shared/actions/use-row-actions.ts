import {
  CANCEL_REASON_LABEL,
  type CancelReason,
  type DownloadAnswer,
  type DownloadKind,
  type MoveRowCommand,
  type PersonRef,
  PICKED_CANCEL_REASONS,
  type PlanRow,
  type UpdateRowCommand,
} from '@contentops/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { useActionToast } from '@/actions/action-toast-context'
import { savedMessage, useDeliverDownload } from '@/actions/use-deliver-download'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { planChangedKeys, usePlanCommands } from '@/data/plan'
import { accountLabel } from '@/lib/words'
import { useCurrentModel } from '@/shell/model/model-context'
import { rowsWord, slotText } from '../plan-text'

const REASONS = PICKED_CANCEL_REASONS

interface MoveRequest {
  row: PlanRow
  target: MoveRowCommand
}

interface UpdateRequest {
  rows: readonly PlanRow[]
  change: UpdateRowCommand
  /** Подпись полоски: «Состав заменён», «Передано Никите». */
  done: string
}

/**
 * Прочие действия со строкой (DESIGN §3.6, §3.8): отмена с причиной чипом в полоске,
 * перенос, правка, скачивание копии для заливки.
 */
export function useRowActions() {
  const model = useCurrentModel()
  const commands = usePlanCommands(model.code)
  const toast = useActionToast()
  const deliver = useDeliverDownload()
  const queryClient = useQueryClient()
  const invalidates = () => planChangedKeys(model.code)

  const giveReason = useIntentMutation<{ rows: readonly PlanRow[]; reason: CancelReason }, void>({
    failed: 'Причина не записалась',
    run: async ({ rows, reason }, key) => {
      await Promise.all(
        rows.map((row) => commands.cancel({ key: `${key}:${row.id}`, row: row.id, reason })),
      )
    },
    invalidates,
  })

  const cancel = useIntentMutation<{ rows: readonly PlanRow[] }, PlanRow[]>({
    failed: 'Не отменилось',
    run: ({ rows }, key) =>
      Promise.all(
        rows.map((row) => commands.cancel({ key: `${key}:${row.id}`, row: row.id, reason: null })),
      ),
    invalidates,
    onSuccess: (rows) =>
      toast.show({
        message: rows.length === 1 ? 'Строка отменена' : `Отменено · ${rowsWord(rows.length)}`,
        reasons: REASONS.map((reason) => ({
          label: CANCEL_REASON_LABEL[reason],
          onSelect: () => giveReason.start({ rows, reason }),
        })),
      }),
  })

  const move = useIntentMutation<{ moves: readonly MoveRequest[] }, PlanRow[]>({
    failed: 'Не перенеслось',
    run: ({ moves }, key) =>
      Promise.all(
        moves.map(({ row, target }) =>
          commands.move({ key: `${key}:${row.id}`, row: row.id, version: row.version, target }),
        ),
      ),
    invalidates,
    onSuccess: (moved, { moves }) => {
      const first = moved[0]
      const message =
        moved.length === 1 && first
          ? `Перенесено · ${accountLabel(model.accounts, first.account)} · ${slotText(first.date, first.time)}`
          : `Перенесено · ${rowsWord(moved.length)}`
      // Отмена возвращает строки на прежние места: от их новых версий.
      const back = moved.flatMap((row) => {
        const before = moves.find((entry) => entry.row.id === row.id)?.row
        return before
          ? [{ row, target: { date: before.date, time: before.time, account: before.account } }]
          : []
      })
      toast.show({
        message,
        undoable: true,
        action: { label: 'Отменить', onSelect: () => move.start({ moves: back }) },
      })
    },
  })

  const update = useIntentMutation<UpdateRequest, PlanRow[]>({
    failed: 'Не сохранилось',
    run: ({ rows, change }, key) =>
      Promise.all(
        rows.map((row) =>
          commands.update({ key: `${key}:${row.id}`, row: row.id, version: row.version, change }),
        ),
      ),
    invalidates,
    onSuccess: (_, { done }) => toast.show({ message: done }),
  })

  /** Файлы строк: у каждой строки — названные ключи или все её файлы по порядку (§4.11). */
  const download = useIntentMutation<
    { rows: readonly PlanRow[]; kinds: readonly DownloadKind[] | null; stripMetadata: boolean },
    DownloadAnswer[]
  >({
    failed: 'Не скачалось',
    run: ({ rows, kinds, stripMetadata }, key) =>
      Promise.all(
        rows.flatMap((row) => {
          const manifest = row.manifest
          if (!manifest) {
            return []
          }
          const files = manifest.files.filter((file) => !kinds || kinds.includes(file.key))
          return files.map((file) =>
            commands.downloadRow({
              key: `${key}:${row.id}:${file.key}`,
              item: manifest.item_id,
              row: row.id,
              account: row.account,
              kind: file.key,
              stripMetadata,
            }),
          )
        }),
      ),
    invalidates,
    onSuccess: (answers) =>
      deliver(model.code, answers, {
        building: 'Копия для платформы собирается',
        // Расписку собранной копии ставит воркер, когда копия готова: строка перечитывается
        // тогда же, иначе «Уже скачивала» появится только после перезагрузки.
        onSaved: (files) => {
          toast.show({ message: savedMessage(files) })
          for (const queryKey of planChangedKeys(model.code)) {
            void queryClient.invalidateQueries({ queryKey })
          }
        },
      }),
  })

  return {
    cancel: (rows: readonly PlanRow[]) => cancel.start({ rows }),
    move: (row: PlanRow, target: MoveRowCommand) => move.start({ moves: [{ row, target }] }),
    moveMany: (moves: readonly MoveRequest[]) => move.start({ moves }),
    assign: (rows: readonly PlanRow[], person: PersonRef) =>
      update.start({ rows, change: { assignee: person.id }, done: `Передано · ${person.name}` }),
    replaceManifest: (row: PlanRow) =>
      update.start({ rows: [row], change: { replace_manifest: true }, done: 'Состав заменён' }),
    /** «↓» строки — её первый файл; `kind` — один файл из панели. */
    download: (row: PlanRow, stripMetadata = true, kind?: DownloadKind) => {
      const first = kind ?? row.manifest?.files[0]?.key
      download.start({ rows: [row], kinds: first ? [first] : [], stripMetadata })
    },
    /** «Скачать 3 ▾» в панели и «Скачать N ▾» в полосе — все файлы строк. */
    downloadAll: (rows: readonly PlanRow[], stripMetadata = true) =>
      download.start({ rows, kinds: null, stripMetadata }),
    downloading: download.isPending,
    cancelling: cancel.isPending,
  }
}
