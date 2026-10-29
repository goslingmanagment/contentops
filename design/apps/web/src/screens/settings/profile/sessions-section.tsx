import { formatWhen, type Session } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  SettingsRow,
  SettingsSection,
  SettingsSectionSkeleton,
} from '@contentops/ui/components/settings-section'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import { useNavigate } from '@tanstack/react-router'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi, useClock } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'
import { useMySessions } from '@/data/settings'

/** Свои сессии: этот браузер и остальные с «Отозвать»; «Выйти везде» — последней строкой. */
export function SessionsSection() {
  const sessions = useMySessions()
  const api = useApi()
  const now = useClock().now()
  const toast = useActionToast()
  const navigate = useNavigate()

  const revoke = useIntentMutation<Session, unknown>({
    failed: 'Сессия не отозвана',
    run: (session, key) =>
      api.settings.revokeMySession({ params: { session: session.id }, idempotencyKey: key }),
    invalidates: () => [queryKeys.mySessions(), queryKeys.session()],
    onSuccess: (_, session) => toast.show({ message: `Сессия отозвана · ${session.device}` }),
  })
  const signOutEverywhere = useIntentMutation<void, unknown>({
    failed: 'Сессии не завершились',
    run: (_, key) => api.auth.signOutEverywhere({ idempotencyKey: key }),
    onSuccess: () => void navigate({ to: '/login' }),
  })

  if (sessions.isError && !sessions.data) {
    return <ErrorLine message="Не загрузилось" onRetry={() => void sessions.refetch()} />
  }
  if (!sessions.data) {
    return <SettingsSectionSkeleton rows={2} />
  }
  return (
    <SettingsSection title="Сессии">
      {sessions.data.map((session) => (
        <SettingsRow
          key={session.id}
          label={session.device}
          detail={
            session.current
              ? 'этот браузер'
              : `последний раз ${formatWhen(session.last_seen_at, now)}`
          }
        >
          {session.current ? null : (
            <Button
              variant="outline"
              size="sm"
              pending={revoke.isPending}
              onClick={() => revoke.start(session)}
            >
              Отозвать
            </Button>
          )}
        </SettingsRow>
      ))}
      <SettingsRow label="Выйти везде" detail="Все сессии, и эта тоже">
        <Button
          variant="outline"
          size="sm"
          pending={signOutEverywhere.isPending}
          onClick={() => signOutEverywhere.start()}
        >
          Выйти везде
        </Button>
      </SettingsRow>
    </SettingsSection>
  )
}
