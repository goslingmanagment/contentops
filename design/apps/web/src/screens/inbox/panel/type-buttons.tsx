import { ITEM_TYPES, type ItemType } from '@contentops/contracts'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import { TYPE_WORD } from '../shared/group-texts'

interface TypeButtonsProps {
  value: ItemType | null
  onChange: (type: ItemType) => void
  disabled?: boolean
  label: string
}

const TYPE_CHOICES = ITEM_TYPES.map((type) => ({ value: type, label: TYPE_WORD[type] }))

/**
 * «Тип» — восемь чипов в привычном порядке, четыре в ряд (DESIGN §4.8). Без значения по
 * умолчанию, если тип не угадан: ◆ «Что это?» решает человек.
 */
export function TypeButtons({ value, onChange, disabled = false, label }: TypeButtonsProps) {
  return (
    <ChoiceChips
      label={label}
      choices={TYPE_CHOICES}
      value={value}
      onChange={onChange}
      disabled={disabled}
      className="grid w-full grid-cols-4"
    />
  )
}
