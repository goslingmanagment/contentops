import { formatAgo, type IntegrationView } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { SettingsRow, SettingsSection } from '@contentops/ui/components/settings-section'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi, useClock } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'
import { useIsOwner } from '../shared/use-is-owner'
import { ConnectForm } from './connect-form'
import { IntegrationStateLine } from './integration-state-line'
import { SwitchCell } from './switch-cell'
import type { useIntegrationSwitch } from './use-integration-switch'

interface ServicesSectionProps {
  integrations: readonly IntegrationView[]
  switches: ReturnType<typeof useIntegrationSwitch>
}

function byKind(integrations: readonly IntegrationView[], kind: IntegrationView['kind']) {
  return integrations.filter((integration) => integration.kind === kind)
}

/** ИИ, агенты, Fyper и Telegram — по строке; у Telegram только состояние. */
export function ServicesSection({ integrations, switches }: ServicesSectionProps) {
  return (
    <SettingsSection title="Сервисы">
      {byKind(integrations, 'ai').map((integration) => (
        <AiRow key={integration.id} integration={integration} />
      ))}
      {byKind(integrations, 'agents').map((integration) => (
        <AgentsRow key={integration.id} integration={integration} switches={switches} />
      ))}
      {byKind(integrations, 'fyper').map((integration) => (
        <FyperRow key={integration.id} integration={integration} />
      ))}
      {byKind(integrations, 'telegram').map((integration) => (
        <TelegramRow key={integration.id} integration={integration} />
      ))}
    </SettingsSection>
  )
}

/** «Разметка ИИ · не настроено · Настроить» открывает раздел «Сервис ИИ» (§4.19, §4.20). */
function AiRow({ integration }: { integration: IntegrationView }) {
  const now = useClock().now()
  const owner = useIsOwner()
  const navigate = useNavigate()
  const api = useApi()
  const toast = useActionToast()
  const resume = useIntentMutation<void, unknown>({
    failed: 'Разметка ИИ не включилась',
    run: (_, key) => api.settings.resumeAi({ idempotencyKey: key }),
    invalidates: () => [queryKeys.integrations(), queryKeys.aiSettings()],
    onSuccess: () => toast.show({ message: 'Разметка ИИ включена' }),
  })
  const openAi = () => void navigate({ to: '/settings/$tab', params: { tab: 'ai' } })

  return (
    <SettingsRow
      label="Разметка ИИ"
      detail={<IntegrationStateLine integration={integration} now={now} />}
    >
      {owner && integration.state === 'unset' ? (
        <Button variant="outline" size="sm" onClick={openAi}>
          Настроить
        </Button>
      ) : null}
      {owner && integration.state === 'off' ? (
        <Button
          variant="outline"
          size="sm"
          pending={resume.isPending}
          onClick={() => resume.start()}
        >
          Включить
        </Button>
      ) : null}
      {owner && integration.state !== 'unset' ? (
        <Button variant="outline" size="sm" onClick={openAi}>
          Сервис ИИ
        </Button>
      ) : null}
    </SettingsRow>
  )
}

/** Агенты: все сразу выключателем или по токену — в «Агентах и токенах». */
function AgentsRow({
  integration,
  switches,
}: {
  integration: IntegrationView
  switches: ServicesSectionProps['switches']
}) {
  const now = useClock().now()
  const owner = useIsOwner()
  const navigate = useNavigate()
  return (
    <SettingsRow
      label="Агенты"
      detail={<IntegrationStateLine integration={integration} now={now} />}
    >
      {owner ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void navigate({ to: '/settings/$tab', params: { tab: 'agents' } })}
        >
          По токену
        </Button>
      ) : null}
      <SwitchCell
        integration={integration}
        switchKey="enabled"
        label="Все агенты"
        switches={switches}
        readOnly={!owner}
      />
    </SettingsRow>
  )
}

/** Fyper: доступ по ключу; без ключа — «не настроено · Настроить». */
function FyperRow({ integration }: { integration: IntegrationView }) {
  const now = useClock().now()
  const owner = useIsOwner()
  const [connecting, setConnecting] = useState(false)
  return (
    <SettingsRow
      label="Fyper"
      detail={<IntegrationStateLine integration={integration} now={now} />}
      below={
        connecting ? (
          <ConnectForm
            integration={integration}
            field="key"
            subject="Fyper"
            onDone={() => setConnecting(false)}
          />
        ) : null
      }
    >
      {owner && integration.state !== 'working' && !connecting ? (
        <Button variant="outline" size="sm" onClick={() => setConnecting(true)}>
          Настроить
        </Button>
      ) : null}
    </SettingsRow>
  )
}

/** Якорь строки: «Агент заказов не отмечался 2 дня · Подробнее» в Заказах ведёт сюда. */
const TELEGRAM_ROW = 'telegram'

/** Telegram — только состояние по журналу: «агент заказов писал 2 ч назад». */
function TelegramRow({ integration }: { integration: IntegrationView }) {
  const now = useClock().now()
  const row = useRef<HTMLDivElement>(null)
  const targeted = useLocation({ select: (location) => location.hash === TELEGRAM_ROW })
  // Строка появляется, когда пришли интеграции, — позже перехода, поэтому прокрутка здесь.
  useEffect(() => {
    if (targeted) row.current?.scrollIntoView({ block: 'center' })
  }, [targeted])
  const text = integration.last_ok_at
    ? `агент заказов писал ${formatAgo(integration.last_ok_at, now)}`
    : 'агент заказов ещё не писал'
  return (
    <div ref={row} id={TELEGRAM_ROW}>
      <SettingsRow
        label="Telegram"
        detail={<IntegrationStateLine integration={integration} now={now} text={text} />}
      />
    </div>
  )
}
