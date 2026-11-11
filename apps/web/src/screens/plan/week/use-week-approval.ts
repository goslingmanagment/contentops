import type { AccountCode, BatchResult, IsoWeek, PlanRow, PlanWeek } from '@contentops/contracts'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { planChangedKeys, usePlanCommands } from '@/data/plan'
import { accountLabel } from '@/lib/words'
import { useCurrentModel } from '@/shell/model/model-context'
import { rowsWord } from '../shared/plan-text'

/**
 * «Утвердить неделю» и «Отозвать» в шапке столбца (DESIGN §4.12, решение владельца
 * 11.11.2026): владелец утверждает строки страницы за неделю такими, какими их видит, — с их
 * версиями; агент потом сам выкладывает бесплатные. Строка, изменённая за это время, остаётся
 * неутверждённой — об этом говорит полоска.
 */

/** Строки столбца, которые ещё могут уйти: живые, с файлами, не отмеченные, не отправленные. */
function openRows(data: PlanWeek | undefined, account: AccountCode): PlanRow[] {
  const sendable = new Set([undefined, 'draft', 'cancelled', 'not_published'])
  return (data?.rows ?? []).filter(
    (row) =>
      row.account === account &&
      row.cancelled === null &&
      row.mark === null &&
      row.manifest !== null &&
      sendable.has(row.hub?.publication?.state),
  )
}

export function useWeekApproval(week: IsoWeek, data: PlanWeek | undefined) {
  const model = useCurrentModel()
  const commands = usePlanCommands(model.code)
  const toast = useActionToast()
  const invalidates = () => planChangedKeys(model.code)
  const page = (account: AccountCode) => accountLabel(model.accounts, account)

  const approve = useIntentMutation<
    { account: AccountCode; rows: readonly { id: string; version: number }[] },
    BatchResult
  >({
    failed: 'Неделя не утвердилась',
    run: ({ account, rows }, key) => commands.approveWeek({ key, week, account, rows }),
    invalidates,
    onSuccess: (result, { account }) => {
      const done = result.results.filter((one) => one.ok).length
      const moved = result.results.filter((one) => one.code === 'version_mismatch').length
      toast.show({
        message:
          moved === 0
            ? `Неделя утверждена · ${page(account)} · ${rowsWord(done)}`
            : `Утверждено ${rowsWord(done)} · ${page(account)} · изменились, пока вы смотрели: ${moved} — посмотрите и утвердите снова`,
      })
    },
  })

  const revoke = useIntentMutation<{ account: AccountCode }, BatchResult>({
    failed: 'Утверждение не отозвалось',
    run: ({ account }, key) => commands.revokeWeekApproval({ key, week, account }),
    invalidates,
    onSuccess: (result, { account }) =>
      toast.show({
        message: `Утверждение отозвано · ${page(account)} · ${rowsWord(result.results.length)}`,
      }),
  })

  return {
    approve: (account: AccountCode) => {
      const rows = openRows(data, account).map((row) => ({ id: row.id, version: row.version }))
      if (rows.length === 0) {
        toast.show({ message: `Утверждать нечего · ${page(account)}` })
        return
      }
      approve.start({ account, rows })
    },
    revoke: (account: AccountCode) => revoke.start({ account }),
    pending: approve.isPending || revoke.isPending,
  }
}
