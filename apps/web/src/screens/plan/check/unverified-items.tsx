import {
  type CheckList,
  formatNumber,
  type LocalDate,
  SURFACE_LABEL,
  type UnverifiedRow,
  type UploadCheckResult,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { Skeleton } from '@contentops/ui/components/skeleton'
import { cn } from '@contentops/ui/lib/utils'
import { ChevronRightIcon } from 'lucide-react'
import { momentLabel } from './case-text'
import { CaseThumb } from './case-thumb'

/**
 * «Hub не смог проверить 38 — делать ничего не нужно · Почему» (DESIGN §4.15): одна серая
 * строка внизу очереди; по «Почему» — группы по причине с числом, внутри строки без
 * действий, у vault — «Проверить заливку».
 */

interface UnverifiedLineProps {
  unverified: CheckList['unverified']
  open: boolean
  onToggle: () => void
}

export function UnverifiedLine({ unverified, open, onToggle }: UnverifiedLineProps) {
  return (
    <div className="flex h-full items-center border-border border-t px-2 text-base text-muted-foreground">
      <p>
        Hub не смог проверить {formatNumber(unverified.total)} — делать ничего не нужно ·{' '}
        <Button variant="link" size="inline" aria-expanded={open} onClick={onToggle}>
          {open ? 'Свернуть' : 'Почему'}
        </Button>
      </p>
    </div>
  )
}

interface ReasonRowProps {
  reason: string
  count: number
  open: boolean
  onToggle: () => void
}

/** «Hub видит не все посты этой страницы · 31»: раскрывает строки этой причины. */
export function ReasonRow({ reason, count, open, onToggle }: ReasonRowProps) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex h-full w-full items-center gap-2 rounded-lg px-2 text-left text-base text-muted-foreground transition-colors duration-120 hover:bg-accent"
    >
      <ChevronRightIcon
        aria-hidden
        className={cn(
          'size-4 shrink-0 text-ink-3 transition-transform duration-120',
          open && 'rotate-90',
        )}
      />
      <span className="truncate">{reason}</span>
      <span className="text-ink-3 tabular-nums">· {formatNumber(count)}</span>
    </button>
  )
}

interface UnverifiedRowViewProps {
  row: UnverifiedRow
  pageLabel: string
  today: LocalDate
  /** Ответ на «Проверить заливку», если уже спрашивали. */
  uploadCheck: UploadCheckResult | undefined
  /** `null` — кнопки нет: строка не vault или человек только смотрит. */
  onCheckUpload: (() => void) | null
  pending: boolean
}

/** Строка «не проверено» 44: наша миниатюра, название, страница, где и когда; серое слово справа. */
export function UnverifiedRowView({
  row,
  pageLabel,
  today,
  uploadCheck,
  onCheckUpload,
  pending,
}: UnverifiedRowViewProps) {
  const where = `${pageLabel} · ${SURFACE_LABEL[row.surface]}`
  const subtitle = row.slot ? `${where} · ${momentLabel(row.slot, today)}` : where
  return (
    <div className="flex h-full items-center gap-3 pr-2 pl-8">
      <CaseThumb itemId={row.item_id} surface={row.surface} size="mini" dimmed />
      <div className="min-w-0 flex-1 text-muted-foreground">
        <p className="truncate text-sm">
          {row.item_id ? <span className="tabular-nums">{row.item_id} · </span> : null}
          {row.title}
        </p>
        <p className="truncate text-ink-3 text-xs tabular-nums">{subtitle}</p>
      </div>
      {uploadCheck ? (
        <span className="shrink-0 text-muted-foreground text-sm">{uploadCheck.text}</span>
      ) : onCheckUpload ? (
        <Button variant="outline" size="sm" pending={pending} onClick={onCheckUpload}>
          Проверить заливку
        </Button>
      ) : (
        <span className="shrink-0 text-muted-foreground text-sm">не проверено</span>
      )}
    </div>
  )
}

/** Заготовка на месте строк, пока они грузятся по «Почему». */
export function UnverifiedRowSkeleton() {
  return (
    <div aria-hidden className="flex h-full items-center gap-3 pr-2 pl-8">
      <Skeleton className="h-10 w-7.5 rounded-md" />
      <div className="flex flex-1 flex-col gap-1.5">
        <Skeleton className="h-3 w-1/3 rounded-sm" />
        <Skeleton className="h-2.5 w-24 rounded-sm" />
      </div>
    </div>
  )
}
