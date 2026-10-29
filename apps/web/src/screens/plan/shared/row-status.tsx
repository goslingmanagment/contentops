import type { PlanRow } from '@contentops/contracts'
import { StatusWord } from '@contentops/ui/components/status-word'
import { type WhyAction, WhyPopover } from '@contentops/ui/components/why-popover'
import { cn } from '@contentops/ui/lib/utils'
import { type ReactNode, useState } from 'react'
import { useMarkActions } from './actions/use-mark-actions'
import { rowCaption } from './plan-text'
import { MARK_KIND_LABEL, rememberedMarkKind, rowActionOf } from './row-action'

/** Три факта строками: план, отметка, Hub (§5.1). Пустые не показываются. */
function rowFacts(row: PlanRow): string[] {
  const { facts, notes } = row.verdict
  return [facts.plan, facts.mark, facts.hub, ...notes].flatMap((fact) => (fact ? [fact] : []))
}

interface RowWhyProps {
  row: PlanRow
  /** Одна кнопка во всплывашке «почему»: «Сверить», «Отметить». */
  action?: WhyAction
  /** 13/18 в строке дня, 12/16 в ячейке недели. */
  size?: 'sm' | 'xs'
  /** Своё лицо слова в тесной ячейке недели: у ✓ только знак, серое слово после точки. */
  children?: ReactNode
  /** Подсказка при наведении вместо короткой причины: в тесной ячейке — и полное слово. */
  hint?: string
  className?: string
}

/**
 * Слово состояния строки плана со знаком (DESIGN §5.1): нажатие открывает «почему» с тремя
 * фактами и одной кнопкой, наведение — короткую подсказку. Одно и то же в строке дня и
 * в ячейке недели. Нажатие по слову и по всплывашке строку не выделяет.
 */
export function RowWhy({ row, action, size = 'sm', children, hint, className }: RowWhyProps) {
  const { verdict } = row
  const sign = verdict.sign ?? undefined
  const [open, setOpen] = useState(false)
  const word = (
    <StatusWord sign={sign} size={size} className="max-w-full">
      {verdict.word}
    </StatusWord>
  )
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: только гасит всплытие к строке-варианту списка
    <span
      className={cn('flex min-w-0', className)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.stopPropagation()
        }
      }}
    >
      <WhyPopover
        hint={hint ?? verdict.reason}
        title={word}
        tone={sign}
        facts={rowFacts(row)}
        action={
          action
            ? {
                label: action.label,
                onSelect: () => {
                  setOpen(false)
                  action.onSelect()
                },
              }
            : undefined
        }
        open={open}
        onOpenChange={setOpen}
        className="max-w-full"
      >
        {children ?? word}
      </WhyPopover>
    </span>
  )
}

/**
 * Одна кнопка «почему» по случаю (§5.1): «Сверить» у ◆, «Отметить» или «Отметить и
 * подтвердить» у строки в плане, «Отметить и подтвердить» у «не проверено» — Hub не смог.
 */
function useWhyAction(row: PlanRow, canAct: boolean, onCheck?: () => void): WhyAction | undefined {
  const marks = useMarkActions()
  const action = rowActionOf(row, canAct)
  switch (action.kind) {
    case 'check':
      return onCheck ? { label: 'Сверить', onSelect: onCheck } : undefined
    case 'mark_confirm':
      return { label: 'Отметить и подтвердить', onSelect: () => marks.markConfirm(row) }
    case 'mark': {
      const kind = rememberedMarkKind()
      return {
        label: kind === 'scheduled' ? `Отметить: ${MARK_KIND_LABEL.scheduled}` : 'Отметить',
        onSelect: () => marks.mark(row, kind, null),
      }
    }
    default:
      return canAct && row.cancelled === null && row.verdict.level === 'cannot_verify'
        ? { label: 'Отметить и подтвердить', onSelect: () => marks.markConfirm(row) }
        : undefined
  }
}

interface RowStatusProps {
  row: PlanRow
  /** Кнопка во всплывашке есть только у того, кто может действовать. */
  canAct?: boolean
  /** ◆ «Сверить»: пара открывается в панели справа. */
  onCheck?: () => void
  /** 13/18 в строке дня, 12/16 в ячейке недели. */
  size?: 'sm' | 'xs'
  /** Короткая причина серым под словом — только в строке дня. */
  withCaption?: boolean
  className?: string
}

/** Состояние строки плана (DESIGN §5.1–5.2): слово с «почему» и короткая причина под ним. */
export function RowStatus({
  row,
  canAct = false,
  onCheck,
  size = 'sm',
  withCaption = true,
  className,
}: RowStatusProps) {
  const action = useWhyAction(row, canAct, onCheck)
  const caption = withCaption ? rowCaption(row) : null
  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      <RowWhy row={row} action={action} size={size} />
      {caption ? <span className="truncate text-ink-3 text-sm">{caption}</span> : null}
    </div>
  )
}
