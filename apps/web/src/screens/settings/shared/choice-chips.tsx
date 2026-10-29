import { type Choice, ChoiceChips } from '@contentops/ui/components/choice-chips'
import { useId } from 'react'

interface ChoiceSectionProps<Value extends string> {
  /** «Роль», «Агент», «Срок». */
  label: string
  options: readonly Choice<Value>[]
  value: Value
  onChange: (value: Value) => void
}

/** Поле окна настроек: подпись 13 серым и под ней выбор одного значения общими чипами. */
export function ChoiceSection<Value extends string>({
  label,
  options,
  value,
  onChange,
}: ChoiceSectionProps<Value>) {
  const labelId = useId()
  return (
    <section className="flex flex-col gap-2">
      <h3 id={labelId} className="text-ink-3 text-sm">
        {label}
      </h3>
      <ChoiceChips labelledBy={labelId} choices={options} value={value} onChange={onChange} />
    </section>
  )
}
