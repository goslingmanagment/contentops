import { type LocalDate, mskDate } from '@contentops/contracts'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useClock } from '@/data/api-session'
import { unplannedCaseIds, useCheckList } from '@/data/check'
import { usePlanDay } from '@/data/plan'
import { useHistoryScroll } from '@/lib/use-history-state'
import { useKeyboardShortcut } from '@/lib/use-keyboard-shortcut'
import { usePlanDialog } from '@/shell/dialogs/plan-dialog-context'
import { FieldLayout } from '@/shell/field/field-layout'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { useCurrentModel } from '@/shell/model/model-context'
import { useRowActions } from '../shared/actions/use-row-actions'
import { PlanHeader } from '../shared/plan-header'
import { peopleOf } from '../shared/plan-text'
import { usePlanAccess } from '../shared/use-plan-access'
import { usePlanWorkspace } from '../shared/use-plan-workspace'
import { DateStrip } from './date-strip'
import { DayBody } from './day-body'
import { DayChips } from './day-chips'
import { cancelledRevealKey, rowsOfItem } from './day-list'
import type { DayListHandlers } from './day-list-view'
import { DaySummary } from './day-summary'
import { DayTitle } from './day-title'
import { useDayItems } from './use-day-items'
import { useDayKeys } from './use-day-keys'

const routeApi = getRouteApi('/_shell/$model/plan/$date')

/**
 * План › День (DESIGN §4.11): сделать сегодняшнее — скачать, выложить или поставить в
 * планировщик, отметить. Экран собирается заново на каждый день, поэтому выделение и
 * прокрутка у каждого дня свои (они живут в записи истории).
 */
export function PlanDayView({ date }: { date: LocalDate }) {
  const model = useCurrentModel()
  const search = routeApi.useSearch()
  const navigate = useNavigate({ from: '/$model/plan/$date' })
  const access = usePlanAccess()
  const today = mskDate(useClock().now())
  const mineByRole = access.role === 'manager'
  const mine = search.mine ?? mineByRole
  const byTime = search.by === 'time'
  const showCancelled = search.show === 'cancelled'
  const pages = search.pages ?? []

  const day = usePlanDay(model.code, date, { mine, cancelled: showCancelled })
  const check = useCheckList(model.code)
  const data = day.data
  const scroll = useHistoryScroll('plan-day:scroll')
  const { openPlanDialog } = usePlanDialog()
  const rowActions = useRowActions()
  const [markMenuRow, setMarkMenuRow] = useState<string | null>(null)
  const { items, selection, selectedRows, selectRows } = useDayItems(data, {
    accounts: model.accounts,
    pages,
    mineOf: mine ? access.personId : null,
    byTime,
  })
  // «⋯ → Отменённые»: раздел встаёт в конец списка — прокручиваем к нему, когда он пришёл.
  const [revealCancelled, setRevealCancelled] = useState(false)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const cancelledKey = cancelledRevealKey(items)
  useEffect(() => {
    if (revealCancelled && cancelledKey) {
      setFocusKey(cancelledKey)
      setRevealCancelled(false)
    }
  }, [revealCancelled, cancelledKey])
  const shownRowIds = useMemo(
    () => new Set(items.flatMap(rowsOfItem).map((row) => row.id)),
    [items],
  )
  const workspace = usePlanWorkspace({
    panelKey: 'plan-day',
    selectedRows,
    releases: data?.releases ?? [],
    selectRows,
    clearSelection: selection.clear,
    canAct: access.canAct,
  })
  const setSearch = (patch: Partial<typeof search>) =>
    void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true })
  const outsidePlan = access.canAct
    ? (account?: string) =>
        openPlanDialog([], {
          accounts: account ? [account] : undefined,
          surface: 'story',
          date,
          outside: true,
        })
    : null

  const handlers: DayListHandlers = {
    menuFor: workspace.menuFor,
    selectRows,
    checkRow: (row) => workspace.openRows([row]),
    uploadMontage: workspace.upload.uploadFor,
    setFilesOver: workspace.upload.setFilesOver,
    downloadRow: (row) => rowActions.download(row),
    pickGap: (gap) =>
      openPlanDialog([], {
        accounts: [gap.account],
        surface: gap.surface,
        date: gap.date,
        time: gap.time,
        kind: gap.kind,
      }),
    openCheck: (account) => {
      const [only, ...more] = unplannedCaseIds(check.data, account, date)
      void (only && more.length === 0
        ? navigate({ to: '/$model/plan/check/$case', params: { model: model.code, case: only } })
        : navigate({
            to: '/$model/plan/check',
            params: { model: model.code },
            search: { page: account },
          }))
    },
    outsidePlan,
    openRow: workspace.openRows,
    previewRow: (rows) => {
      const row = rows[0]
      const id = row?.manifest?.item_id
      if (row && id) {
        void navigate({
          to: '/$model/i/$id',
          params: { model: model.code, id },
          search: { view: row.surface === 'story' ? 'teaser' : 'master' },
        })
      }
    },
  }

  useDayKeys({
    row: selectedRows.length === 1 ? (selectedRows[0] ?? null) : null,
    canAct: access.canAct,
    onOpenPanel: () => workspace.openRows(selectedRows),
    onUploadMontage: workspace.upload.uploadFor,
    onOpenMarkMenu: setMarkMenuRow,
  })
  useKeyboardShortcut({ code: 'Escape', enabled: selectedRows.length > 0 }, selection.clear)

  return (
    <FieldLayout
      aside={workspace.aside({
        empty: data ? <DaySummary day={data} accounts={model.accounts} /> : null,
        people: data ? peopleOf(data.groups, data.rows) : [],
        today,
      })}
    >
      <PlanHeader
        active="day"
        date={date}
        onPlan={() => openPlanDialog([])}
        info={workspace.info}
        selectionBar={workspace.selectionBar}
      />
      <DateStrip
        model={model.code}
        date={date}
        today={today}
        dots={data?.week_dots ?? []}
        search={search}
      />
      <DayChips
        accounts={model.accounts}
        mine={mine}
        onMineChange={(next) => setSearch({ mine: next === mineByRole ? undefined : next })}
        pages={pages}
        onPagesChange={(next) => setSearch({ pages: next.length > 0 ? next : undefined })}
        byTime={byTime}
        onByTimeChange={(next) => setSearch({ by: next ? 'time' : undefined })}
        cancelledCount={data?.cancelled_count ?? 0}
        showCancelled={showCancelled}
        onShowCancelledChange={(next) => {
          setSearch({ show: next ? 'cancelled' : undefined })
          setRevealCancelled(next)
          setFocusKey(null)
        }}
        onOutsidePlan={outsidePlan ? () => outsidePlan() : null}
        onReset={() => setSearch({ pages: undefined, by: undefined, show: undefined })}
      />
      <DayTitle
        date={date}
        today={today}
        accounts={model.accounts}
        rows={data?.rows ?? []}
        releases={data?.releases ?? []}
        integration={data?.integration ?? null}
        shownRowIds={shownRowIds}
        sizeBytes={data?.download_size_bytes ?? 0}
        mine={mine}
        canDownload={access.canAct}
        onSelectRelease={(chosen) => selectRows(chosen.row_ids)}
      />
      <RefreshStrip active={day.isFetching && data !== undefined} />
      <DayBody
        query={day}
        onPlan={access.canAct ? () => openPlanDialog([], { date }) : null}
        list={{
          items,
          accounts: model.accounts,
          canAct: access.canAct,
          selectedKeys: selection.selectedKeys,
          onSelectedKeysChange: (next) => {
            workspace.stopEditing()
            selection.setSelectedKeys(next)
          },
          markMenuRow,
          onMarkMenuRowChange: setMarkMenuRow,
          handlers,
          initialScrollOffset: scroll.initialOffset,
          onScrollOffsetChange: scroll.onScrollOffsetChange,
          focusKey,
        }}
      />
    </FieldLayout>
  )
}
