import type { Account, Instant, LocalDate, ResolvedCase } from '@contentops/contracts'
import { EmptyState, ErrorLine } from '@contentops/ui/components/state-lines'
import { StatusWord } from '@contentops/ui/components/status-word'
import { StopRowClick } from '@contentops/ui/components/stop-row-click'
import { VirtualList } from '@contentops/ui/components/virtual-list'
import { WhyPopover } from '@contentops/ui/components/why-popover'
import { cn } from '@contentops/ui/lib/utils'
import type { UseQueryResult } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { ClosedView } from '@/data/check'
import { pickOne } from './case-queue'
import { subjectSubtitle, subjectTitle } from './case-text'
import { CaseThumb } from './case-thumb'
import { CheckSkeleton } from './check-skeleton'
import { DecisionWord, decisionLine, UndoButton } from './closed-case'
import type { CaseDecisions } from './use-case-decisions'

const EMPTY_TEXT: Record<ClosedView, string> = {
  done: 'За 14 дней решённых нет',
  'not-ours': 'Не нашего нет',
}

interface ClosedRowProps {
  entry: ResolvedCase
  view: ClosedView
  account: Account | undefined
  now: Instant
  today: LocalDate
  canDecide: boolean
  decisions: CaseDecisions
  /** Выбранная строка (мышью или стрелками): «Отменить» видно и без наведения. */
  selected: boolean
  /** Панель открыта: кнопка — в ней, строка не теряет название даже на 1280. */
  compact: boolean
}

/**
 * Строка решённого (DESIGN §4.15): слева — как в очереди, «Зеркало, чёрное боди» или у
 * поста без плана его подпись, серым «Fansly 1 · стена · 11:02 · видео 0:07»; в середине
 * итог и «Диана · 15.09 21:30». В «Решённых» строк много, поэтому «Отменить» появляется
 * при наведении и в панели; в «Не наше» «Вернуть в разбор» стоит на виду. При открытой
 * панели кнопка только в ней.
 */
function ClosedRow({
  entry,
  view,
  account,
  now,
  today,
  canDecide,
  decisions,
  selected,
  compact,
}: ClosedRowProps) {
  // Вернули в разбор: строка остаётся на месте серой, в очереди случай уже ждёт (§1, п. 7).
  const reopened = decisions.reopened.has(entry.case_id)
  const onHover = view === 'done' && !selected
  return (
    <div
      className={cn(
        'group/row flex h-16 cursor-default items-center gap-3 rounded-lg px-2 transition-colors duration-120',
        selected ? 'bg-primary-tint' : 'hover:bg-accent',
      )}
    >
      <CaseThumb itemId={entry.item_id} surface={entry.surface} dimmed />
      <div className="min-w-0 flex-1 text-muted-foreground">
        <p className="truncate text-base">{subjectTitle(entry)}</p>
        <p className="truncate text-ink-3 text-sm tabular-nums">
          {entry.version_label ? `${entry.version_label} · ` : null}
          {account?.label ?? entry.account} · {subjectSubtitle(entry, today)}
        </p>
      </div>
      <div className="flex w-72 shrink-0 flex-col items-start gap-0.5">
        {reopened ? (
          <StatusWord>снова в разборе</StatusWord>
        ) : (
          <StopRowClick>
            <WhyPopover
              hint="Как проверяли"
              title={<DecisionWord entry={entry} />}
              facts={entry.how_checked}
            >
              <DecisionWord entry={entry} />
            </WhyPopover>
          </StopRowClick>
        )}
        <span className="w-full truncate text-ink-3 text-sm tabular-nums">
          {decisionLine(entry, now)}
        </span>
      </div>
      {compact ? null : (
        <div className="flex w-44 shrink-0 justify-end">
          {canDecide && !reopened ? (
            <StopRowClick>
              <UndoButton
                entry={entry}
                view={view}
                decisions={decisions}
                className={cn(
                  onHover &&
                    'opacity-0 transition-opacity duration-120 focus-visible:opacity-100 group-hover/row:opacity-100',
                )}
              />
            </StopRowClick>
          ) : null}
        </div>
      )}
    </div>
  )
}

interface ClosedListProps {
  view: ClosedView
  list: UseQueryResult<readonly ResolvedCase[]>
  accounts: readonly Account[]
  now: Instant
  today: LocalDate
  canDecide: boolean
  decisions: CaseDecisions
  /** Решённый случай, открытый в панели. */
  selectedId: string | null
  onSelect: (caseId: string | null) => void
}

/**
 * «Решённые за 14 дней» и «Не наше» (DESIGN §4.15): кто решил, когда и как. Строка
 * открывает пару в панели; «Отменить» — как проверяли, остаётся в истории.
 */
export function ClosedList({
  view,
  list,
  accounts,
  now,
  today,
  canDecide,
  decisions,
  selectedId,
  onSelect,
}: ClosedListProps) {
  const byCode = useMemo(
    () => new Map(accounts.map((account) => [account.code, account])),
    [accounts],
  )
  const selectedKeys = useMemo(() => new Set<string>(selectedId ? [selectedId] : []), [selectedId])

  if (list.isPending) {
    return <CheckSkeleton />
  }
  if (list.isError) {
    return (
      <ErrorLine layout="center" message="Не загрузилось" onRetry={() => void list.refetch()} />
    )
  }
  if (list.data.length === 0) {
    return <EmptyState>{EMPTY_TEXT[view]}</EmptyState>
  }
  return (
    <div className="-mx-2 min-h-0 flex-1">
      <VirtualList
        items={list.data}
        getKey={(entry) => entry.case_id}
        getItemHeight={() => 64}
        selectedKeys={selectedKeys}
        onSelectedKeysChange={(next) => onSelect(pickOne(next, selectedId))}
        onOpen={(entry) => onSelect(entry.case_id)}
        renderItem={(entry, state) => (
          <ClosedRow
            entry={entry}
            view={view}
            account={byCode.get(entry.account)}
            now={now}
            today={today}
            canDecide={canDecide}
            decisions={decisions}
            selected={state.selected}
            compact={selectedId !== null}
          />
        )}
        label={view === 'done' ? 'Решённые за 14 дней' : 'Не наше'}
        className="px-2 pb-8"
      />
    </div>
  )
}
