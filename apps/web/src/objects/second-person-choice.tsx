import { Button } from '@contentops/ui/components/button'

/**
 * «Нет · Есть» (DESIGN §4.4, §4.13): ответ про второго человека у объекта, про которого ещё
 * никто не ответил. Выключенный переключатель значил бы «нет», а этого никто не говорил.
 */
export function SecondPersonChoice({
  disabled = false,
  onAnswer,
}: {
  disabled?: boolean
  onAnswer: (yes: boolean) => void
}) {
  return (
    <span className="flex shrink-0 items-baseline gap-1.5">
      <Button
        type="button"
        variant="link"
        size="inline"
        disabled={disabled}
        onClick={() => onAnswer(false)}
      >
        Нет
      </Button>
      <span className="text-ink-3">·</span>
      <Button
        type="button"
        variant="link"
        size="inline"
        disabled={disabled}
        onClick={() => onAnswer(true)}
      >
        Есть
      </Button>
    </span>
  )
}
