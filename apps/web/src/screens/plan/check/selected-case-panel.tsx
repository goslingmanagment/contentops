import type { Account, CatalogEntry, CheckCase, LocalDate } from '@contentops/contracts'
import type { ItemMenuModel } from '@contentops/ui/components/item-menu'
import { isOpenCase } from '@/data/check'
import { usePlanDialog } from '@/shell/dialogs/plan-dialog-context'
import { PairPanel } from './pair/pair-panel'
import type { CaseDecisions } from './use-case-decisions'

interface SelectedCasePanelProps {
  entry: CheckCase
  account: Account | undefined
  ours: CatalogEntry | undefined
  today: LocalDate
  canDecide: boolean
  /** Hub страницы может проверить заливку: у выключенного и не настроенного — нет. */
  canCheckUpload: boolean
  decisions: CaseDecisions
  focusSearch: boolean
  menu: ItemMenuModel
  width: 'wide' | 'narrow'
  onClose: () => void
}

/**
 * Панель выбранного случая: решения идут в общий хук экрана, «Залить заново» открывает
 * окно «В план» для объекта с той же страницей и местом и включённым «Залить заново». Решённый случай виден с новым словом, но без кнопок.
 */
export function SelectedCasePanel({
  entry,
  account,
  decisions,
  canDecide,
  canCheckUpload,
  ...props
}: SelectedCasePanelProps) {
  const planDialog = usePlanDialog()
  if (!account) {
    return null
  }
  const itemId = entry.item_id
  return (
    <PairPanel
      {...props}
      entry={entry}
      account={account}
      canDecide={canDecide && isOpenCase(entry)}
      pending={decisions.pending?.caseId === entry.id ? decisions.pending.action : null}
      onDecide={decisions.decide}
      uploadCheck={decisions.uploadChecks.get(entry.id)}
      onCheckUpload={canCheckUpload ? () => decisions.checkUpload(entry.id) : null}
      onReupload={() =>
        itemId
          ? planDialog.openPlanDialog([itemId], {
              accounts: [entry.account],
              surface: entry.surface,
              reupload: true,
            })
          : undefined
      }
    />
  )
}
