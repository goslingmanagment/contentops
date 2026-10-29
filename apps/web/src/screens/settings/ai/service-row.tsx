import { AI_TASK_LABEL, type AiService, formatDate, mskDate } from '@contentops/contracts'
import { SettingsRow } from '@contentops/ui/components/settings-section'
import { Switch } from '@contentops/ui/components/switch'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi, useToday } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'
import { usdWords } from './usd-words'

/** Сервис: что делает, сколько потрачено за месяц и согласие владельца выключателем. */
export function ServiceRow({ service }: { service: AiService }) {
  const today = useToday()
  const api = useApi()
  const toast = useActionToast()
  const consent = useIntentMutation<boolean, unknown>({
    failed: 'Согласие не сохранилось',
    run: (next, key) =>
      api.settings.updateAiService({
        params: { service: service.id },
        body: { consent: next },
        idempotencyKey: key,
      }),
    invalidates: () => [queryKeys.aiSettings()],
    onSuccess: (_, next) =>
      toast.show({
        message: next ? `Согласие дано · ${service.name}` : `Согласие отозвано · ${service.name}`,
      }),
  })
  const consentWords = service.consent
    ? `согласие ${service.consent.by}, ${formatDate(mskDate(service.consent.at), today)}`
    : 'без согласия ничего не получает'

  return (
    <SettingsRow
      label={service.name}
      detail={`${service.tasks.map((task) => AI_TASK_LABEL[task]).join(', ')} · ${usdWords(service.spent_month_usd)} за месяц`}
    >
      <span className="text-muted-foreground text-sm">{consentWords}</span>
      <Switch
        aria-label={`Согласие: ${service.name}`}
        aria-busy={consent.isPending}
        checked={service.consent !== null}
        disabled={consent.isPending}
        onCheckedChange={(next) => consent.start(next)}
      />
    </SettingsRow>
  )
}
