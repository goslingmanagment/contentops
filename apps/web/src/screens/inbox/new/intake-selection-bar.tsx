import { formatNumber, type InboxGroup } from '@contentops/contracts'
import { SelectionBar } from '@contentops/ui/components/selection-bar'
import { useState } from 'react'
import { RejectPopover } from '../panel/reject-popover'
import { batchModelOf } from '../shared/batch'
import { BatchButtons } from '../shared/batch-buttons'
import type { IntakeActions } from '../shared/use-intake-actions'

interface IntakeSelectionBarProps {
  groups: readonly InboxGroup[]
  actions: IntakeActions
  onClear: () => void
}

/**
 * Полоса выделения групп (DESIGN §3.3): «Принять N», «Тип ▾», «Куда видео ▾», «Слить»,
 * в «⋯» — «Отклонить…». Встаёт на место шапки той же высоты.
 */
export function IntakeSelectionBar({ groups, actions, onClear }: IntakeSelectionBarProps) {
  const [rejecting, setRejecting] = useState(false)
  const rejectable = batchModelOf(groups).rejectable
  return (
    <RejectPopover
      open={rejecting}
      onOpenChange={setRejecting}
      onReject={(reason) =>
        actions.reject(
          rejectable.map((group) => group.id),
          reason,
        )
      }
      submitLabel={`Отклонить ${formatNumber(rejectable.length)}`}
      align="end"
      anchorOnly
    >
      <div>
        <SelectionBar
          count={groups.length}
          onClear={onClear}
          menu={
            rejectable.length > 0
              ? {
                  actions: [
                    { id: 'reject', label: 'Отклонить…', onSelect: () => setRejecting(true) },
                  ],
                }
              : undefined
          }
        >
          <BatchButtons groups={groups} actions={actions} surface="bar" />
        </SelectionBar>
      </div>
    </RejectPopover>
  )
}
