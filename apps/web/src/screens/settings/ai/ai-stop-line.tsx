import type { AiSettings } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { StatusSign } from '@contentops/ui/components/status-sign'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'

/** «ИИ остановлен: много отказов (22 % на 30 объектах) · Включить» (§4.19). */
export function AiStopLine({ stopped }: { stopped: AiSettings['stopped'] }) {
  const api = useApi()
  const toast = useActionToast()
  const resume = useIntentMutation<void, unknown>({
    failed: 'Разметка ИИ не включилась',
    run: (_, key) => api.settings.resumeAi({ idempotencyKey: key }),
    invalidates: () => [queryKeys.aiSettings(), queryKeys.integrations()],
    onSuccess: () => toast.show({ message: 'Разметка ИИ включена' }),
  })
  if (!stopped) {
    return null
  }
  return (
    <p role="status" className="flex items-center gap-2 text-base">
      <StatusSign kind="trouble" />
      <span className="text-destructive">ИИ остановлен: {stopped.reason}</span>
      <span className="text-ink-3">·</span>
      <Button
        variant="link"
        size="inline"
        pending={resume.isPending}
        onClick={() => resume.start()}
      >
        Включить
      </Button>
    </p>
  )
}
