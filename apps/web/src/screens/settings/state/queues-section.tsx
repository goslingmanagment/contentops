import { formatNumber, formatPercent, plural, type Queue } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { Progress } from '@contentops/ui/components/progress'
import { SettingsRow, SettingsSection } from '@contentops/ui/components/settings-section'
import { useQueryClient } from '@tanstack/react-query'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'
import { useIsOwner } from '../shared/use-is-owner'

interface PauseRequest {
  queue: Queue
  paused: boolean
}

function pendingWord(queue: Queue): string {
  if (queue.pending === 0) {
    return 'пусто'
  }
  return `${formatNumber(queue.pending)} ${plural(queue.pending, ['файл', 'файла', 'файлов'])} в очереди`
}

/** Очереди фоновой работы: забор с диска, превью, сжатие, кадры, копии — с «Пауза». */
export function QueuesSection({ queues }: { queues: readonly Queue[] }) {
  const api = useApi()
  const owner = useIsOwner()
  const toast = useActionToast()
  const queryClient = useQueryClient()

  const pause = useIntentMutation<PauseRequest, unknown>({
    failed: 'Очередь не переключилась',
    run: ({ queue, paused }, key) =>
      api.settings
        .pauseQueue({ params: { queue: queue.key }, body: { paused }, idempotencyKey: key })
        .then((state) => queryClient.setQueryData(queryKeys.systemState(), state)),
    onSuccess: (_, { queue, paused }) =>
      toast.show({
        message: paused ? `«${queue.label}» на паузе` : `«${queue.label}» снова работает`,
        action: {
          label: paused ? 'Продолжить' : 'Пауза',
          onSelect: () => pause.start({ queue, paused: !paused }),
        },
      }),
  })

  return (
    <SettingsSection title="Очереди">
      {queues.map((queue) => (
        <SettingsRow
          key={queue.key}
          label={queue.label}
          detail={queue.paused ? `на паузе · ${pendingWord(queue)}` : pendingWord(queue)}
        >
          {queue.progress !== null && !queue.paused ? (
            <span className="flex w-40 items-center gap-2">
              <Progress value={queue.progress * 100} className="h-1 flex-1" />
              <span className="w-10 text-right text-muted-foreground text-sm tabular-nums">
                {formatPercent(queue.progress)}
              </span>
            </span>
          ) : null}
          {owner ? (
            <Button
              variant="outline"
              size="sm"
              className="w-28"
              onClick={() => pause.start({ queue, paused: !queue.paused })}
            >
              {queue.paused ? 'Продолжить' : 'Пауза'}
            </Button>
          ) : null}
        </SettingsRow>
      ))}
    </SettingsSection>
  )
}
