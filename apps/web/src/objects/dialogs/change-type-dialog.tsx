import {
  type ChangeTypeCommand,
  ChangeTypeCommandSchema,
  ITEM_TYPE_INFO,
  ITEM_TYPES,
  type ItemId,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentops/ui/components/dialog'
import { zodResolver } from '@hookform/resolvers/zod'
import { useNavigate } from '@tanstack/react-router'
import { Controller, useForm } from 'react-hook-form'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { itemQueryKeys, useItem } from '@/data/object'
import { useCurrentModel } from '@/shell/model/model-context'

interface ChangeTypeDialogProps {
  id: ItemId
  onClose: () => void
}

/**
 * «Сменить тип (будет новый номер)…» (DESIGN §3.6): номер выдаётся заново, прежний
 * остаётся в старых именах и находится поиском. После смены открывается новый объект.
 */
export function ChangeTypeDialog({ id, onClose }: ChangeTypeDialogProps) {
  const model = useCurrentModel().code
  const api = useApi()
  const toast = useActionToast()
  const navigate = useNavigate()
  const item = useItem(model, id)
  const current = item.data?.entry.type
  const form = useForm<ChangeTypeCommand>({ resolver: zodResolver(ChangeTypeCommandSchema) })
  const chosen = form.watch('type')

  const change = useIntentMutation<ChangeTypeCommand, { item_id: ItemId }>({
    failed: 'Тип не сменился',
    run: (body, idempotencyKey) =>
      api.objects.changeType({
        params: { model, id },
        body,
        ifMatch: item.data?.version,
        idempotencyKey,
      }),
    invalidates: () => itemQueryKeys(model, id),
    onSuccess: ({ item_id: next }) => {
      onClose()
      toast.show({ message: `Тип сменён · теперь ${next}` })
      void navigate({ to: '/$model/i/$id', params: { model, id: next } })
    },
  })

  const choices = ITEM_TYPES.filter((type) => type !== current).map((type) => ({
    value: type,
    label: ITEM_TYPE_INFO[type].folder,
  }))

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-130">
        <form onSubmit={form.handleSubmit(change.start)} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>Сменить тип {id}</DialogTitle>
            <DialogDescription>
              Будет новый номер. {id} останется в старых именах и найдётся поиском.
            </DialogDescription>
          </DialogHeader>
          <Controller
            control={form.control}
            name="type"
            render={({ field }) => (
              <ChoiceChips
                label="Новый тип"
                choices={choices}
                value={field.value ?? null}
                onChange={field.onChange}
              />
            )}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit" disabled={!chosen || !item.data} pending={change.isPending}>
              Сменить тип
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
