import { type Account, formatNumber, type PlanRow, SURFACE_LABEL } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { cn } from '@contentops/ui/lib/utils'
import { CheckIcon } from 'lucide-react'
import { useMarkActions } from '../shared/actions/use-mark-actions'
import { isDoneRow, pagesLabel } from '../shared/plan-text'
import { rememberedMarkKind } from '../shared/row-action'
import { RowStatus } from '../shared/row-status'
import { RowThumb } from '../shared/row-thumb'
import { RowActions, RowTime, STATUS_COLUMN, TITLE_COLUMN } from './day-row'

interface MergedRowProps {
  rows: readonly PlanRow[]
  accounts: readonly Account[]
  selected: boolean
  canAct: boolean
}

/**
 * Вид «по времени» (DESIGN §4.11): один объект в одно время на нескольких страницах —
 * одна строка «SET-074 · стена 20:00 · Fansly 1, 2, 3» и кнопка «Отметить все 3».
 */
export function MergedRow({ rows, accounts, selected, canAct }: MergedRowProps) {
  const marks = useMarkActions()
  const first = rows[0]
  if (!first?.manifest) {
    return null
  }
  const pages = pagesLabel(
    accounts.filter((account) => rows.some((row) => row.account === account.code)),
  )
  const open = rows.every(
    (row) => row.verdict.level === 'planned' || row.verdict.level === 'missed',
  )
  const confirm = first.mark_button === 'mark_confirm'
  const count = formatNumber(rows.length)
  return (
    <div
      data-selected={selected}
      className={cn(
        'flex h-13.5 items-center gap-3 rounded-lg px-2 transition-colors duration-120 hover:bg-accent data-[selected=true]:bg-primary-tint',
        isDoneRow(first) && 'text-muted-foreground',
      )}
    >
      <RowTime time={first.time} />
      <RowThumb row={first} />
      <div className={cn('flex flex-col', TITLE_COLUMN)}>
        <span className="truncate text-base">{first.manifest.title}</span>
        <span className="truncate text-ink-3 text-sm">
          {first.manifest.item_id} · {SURFACE_LABEL[first.surface]} {first.time} · {pages}
        </span>
      </div>
      <RowStatus row={first} canAct={canAct} className={STATUS_COLUMN} />
      <RowActions>
        {canAct && open ? (
          <Button
            variant="outline"
            size="sm"
            pending={marks.pending}
            onClick={() =>
              confirm ? marks.markConfirmMany(rows) : marks.markMany(rows, rememberedMarkKind())
            }
          >
            {confirm ? null : <CheckIcon />}
            {confirm ? `Отметить и подтвердить все ${count}` : `Отметить все ${count}`}
          </Button>
        ) : null}
      </RowActions>
    </div>
  )
}
