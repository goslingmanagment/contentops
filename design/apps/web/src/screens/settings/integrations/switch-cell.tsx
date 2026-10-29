import type { IntegrationView } from '@contentops/contracts'
import { Switch } from '@contentops/ui/components/switch'
import { cn } from '@contentops/ui/lib/utils'
import type { SwitchKey, useIntegrationSwitch } from './use-integration-switch'

interface SwitchCellProps {
  integration: IntegrationView
  switchKey: SwitchKey
  /** «Автосверка Hub · Fansly 3»: подпись для чтения с экрана и для полоски. */
  label: string
  switches: ReturnType<typeof useIntegrationSwitch>
  /** КМ видит положение словом («получает», «автосверка»), а не неактивным выключателем. */
  readOnly: boolean
  /** Владелец не может переключить сейчас: автосверка без получения данных. */
  disabled?: boolean
}

/** Положение словами для того, кто не переключает. */
const POSITION_WORD: Record<SwitchKey, { on: string; off: string }> = {
  receive: { on: 'получает', off: 'не получает' },
  auto_match: { on: 'автосверка', off: 'без автосверки' },
  scan: { on: 'сканирует', off: 'не сканирует' },
  enabled: { on: 'работают', off: 'выключены' },
}

/** Выключатель в колонке шириной с подпись над ней; у КМ — положение словом. */
export function SwitchCell({
  integration,
  switchKey,
  label,
  switches,
  readOnly,
  disabled = false,
}: SwitchCellProps) {
  const pending = switches.isPending(integration, switchKey)
  const checked = switches.positionOf(integration, switchKey)
  if (readOnly) {
    const word = POSITION_WORD[switchKey]
    return (
      <span className={cn('w-32 text-center text-sm', checked ? 'text-foreground' : 'text-ink-3')}>
        <span className="sr-only">{label}: </span>
        {checked ? word.on : word.off}
      </span>
    )
  }
  return (
    <span className="flex w-32 justify-center">
      <Switch
        aria-label={label}
        aria-busy={pending}
        checked={checked}
        disabled={disabled || pending}
        onCheckedChange={(value) => switches.toggle({ integration, key: switchKey, value, label })}
      />
    </span>
  )
}

/** Подписи колонок выключателей над строками раздела. */
export function SwitchHeaders({ labels }: { labels: readonly string[] }) {
  return labels.map((label) => (
    <span key={label} className="w-32 text-center text-ink-3 text-sm">
      {label}
    </span>
  ))
}
