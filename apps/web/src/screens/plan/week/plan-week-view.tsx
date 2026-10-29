import { type AccountCode, type IsoWeek, mskDate, weekStart } from '@contentops/contracts'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useClock } from '@/data/api-session'
import { usePlanWeek, useWeekNorms } from '@/data/plan'
import { useKeyboardShortcut } from '@/lib/use-keyboard-shortcut'
import { usePlanDialog } from '@/shell/dialogs/plan-dialog-context'
import { FieldLayout } from '@/shell/field/field-layout'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { useCurrentModel } from '@/shell/model/model-context'
import { PlanHeader } from '../shared/plan-header'
import { peopleOf } from '../shared/plan-text'
import { usePlanAccess } from '../shared/use-plan-access'
import { usePlanWorkspace } from '../shared/use-plan-workspace'
import { drawerTypeFor } from './drawer-candidates'
import { useWeekActions } from './use-week-actions'
import { useWeekSelection } from './use-week-selection'
import { WeekBody } from './week-body'
import { WeekDnd } from './week-dnd'
import type { DrawerState } from './week-drawer'
import { WeekDrawerSlot } from './week-drawer-slot'
import type { GridHandlers } from './week-grid'
import { firstGapSurface, orderedRows } from './week-layout'
import { WeekNav } from './week-nav'
import { WeekSummary } from './week-summary'

const routeApi = getRouteApi('/_shell/$model/plan/w/$week')

/**
 * План › Неделя (DESIGN §4.12): поставить неделю за ≈40 кликов и видеть дыры против нормы.
 * Это же — недельная сводка темпа: прошлая неделя открывается «‹».
 */
export function PlanWeekView({ week }: { week: IsoWeek }) {
  const model = useCurrentModel()
  const search = routeApi.useSearch()
  const navigate = useNavigate({ from: '/$model/plan/w/$week' })
  const access = usePlanAccess()
  const today = mskDate(useClock().now())
  const plan = usePlanWeek(model.code, week)
  const data = plan.data
  const { norms } = useWeekNorms(
    model.code,
    model.accounts.map((account) => account.code),
  )
  const { openPlanDialog } = usePlanDialog()
  const actions = useWeekActions(week, data, today, access)
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const order = useMemo(
    () => (data ? orderedRows(data, model.accounts) : []),
    [data, model.accounts],
  )
  const selection = useWeekSelection(order)
  const selectedRows = order.filter((row) => selection.selectedKeys.has(row.id))
  const workspace = usePlanWorkspace({
    panelKey: 'plan-week',
    selectedRows,
    releases: data?.releases ?? [],
    selectRows: selection.selectRows,
    clearSelection: selection.clear,
    canAct: access.canAct,
  })
  const pagesVariant = search.variant === 'pages'
  const page = model.accounts.find((account) => account.code === search.page) ?? model.accounts[0]

  const openEmpty = (account: AccountCode) => {
    if (data) {
      setDrawer({ account, type: drawerTypeFor(firstGapSurface(data, account)) })
    }
  }
  const handlers: GridHandlers = {
    menuFor: workspace.menuFor,
    selectRow: (row, event) => {
      workspace.stopEditing()
      selection.selectRow(row, event)
    },
    openRow: (row) => workspace.openRows([row]),
    pickGap: (gap) =>
      openPlanDialog([], {
        accounts: [gap.account],
        surface: gap.surface,
        date: gap.date,
        time: gap.time,
        kind: gap.kind,
      }),
    selectRows: (ids) => {
      workspace.stopEditing()
      selection.selectRows(ids)
    },
    openEmpty,
  }

  useKeyboardShortcut(
    { code: 'Escape', enabled: selectedRows.length > 0 && drawer === null },
    selection.clear,
  )
  useKeyboardShortcut({ code: 'Escape', enabled: drawer !== null }, () => setDrawer(null))

  return (
    <FieldLayout
      aside={workspace.aside({
        empty: data ? <WeekSummary week={data} accounts={model.accounts} /> : null,
        people: data ? peopleOf([], data.rows) : [],
        today,
      })}
    >
      <PlanHeader
        active="week"
        date={weekStart(week) > today ? weekStart(week) : today}
        onPlan={() => openPlanDialog([])}
        info={workspace.info}
        selectionBar={workspace.selectionBar}
      />
      <WeekNav
        model={model.code}
        week={week}
        today={today}
        search={search}
        drawerOpen={drawer !== null}
        onToggleDrawer={() => {
          const first = page?.code ?? model.accounts[0]?.code
          if (drawer) {
            setDrawer(null)
          } else if (first) {
            openEmpty(first)
          }
        }}
        download={actions.download}
        menu={actions.menu}
      />
      <RefreshStrip active={plan.isFetching && data !== undefined} />
      <WeekDnd norms={norms} canAct={access.canAct} onOpenDialog={openPlanDialog}>
        <div className="relative -mx-7 mt-2 flex min-h-0 flex-1 flex-col">
          <WeekBody
            query={plan}
            accounts={model.accounts}
            today={today}
            selectedKeys={selection.selectedKeys}
            canAct={access.canAct}
            handlers={handlers}
            pagesVariant={
              pagesVariant && page
                ? {
                    page,
                    onPageChange: (code) =>
                      void navigate({
                        search: (previous) => ({ ...previous, page: code }),
                        replace: true,
                      }),
                  }
                : null
            }
          />
          {drawer ? (
            <WeekDrawerSlot
              state={drawer}
              onStateChange={setDrawer}
              week={week}
              norms={norms}
              gaps={data?.gaps ?? []}
              canAct={access.canAct}
              onOpenDialog={openPlanDialog}
              onClose={() => setDrawer(null)}
            />
          ) : null}
        </div>
      </WeekDnd>
    </FieldLayout>
  )
}
