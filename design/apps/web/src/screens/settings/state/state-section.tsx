import { SettingsSectionSkeleton } from '@contentops/ui/components/settings-section'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import { useSystemState } from '@/data/settings'
import { SettingsPage } from '../settings-layout'
import { ChecksSection } from './checks-section'
import { QueuesSection } from './queues-section'
import { SpaceSection } from './space-section'

/**
 * «Состояние» (DESIGN §4.19): очереди с паузой, место C: и E:, бэкап, задержка Hub,
 * находки проверки, межмодельные дубли. Видят все, действия — у владельца.
 */
export function StateSection() {
  const state = useSystemState()
  const data = state.data
  return (
    <SettingsPage title="Состояние" refreshing={state.isFetching && !state.isPending}>
      {state.isError && !data ? (
        <ErrorLine layout="center" message="Не загрузилось" onRetry={() => void state.refetch()} />
      ) : null}
      {state.isPending ? (
        <>
          <SettingsSectionSkeleton rows={5} />
          <SettingsSectionSkeleton rows={3} />
        </>
      ) : null}
      {data ? (
        <>
          <QueuesSection queues={data.queues} />
          <SpaceSection disks={data.disks} backup={data.backup} />
          <ChecksSection state={data} />
        </>
      ) : null}
    </SettingsPage>
  )
}
