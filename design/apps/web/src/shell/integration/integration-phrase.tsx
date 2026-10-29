import type {
  IntegrationLine as IntegrationLineData,
  IntegrationState,
} from '@contentops/contracts'
import {
  IntegrationLine,
  type IntegrationState as IntegrationLineState,
} from '@contentops/ui/components/integration-line'
import { useNavigate } from '@tanstack/react-router'
import { useRole } from '@/data/session'

const LINE_STATE: Record<IntegrationState, IntegrationLineState> = {
  working: 'ok',
  off: 'off',
  unset: 'unset',
  down: 'down',
  catching_up: 'catching-up',
}

interface IntegrationPhraseProps {
  line: IntegrationLineData
  /** Кнопка владельцу («Включить», «Настроить», «Подробнее») ведёт в Интеграции. */
  withOwnerAction?: boolean
  wrap?: boolean
  /** Короткая фраза для тесного места (папка корня); полная — в подсказке. */
  short?: string
  className?: string
}

/** Строка интеграции из ответа API (DESIGN §3.11): значок, фраза и кнопка только владельцу. */
export function IntegrationPhrase({
  line,
  withOwnerAction = false,
  wrap = false,
  short,
  className,
}: IntegrationPhraseProps) {
  const role = useRole()
  const navigate = useNavigate()
  const ownerAction =
    withOwnerAction && role === 'owner' && line.owner_action
      ? {
          label: line.owner_action,
          onSelect: () => void navigate({ to: '/settings/$tab', params: { tab: 'integrations' } }),
        }
      : undefined
  return (
    <IntegrationLine
      state={LINE_STATE[line.state]}
      action={ownerAction}
      wrap={wrap}
      title={wrap && !short ? undefined : line.text}
      className={className}
    >
      {short ?? line.text}
    </IntegrationLine>
  )
}
