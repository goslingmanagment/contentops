import type { ItemDetail, ItemId } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentops/ui/components/dialog'
import { FormField } from '@contentops/ui/components/form-field'
import { Input } from '@contentops/ui/components/input'
import { useId, useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { useItem, useItemWriter } from '@/data/object'
import { filesWord } from '@/lib/words'
import { useCurrentModel } from '@/shell/model/model-context'

interface NotContentDialogProps {
  id: ItemId
  keys: readonly string[]
  onClose: () => void
  onDone?: () => void
}

/**
 * «Не контент…» (SPEC §6.1): принятые файлы уходят из объекта, их черновики приёмки отклонены
 * с причиной; «Вернуть в работу» в «Приехало» возвращает их.
 */
export function NotContentDialog({ id, keys, onClose, onDone }: NotContentDialogProps) {
  const model = useCurrentModel().code
  const api = useApi()
  const toast = useActionToast()
  const write = useItemWriter(model)
  const item = useItem(model, id)
  const reasonId = useId()
  const [reason, setReason] = useState('')

  const refuse = useIntentMutation<string, ItemDetail>({
    failed: 'Не отклонилось',
    run: (why, idempotencyKey) =>
      api.objectFiles.notContent({
        params: { model, id },
        body: { keys: [...keys], reason: why },
        ifMatch: item.data?.version,
        idempotencyKey,
      }),
    onSuccess: (detail) => {
      write(detail)
      onDone?.()
      onClose()
      toast.show({
        message: `Не контент · ${filesWord(keys.length)} · видно в «Приехало › Решённое»`,
      })
    },
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-120">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (reason.trim()) refuse.start(reason.trim())
          }}
          className="flex flex-col gap-5"
        >
          <DialogHeader>
            <DialogTitle>Не контент: {filesWord(keys.length)}</DialogTitle>
            <DialogDescription>
              {keys.join(', ')} уйдут из {id}, их приёмка будет отклонена с причиной. Вернуть —
              «Вернуть в работу» в «Приехало».
            </DialogDescription>
          </DialogHeader>
          <FormField htmlFor={reasonId} label="Причина">
            <Input
              id={reasonId}
              autoFocus
              placeholder="скриншот заказа, вещи, реф"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Отмена
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={!reason.trim() || !item.data}
              pending={refuse.isPending}
            >
              Отклонить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
