import type { PlanRow } from '@contentops/contracts'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { planChangedKeys, usePlanCommands } from '@/data/plan'
import { accountLabel } from '@/lib/words'
import { useCurrentModel } from '@/shell/model/model-context'

/**
 * Публикация строки через Hub (DESIGN §4.11, SPEC §7): «Подготовить» — Hub получает файлы и
 * делает черновик с проверками; «Отправить» — человек видел проверки и подтверждает;
 * «Отменить публикацию» — пока Hub не поставил её в расписание площадки. Работа идёт в фоне:
 * строка сама сменит «Hub готовит…» на проверки или статус.
 */
export function usePublishActions() {
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

  return {
    prepare: (row: PlanRow) => prepare.start({ row }),
    send: (row: PlanRow, version: number) => send.start({ row, version }),
    cancel: (row: PlanRow) => cancel.start({ row }),
    preparing: prepare.isPending,
    sending: send.isPending,
    cancelling: cancel.isPending,
  }
}
