import type { Threshold } from '@contentops/contracts'
import {
  SettingsSection,
  SettingsSectionSkeleton,
} from '@contentops/ui/components/settings-section'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'
import { useModels } from '@/data/session'
import { useThresholds } from '@/data/settings'
import { SettingsPage } from '../settings-layout'
import { ThresholdRow } from './threshold-row'
import { groupThresholds } from './threshold-value'

interface ExceptionChange {
  threshold: Threshold
  /** «Лайф», «Fansly 2» — для полоски. */
  name: string
}

/**
 * «Пороги» (DESIGN §4.19): у каждого порога значение для всего и исключения для страницы
 * или типа. Пустое значение — функция выключена, так и написано. Убранное исключение
 * возвращается «Отменить» в полоске: отмена живёт здесь, а не в строке, которой уже нет.
 */
export function ThresholdsSection() {
  const api = useApi()
  const toast = useActionToast()
  const thresholds = useThresholds()
  const models = useModels()

  const restore = useIntentMutation<ExceptionChange, unknown>({
    failed: 'Исключение не вернулось',
    run: ({ threshold }, key) =>
      api.admin.updateThreshold({
        body: {
          key: threshold.key,
          scope: threshold.scope,
          scope_value: threshold.scope_value,
          value: threshold.value,
        },
        idempotencyKey: key,
      }),
    // Строка возвращается на место — это и есть ответ; полоска «Отменить» уже закрыта.
    invalidates: () => [queryKeys.thresholds()],
  })
  const remove = useIntentMutation<ExceptionChange, unknown>({
    failed: 'Исключение не убрано',
    run: ({ threshold }, key) =>
      api.admin.removeThreshold({
        body: { key: threshold.key, scope: threshold.scope, scope_value: threshold.scope_value },
        ifMatch: threshold.version,
        idempotencyKey: key,
      }),
    invalidates: () => [queryKeys.thresholds()],
    onSuccess: (_, change) =>
      toast.show({
        message: `Убрано · ${change.threshold.label} · ${change.name}`,
        undoable: true,
        action: { label: 'Отменить', onSelect: () => restore.start(change) },
      }),
  })

  return (
    <SettingsPage title="Пороги" refreshing={thresholds.isFetching && !thresholds.isPending}>
      {thresholds.isError && !thresholds.data ? (
        <ErrorLine
          layout="center"
          message="Не загрузилось"
          onRetry={() => void thresholds.refetch()}
        />
      ) : null}
      {thresholds.isPending ? <SettingsSectionSkeleton rows={8} /> : null}
      {thresholds.data ? (
        <SettingsSection>
          {groupThresholds(thresholds.data).map((group) => (
            <ThresholdRow
              key={`${group.base.key}:${group.base.version}`}
              group={group}
              models={models.data ?? []}
              removing={remove.isPending}
              onRemove={(threshold, name) => remove.start({ threshold, name })}
            />
          ))}
        </SettingsSection>
      ) : null}
    </SettingsPage>
  )
}
