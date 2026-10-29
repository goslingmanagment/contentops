import { type CheckCase, formatAgo, isApiError, mskDate } from '@contentops/contracts'
import { PanelMessage } from '@contentops/ui/components/panel-frame'
import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { useClock } from '@/data/api-session'
import { useCatalogIndex } from '@/data/catalog'
import { type ClosedView, isOpenCase, useClosedCases } from '@/data/check'
import { useRole } from '@/data/session'
import { useHistoryScroll, useHistoryState } from '@/lib/use-history-state'
import { useKeyboardShortcut } from '@/lib/use-keyboard-shortcut'
import { useMediaQuery } from '@/lib/use-media-query'
import { FieldLayout } from '@/shell/field/field-layout'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { useCurrentModel } from '@/shell/model/model-context'
import { BulkConfirm } from './bulk-confirm'
import { type CaseFilter, nextOpenCase } from './case-groups'
import { type DecisionKey, keyAction } from './case-kinds'
import { CaseRow } from './case-row'
import { CheckChips } from './check-chips'
import { CheckHeader } from './check-header'
import { ClosedList } from './closed-list'
import { ClosedPanel } from './closed-panel'
import { QueueBody } from './queue-body'
import { SelectedCasePanel } from './selected-case-panel'
import { useBulkConfirm } from './use-bulk-confirm'
import { useCaseActions } from './use-case-actions'
import { useCaseDecisions } from './use-case-decisions'
import { useCheckQueue } from './use-check-queue'
import { useMissingCase } from './use-missing-case'

export interface CheckSearch extends CaseFilter {
  show?: ClosedView
}

interface CheckViewProps {
  search: CheckSearch
  onSearchChange: (next: CheckSearch) => void
  /** Выбранный случай — из адреса `#/<модель>/plan/check/<id>`; `null` — панель закрыта. */
  caseId: string | null
  /** Выбор другого случая или закрытие панели пишется в адрес. */
  onCaseChange: (caseId: string | null) => void
}

const SelectedSchema = z.string().nullable()

function focusListIn(container: HTMLElement | null) {
  container?.querySelector<HTMLElement>('[role="listbox"]')?.focus({ preventScroll: true })
}

/**
 * План › Сверить (DESIGN §4.15): решить, где Hub сомневается или где пост вышел без плана.
 * Главное действие — «Это оно». Очередь по страницам слева, панель пары 400 справа.
 */
export function CheckView({ search, onSearchChange, caseId, onCaseChange }: CheckViewProps) {
  const model = useCurrentModel()
  const role = useRole()
  const canDecide = role === 'owner' || role === 'manager'
  const now = useClock().now()
  const today = mskDate(now)
  const narrow = useMediaQuery('(max-width: 1319px)')
  const catalog = useCatalogIndex(model.code).data?.byId
  const filter: CaseFilter = { page: search.page, week: search.week }
  const queue = useCheckQueue(model, filter)
  const missingCase = useMissingCase(model.code, caseId ?? undefined, queue.list.data)
  // Выдуманного или чужого случая нет — серая строка на месте панели; решённый — строка
  // «Случай уже решён · Решённые» над очередью (§3.10).
  const caseGone = isApiError(missingCase) && missingCase.status === 404
  const listRef = useRef<HTMLDivElement>(null)
  const scroll = useHistoryScroll('check:scroll')
  const selectedId = caseId
  // Решение приходит позже выбора: фокус уходит дальше, только если случай всё ещё выбран.
  const selectedRef = useRef(caseId)
  useEffect(() => {
    selectedRef.current = caseId
  }, [caseId])
  const [focusSearch, setFocusSearch] = useState(false)
  const closed = useClosedCases(model.code, search.show ?? 'done', search.show !== undefined)
  const [closedId, setClosedId] = useHistoryState('check:closed', SelectedSchema, () => null)
  const closedSelected = search.show
    ? (closed.data?.find((entry) => entry.case_id === closedId) ?? null)
    : null

  const select = useCallback(
    (next: string | null, withSearch = false) => {
      onCaseChange(next)
      setFocusSearch(withSearch)
    },
    [onCaseChange],
  )

  const { inOrder } = queue
  const moveOn = useCallback(
    (decided: string) => {
      const next = selectedRef.current === decided ? nextOpenCase(inOrder, decided) : null
      if (next) {
        onCaseChange(next)
      }
      focusListIn(listRef.current)
    },
    [inOrder, onCaseChange],
  )
  const decisions = useCaseDecisions(model.code, {
    view: search.show ?? 'open',
    onSettled: moveOn,
  })
  const showClosed = (show: ClosedView | null) =>
    onSearchChange({ ...search, show: show ?? undefined })
  const bulk = useBulkConfirm(model.code, {
    onShow: (caseId) => select(caseId),
    onShowDone: () => showClosed('done'),
  })
  const { act, accountOf, menuFor } = useCaseActions({
    accounts: model.accounts,
    canDecide,
    decisions,
    select,
    canCheckUpload: queue.canCheckUpload,
  })

  const selected = queue.cases.find((entry) => entry.id === selectedId) ?? null
  const firstOpen = queue.inOrder.find(isOpenCase)?.id ?? null
  useKeyboardShortcut({ code: 'KeyI', enabled: !search.show }, () =>
    select(selected ? null : firstOpen),
  )

  /** Цифра без выбранного случая сначала встаёт на первый открытый: решать вслепую нельзя. */
  const onDecisionKey = (key: DecisionKey) => {
    if (!selected) {
      select(firstOpen)
      return
    }
    const action = canDecide && isOpenCase(selected) ? keyAction(selected, key) : null
    if (action) {
      act[action](selected)
    }
  }

  const renderCase = (entry: CheckCase, isSelected: boolean) => (
    <CaseRow
      entry={entry}
      platform={accountOf(entry)?.platform ?? 'fansly'}
      ours={entry.item_id ? catalog?.get(entry.item_id) : undefined}
      today={today}
      selected={isSelected}
      compact={selected !== null}
      uploadCheck={decisions.uploadChecks.get(entry.id)}
      pending={decisions.pending?.caseId === entry.id ? decisions.pending.action : null}
      canDecide={canDecide}
      menu={menuFor(entry)}
      onAction={(action) => act[action](entry)}
    />
  )

  const { list } = queue
  const accountByCode = (code: string) => model.accounts.find((account) => account.code === code)

  const closedAside =
    search.show && closedSelected ? (
      <ClosedPanel
        entry={closedSelected}
        view={search.show}
        account={accountByCode(closedSelected.account)}
        now={now}
        today={today}
        canDecide={canDecide}
        decisions={decisions}
        width={narrow ? 'narrow' : 'wide'}
        onClose={() => setClosedId(null)}
      />
    ) : null

  return (
    <FieldLayout
      aside={
        search.show ? (
          closedAside
        ) : caseGone && !selected ? (
          <PanelMessage
            label="Случай сверки"
            width={narrow ? 'narrow' : 'wide'}
            onClose={() => select(null)}
          >
            Такого случая сверки у {model.name_genitive} нет
          </PanelMessage>
        ) : selected ? (
          <SelectedCasePanel
            entry={selected}
            account={accountOf(selected)}
            ours={selected.item_id ? catalog?.get(selected.item_id) : undefined}
            today={today}
            canDecide={canDecide}
            canCheckUpload={queue.canCheckUpload(selected.account)}
            decisions={decisions}
            focusSearch={focusSearch}
            menu={menuFor(selected)}
            width={narrow ? 'narrow' : 'wide'}
            onClose={() => select(null)}
          />
        ) : null
      }
    >
      <CheckHeader
        today={today}
        bulk={
          canDecide && !search.show && queue.unambiguous.length > 0 ? (
            <BulkConfirm
              cases={queue.unambiguous}
              accounts={model.accounts}
              catalog={catalog}
              pending={bulk.isPending}
              onConfirm={bulk.start}
            />
          ) : null
        }
        info={
          search.show
            ? {
                open: closedSelected !== null,
                onToggle: () =>
                  setClosedId(closedSelected ? null : (closed.data?.[0]?.case_id ?? null)),
              }
            : { open: selected !== null, onToggle: () => select(selected ? null : firstOpen) }
        }
      />
      <CheckChips
        closed={search.show ?? null}
        accounts={model.accounts}
        weeks={queue.weeks}
        filter={filter}
        onFilterChange={(next) => onSearchChange({ ...search, ...next })}
        hubLine={queue.hubRowLine}
        counts={
          list.data ? { done: list.data.resolved_count, notOurs: list.data.not_ours_count } : null
        }
        onShow={showClosed}
      />
      <RefreshStrip active={!search.show && list.isFetching && list.data !== undefined} />
      <div className="flex min-h-0 flex-1 flex-col pt-3">
        {search.show ? (
          <ClosedList
            view={search.show}
            list={closed}
            accounts={model.accounts}
            now={now}
            today={today}
            canDecide={canDecide}
            decisions={decisions}
            selectedId={closedSelected?.case_id ?? null}
            onSelect={setClosedId}
          />
        ) : (
          <QueueBody
            list={list}
            missingCase={caseGone ? null : missingCase}
            onShowDone={() => showClosed('done')}
            items={queue.queue}
            today={today}
            selectedId={selected ? selectedId : null}
            onSelect={(caseId) => select(caseId)}
            onOpen={(caseId) => select(caseId)}
            onDecisionKey={onDecisionKey}
            renderCase={renderCase}
            unverified={{
              toggle: queue.toggleUnverified,
              toggleReason: queue.toggleReason,
              uploadChecks: decisions.uploadChecks,
              onCheckUpload: canDecide ? decisions.checkUpload : null,
              canCheckUpload: queue.canCheckUpload,
              pageLabel: (account) => accountByCode(account)?.label ?? account,
              pendingCaseId: decisions.pending?.caseId ?? null,
            }}
            onResetFilter={() => onSearchChange({ show: search.show })}
            emptyText={
              queue.hubUpdatedAt
                ? `Сверять нечего. Hub обновлён ${formatAgo(queue.hubUpdatedAt, now)}`
                : 'Сверять нечего'
            }
            listRef={listRef}
            initialScrollOffset={scroll.initialOffset}
            onScrollOffsetChange={scroll.onScrollOffsetChange}
          />
        )}
      </div>
    </FieldLayout>
  )
}
