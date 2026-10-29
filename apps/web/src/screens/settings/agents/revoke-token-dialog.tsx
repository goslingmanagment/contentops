import type { Agent, AgentToken } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentops/ui/components/dialog'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'

interface RevokeTokenDialogProps {
  agent: Agent
  token: AgentToken
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * «Отозвать…» у токена агента — подтверждение (§1.5, §3.9): агент встаёт сразу, отозванный
 * токен не вернуть — только выдать и настроить новый.
 */
export function RevokeTokenDialog({ agent, token, open, onOpenChange }: RevokeTokenDialogProps) {
  const api = useApi()
  const toast = useActionToast()
  const revoke = useIntentMutation<void, unknown>({
    failed: 'Токен не отозван',
    run: (_, key) =>
      api.admin.revokeToken({
        params: { agent: agent.id, token: token.id },
        idempotencyKey: key,
      }),
    invalidates: () => [queryKeys.agents()],
    onSuccess: () => {
      onOpenChange(false)
      toast.show({ message: `Токен отозван · ${agent.name}` })
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-120">
        <DialogHeader>
          <DialogTitle>Отозвать токен: {agent.name}?</DialogTitle>
          <DialogDescription>
            Агент «{agent.name}» перестанет работать сразу, вернуть токен нельзя.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button variant="destructive" pending={revoke.isPending} onClick={() => revoke.start()}>
            Отозвать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
