import { mskInstant, type PlanRow } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@contentops/ui/components/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@contentops/ui/components/tooltip'
import { cn } from '@contentops/ui/lib/utils'
import {
  CheckCheckIcon,
  CheckIcon,
  ChevronDownIcon,
  GitCompareArrowsIcon,
  UploadIcon,
} from 'lucide-react'
import { useMarkActions } from './actions/use-mark-actions'
import { useRowActions } from './actions/use-row-actions'
import { MARK_KIND_LABEL, type RowAction, rememberedMarkKind, rowActionOf } from './row-action'

interface MarkControlProps {
  row: PlanRow
  canAct: boolean
  /** ◆ «Сверить»: пара открывается в панели справа. */
  onCheck: () => void
  onUploadMontage: () => void
  /** Синяя кнопка во всю ширину — в панели строки; в строке — белая с контуром. */
  variant?: 'row' | 'panel'
  /** Управление меню «Отметить ▾» снаружи: клавиша `2`. */
  menuOpen?: boolean
  onMenuOpenChange?: (open: boolean) => void
}

/** Кнопка строки по случаю (DESIGN §4.11): одна на строку, неприменимые не рисуются. */
export function MarkControl(props: MarkControlProps) {
  const action = rowActionOf(props.row, props.canAct)
  return <ActionButton action={action} {...props} />
}

function ActionButton({
  action,
  row,
  onCheck,
  onUploadMontage,
  variant = 'row',
  menuOpen,
  onMenuOpenChange,
}: MarkControlProps & { action: RowAction }) {
  const marks = useMarkActions()
  const rows = useRowActions()
  const tone = variant === 'panel' ? 'default' : 'outline'
  const size = variant === 'panel' ? 'default' : 'sm'
  const wide = variant === 'panel' ? 'w-full' : undefined
  switch (action.kind) {
    case 'mark':
      return (
        <MarkSplitButton
          row={row}
          timed={action.timed}
          pending={marks.pending}
          variant={variant}
          menuOpen={menuOpen}
          onMenuOpenChange={onMenuOpenChange}
          onMark={(kind, at) => marks.mark(row, kind, at)}
        />
      )
    case 'mark_confirm':
      return (
        <Button
          variant={tone}
          size={size}
          className={wide}
          pending={marks.pending}
          onClick={() => marks.markConfirm(row)}
        >
          {/* В строке дня кнопка без значка: самая длинная надпись, место нужнее названию. */}
          {variant === 'panel' ? <CheckCheckIcon /> : null}
          Отметить и подтвердить
        </Button>
      )
    case 'check':
      return (
        <Button variant={tone} size={size} className={wide} onClick={onCheck}>
          <GitCompareArrowsIcon />
          Сверить
        </Button>
      )
    case 'cancel':
      return (
        <Button
          variant={tone}
          size={size}
          className={wide}
          pending={rows.cancelling}
          onClick={() => rows.cancel([row])}
        >
          Отменить строку
        </Button>
      )
    case 'montage':
      return (
        <Button variant={tone} size={size} className={wide} onClick={onUploadMontage}>
          <UploadIcon />
          Загрузить монтаж
        </Button>
      )
    case 'none':
      return null
  }
}

interface MarkSplitButtonProps {
  row: PlanRow
  timed: boolean
  pending: boolean
  variant: 'row' | 'panel'
  menuOpen?: boolean
  onMenuOpenChange?: (open: boolean) => void
  onMark: (kind: 'posted' | 'scheduled', at: string | null) => void
}

/**
 * «Отметить ▾»: нажатие отмечает вариантом, выбранным в прошлый раз; стрелка —
 * «выложено» / «в планировщике». У сториз и рассылки — время, по умолчанию «сейчас».
 */
function MarkSplitButton({
  row,
  timed,
  pending,
  variant,
  menuOpen,
  onMenuOpenChange,
  onMark,
}: MarkSplitButtonProps) {
  const remembered = timed ? 'posted' : rememberedMarkKind()
  const plannedAt = row.time ? mskInstant(row.date, row.time) : null
  const panel = variant === 'panel'
  const buttonVariant = panel ? 'default' : 'outline'
  const size = panel ? 'default' : 'sm'
  return (
    <div className={cn('inline-flex', panel && 'w-full')}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={buttonVariant}
            size={size}
            pending={pending}
            onClick={() => onMark(remembered, null)}
            className={cn('rounded-r-none', panel && 'flex-1')}
          >
            <CheckIcon />
            Отметить
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {timed ? 'Выложено сейчас' : `Отметить: ${MARK_KIND_LABEL[remembered]}`}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            variant={buttonVariant}
            size={panel ? 'icon' : 'icon-sm'}
            aria-label="Как отметить"
            disabled={pending}
            className={cn(
              'rounded-l-none border-l',
              panel ? 'border-l-primary-foreground/30' : '-ml-px',
            )}
          >
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {timed ? (
            <>
              <DropdownMenuItem onSelect={() => onMark('posted', null)}>
                Выложено сейчас
              </DropdownMenuItem>
              {plannedAt ? (
                <DropdownMenuItem onSelect={() => onMark('posted', plannedAt)}>
                  Выложено в {row.time}, по плану
                </DropdownMenuItem>
              ) : null}
            </>
          ) : (
            <DropdownMenuItem onSelect={() => onMark('posted', null)}>Выложено</DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => onMark('scheduled', null)}>
            В планировщике
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
