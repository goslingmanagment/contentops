import { formatNumber, type ItemId } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { SelectionBar } from '@contentops/ui/components/selection-bar'
import { CheckCheckIcon, ImagesIcon } from 'lucide-react'
import { useRole } from '@/data/session'
import type { MarkupLine } from './markup-values'
import { useConfirmMarkup } from './use-confirm-markup'

interface MarkupActionsProps {
  lines: readonly MarkupLine[]
  onConfirmed: () => void
  onShowFailed: (ids: ItemId[]) => void
  /** «Посмотреть кадры»: лист кадров одного объекта (§4.20). */
  onOpenFrames: (id: ItemId) => void
}

/** Кадры смотрят перед отправкой фану: кастом, секстинг, PPV (из кастома). */
const FRAME_TYPES = new Set(['custom', 'sexting', 'ppv'])

function useMarkupActions({ lines, onConfirmed, onShowFailed, onOpenFrames }: MarkupActionsProps) {
  const role = useRole()
  const { confirm, confirming } = useConfirmMarkup({ onConfirmed, onShowFailed })
  const targets = lines.filter((line) => line.values.seen.length > 0)
  const single = lines.length === 1 ? lines[0] : undefined
  return {
    canAct: role === 'owner' || role === 'manager',
    confirmLabel: `Подтвердить всю разметку · ${formatNumber(targets.length)}`,
    canConfirm: targets.length > 0,
    confirm: () => confirm(targets.map((line) => ({ id: line.entry.id, seen: line.values.seen }))),
    confirming,
    /** «Посмотреть кадры»: лист кадров одного объекта перед отправкой фану. */
    frames:
      single && FRAME_TYPES.has(single.entry.type)
        ? () => onOpenFrames(single.entry.id)
        : undefined,
  }
}

/** Полоса выделения «Разметки на проверку» (DESIGN §3.3). */
export function MarkupSelectionBar({
  onClear,
  ...props
}: MarkupActionsProps & { onClear: () => void }) {
  const actions = useMarkupActions(props)
  return (
    <SelectionBar count={props.lines.length} onClear={onClear}>
      {actions.canAct && actions.canConfirm ? (
        <Button onClick={actions.confirm} aria-busy={actions.confirming}>
          <CheckCheckIcon />
          {actions.confirmLabel}
        </Button>
      ) : null}
      {actions.frames ? (
        <Button variant="bar" onClick={actions.frames}>
          <ImagesIcon />
          Посмотреть кадры
        </Button>
      ) : null}
    </SelectionBar>
  )
}

/** Те же кнопки в панели при выделении (§3.4). */
export function MarkupPanelActions(props: MarkupActionsProps) {
  const actions = useMarkupActions(props)
  return (
    <div className="flex flex-wrap gap-2">
      {actions.canAct && actions.canConfirm ? (
        <Button onClick={actions.confirm} aria-busy={actions.confirming}>
          {actions.confirmLabel}
        </Button>
      ) : null}
      {actions.frames ? (
        <Button variant="secondary" onClick={actions.frames}>
          Посмотреть кадры
        </Button>
      ) : null}
    </div>
  )
}
