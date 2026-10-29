import type { IsoWeek } from '@contentops/contracts'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import { Field } from './form-parts'
import type { SpreadMode } from './spread'

interface WeekChoiceProps {
  value: IsoWeek
  thisWeek: IsoWeek
  nextWeek: IsoWeek
  onChange: (week: IsoWeek) => void
}

/** «Неделя: эта / следующая». */
export function WeekChoice({ value, thisWeek, nextWeek, onChange }: WeekChoiceProps) {
  return (
    <Field label="Неделя">
      {(labelId) => (
        <ChoiceChips
          labelledBy={labelId}
          value={value}
          onChange={onChange}
          choices={[
            { value: thisWeek, label: 'Эта' },
            { value: nextWeek, label: 'Следующая' },
          ]}
        />
      )}
    </Field>
  )
}

interface ModeChoiceProps {
  value: SpreadMode
  onChange: (mode: SpreadMode) => void
}

/** «По пустым местам недели / Все на один день». */
export function ModeChoice({ value, onChange }: ModeChoiceProps) {
  return (
    <Field label="Раскладка">
      {(labelId) => (
        <ChoiceChips
          labelledBy={labelId}
          value={value}
          onChange={onChange}
          choices={[
            { value: 'gaps', label: 'По пустым местам недели' },
            { value: 'day', label: 'Все на один день' },
          ]}
        />
      )}
    </Field>
  )
}
