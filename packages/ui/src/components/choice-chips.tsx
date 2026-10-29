import { cn } from 'cn'
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui'

export interface Choice<Value extends string> {
  value: Value
  label: string
  /** Почему выбрать нельзя: «нельзя: второй человек в кадре». Чип серый с пунктиром. */
  disabledReason?: string | null
}

interface ChoiceChipsBase<Value extends string> {
  choices: readonly Choice<Value>[]
  /** Подпись группы для чтения с экрана, если рядом нет видимой (`labelledBy`). */
  label?: string
  /** `id` видимой подписи поля: «Что это», «Страницы», «Имя фана в ролике». */
  labelledBy?: string
  disabled?: boolean
  className?: string
}

interface SingleChoiceProps<Value extends string> extends ChoiceChipsBase<Value> {
  multiple?: false
  /** `null` — ничего не выбрано: значения по умолчанию нет (◆ «Что это?» решает человек). */
  value: Value | null
  onChange: (value: Value) => void
}

interface MultipleChoiceProps<Value extends string> extends ChoiceChipsBase<Value> {
  /** Несколько значений: «Страницы» в окне «В план». */
  multiple: true
  value: readonly Value[]
  onChange: (value: Value[]) => void
}

export type ChoiceChipsProps<Value extends string> =
  | SingleChoiceProps<Value>
  | MultipleChoiceProps<Value>

/**
 * Выбор значения чипами-пилюлями (DESIGN §7.3–7.4, §8) — один вид на весь продукт: вид
 * PPV, тип объекта, «Что это» в «Загрузить», «Имя фана в ролике: есть / нет / не знаю»,
 * страницы в «В план». Чип 32, радиус 16, фон `--secondary`; выбранный — заливка
 * `--primary-tint` и текст `--primary-ink`. Выбор показан заливкой, а не кольцом:
 * кольцо — только фокус (§7.8), поэтому фокус на первом чипе при открытии окна не
 * выглядит выбором.
 */
export function ChoiceChips<Value extends string>(props: ChoiceChipsProps<Value>) {
  const { choices, label, labelledBy, disabled = false, className } = props
  const find = (next: string) => choices.find((choice) => choice.value === next)?.value
  const common = {
    'data-slot': 'choice-chips',
    'aria-label': labelledBy ? undefined : label,
    'aria-labelledby': labelledBy,
    disabled,
    className: cn('flex flex-wrap items-center gap-1.5', className),
  }
  const items = choices.map((choice) => (
    <ToggleGroupPrimitive.Item
      key={choice.value}
      value={choice.value}
      disabled={Boolean(choice.disabledReason)}
      title={choice.disabledReason ?? undefined}
      className={cn(
        'inline-flex h-8 min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-2xl bg-secondary px-3 font-medium text-secondary-foreground text-sm transition-colors duration-120 hover:bg-secondary-hover',
        'data-[state=on]:bg-primary-tint data-[state=on]:text-primary-ink',
        'disabled:pointer-events-none disabled:border disabled:border-line-strong disabled:border-dashed disabled:bg-transparent disabled:text-ink-3',
      )}
    >
      {choice.label}
    </ToggleGroupPrimitive.Item>
  ))

  if (props.multiple) {
    const { value, onChange } = props
    return (
      <ToggleGroupPrimitive.Root
        {...common}
        type="multiple"
        value={[...value]}
        onValueChange={(next) =>
          onChange(
            choices.map((choice) => choice.value).filter((candidate) => next.includes(candidate)),
          )
        }
      >
        {items}
      </ToggleGroupPrimitive.Root>
    )
  }

  const { value, onChange } = props
  return (
    <ToggleGroupPrimitive.Root
      {...common}
      type="single"
      value={value ?? ''}
      onValueChange={(next) => {
        const chosen = find(next)
        if (chosen !== undefined) {
          onChange(chosen)
        }
      }}
    >
      {items}
    </ToggleGroupPrimitive.Root>
  )
}
