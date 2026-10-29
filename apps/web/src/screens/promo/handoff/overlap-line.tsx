import type { HandoffOverlap } from '@contentops/contracts'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import { StatusSign } from '@contentops/ui/components/status-sign'

/** Что делать с уже переданными этому подрядчику: убрать или оставить. */
export type OverlapChoice = 'drop' | 'keep'

interface OverlapLineProps {
  overlap: HandoffOverlap
  choice: OverlapChoice
  onChoiceChange: (choice: OverlapChoice) => void
}

/**
 * Строка проверки перед «Подготовить» (DESIGN §4.17): «38 из 100 уже передавали Coraline
 * Red (PRM-011, 02.09) · Убрать их · Оставить». Считаются и прежние передачи этой же
 * подборки. Выбрано «Убрать их»: повтор подрядчику уходит, только если человек выбрал
 * «Оставить».
 */
export function OverlapLine({ overlap, choice, onChoiceChange }: OverlapLineProps) {
  if (!overlap.text) return null
  return (
    <div className="flex flex-col gap-2.5 rounded-xl bg-attention-bg px-3.5 py-3">
      <p className="flex gap-2 text-base">
        <StatusSign kind="turn" className="mt-0.5" />
        <span>{overlap.text}</span>
      </p>
      <ChoiceChips
        label="Уже переданные"
        value={choice}
        onChange={onChoiceChange}
        choices={[
          { value: 'drop', label: 'Убрать их' },
          { value: 'keep', label: 'Оставить' },
        ]}
      />
    </div>
  )
}
