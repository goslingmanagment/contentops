import type { Person } from '@contentops/contracts'
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

interface RevokeAccessDialogProps {
  person: Person
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** «Отозвать доступ…» — одно из трёх подтверждений продукта (§3.9): вернуть нельзя. */
export function RevokeAccessDialog({ person, open, onOpenChange }: RevokeAccessDialogProps) {
  const api = useApi()
  const toast = useActionToast()
  const revoke = useIntentMutation<void, unknown>({
    failed: 'Доступ не отозван',
    run: (_, key) =>
      api.settings.revokeAccess({ params: { person: person.id }, idempotencyKey: key }),
    invalidates: () => [queryKeys.people()],
    onSuccess: () => {
      onOpenChange(false)
      toast.show({ message: `Доступ отозван · ${person.name}` })
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-120">
        <DialogHeader>
          <DialogTitle>Отозвать доступ: {person.name}?</DialogTitle>
          <DialogDescription>
            {person.name} больше не сможет войти, открытые сессии закроются. События в журнале
            останутся.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button variant="destructive" pending={revoke.isPending} onClick={() => revoke.start()}>
            Отозвать доступ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
