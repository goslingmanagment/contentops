import { type Account, type CatalogEntry, type ItemId, mskDate } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { SelectionBar } from '@contentops/ui/components/selection-bar'
import { CalendarPlusIcon, CheckIcon } from 'lucide-react'
import { useClock } from '@/data/api-session'
import { useRole } from '@/data/session'
import { useObjectDialogs } from '@/objects/dialogs/use-object-dialogs'
import { useEntriesMenu } from '@/objects/entries-menu'
import { usePlanDialog } from '@/shell/dialogs/plan-dialog-context'
import { backlogPlanPreset } from './backlog'
import { useAlreadyUploaded } from './use-already-uploaded'

interface BacklogActionsProps {
  account: Account
  selected: readonly CatalogEntry[]
  onMarked: () => void
  onShowFailed: (ids: ItemId[]) => void
}

/** «В план» со страницей вкладки и местом, «Уже залито» — одни и те же в полосе и панели. */
export function useBacklogActions({
  account,
  selected,
  onMarked,
  onShowFailed,
}: BacklogActionsProps) {
  const role = useRole()
  const today = mskDate(useClock().now())
  const { openPlanDialog } = usePlanDialog()
  const { markUploaded, marking } = useAlreadyUploaded(account, { onMarked, onShowFailed })
  return {
    canAct: role === 'owner' || role === 'manager',
    plan: () =>
      openPlanDialog(
        selected.map((entry) => entry.id),
        backlogPlanPreset(account.code, selected, today),
      ),
    markUploaded: () => markUploaded(selected),
    marking,
  }
}

/**
 * Полоса выделения «Ещё не залито» (DESIGN §3.3): «В план» (страница и куда подставлены),
 * «Уже залито»; в «⋯» — как в Библиотеке.
 */
export function BacklogSelectionBar({
  onClear,
  ...props
}: BacklogActionsProps & { onClear: () => void }) {
  const actions = useBacklogActions(props)
  const dialogs = useObjectDialogs()
  const menu = useEntriesMenu(props.selected, {
    openDialog: dialogs.open,
    omit: ['open', 'plan'],
  })
  return (
    <>
      <SelectionBar count={props.selected.length} onClear={onClear} menu={menu}>
        {actions.canAct ? (
          <>
            <Button onClick={actions.plan}>
              <CalendarPlusIcon />В план
            </Button>
            <Button variant="bar" onClick={actions.markUploaded} aria-busy={actions.marking}>
              <CheckIcon />
              {actions.marking ? 'Уже залито…' : 'Уже залито'}
            </Button>
          </>
        ) : null}
      </SelectionBar>
      {dialogs.element}
    </>
  )
}

/** Те же кнопки в панели при нескольких выбранных (§3.4). */
export function BacklogPanelActions(props: BacklogActionsProps) {
  const actions = useBacklogActions(props)
  if (!actions.canAct) {
    return null
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={actions.plan}>В план</Button>
      <Button variant="secondary" onClick={actions.markUploaded} aria-busy={actions.marking}>
        {actions.marking ? 'Уже залито…' : 'Уже залито'}
      </Button>
    </div>
  )
}
