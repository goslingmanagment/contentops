import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import { FieldRow } from './field-row'

interface ChoiceFieldProps<Value extends string> {
  label: string
  value: Value | null
  options: readonly { value: Value; label: string }[]
  onChange: (value: Value) => void
  source?: string | null
  disabled?: boolean
}

/** Поле с выбором одного значения чипами: «Вид PPV», «Назначение съёмки», «Имя фана». */
export function ChoiceField<Value extends string>({
  label,
  value,
  options,
  onChange,
  source,
  disabled = false,
}: ChoiceFieldProps<Value>) {
  return (
    <FieldRow label={label} source={source}>
      <ChoiceChips
        label={label}
        choices={options}
        value={value}
        onChange={onChange}
        disabled={disabled}
        className="w-full"
      />
    </FieldRow>
  )
}
