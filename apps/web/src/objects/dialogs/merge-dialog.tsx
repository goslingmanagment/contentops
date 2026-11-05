import {
  ITEM_TYPE_INFO,
  type ItemCreated,
  type ItemId,
  type MergeItemsCommand,
  MergeItemsCommandSchema,
  parseItemId,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
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
import { useMemo } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { useCatalogIndex } from '@/data/catalog'
import { itemQueryKeys, useItem } from '@/data/object'
import { useCurrentModel } from '@/shell/model/model-context'
import { ItemPicker } from './item-picker'

interface MergeDialogProps {
  id: ItemId
  onClose: () => void
}

/** Остаётся младший номер (SPEC §4.1): `FYP-0004` и `FYP-0017` — останется `FYP-0004`. */
function survivorOf(left: ItemId, right: ItemId): { stays: ItemId; goes: ItemId } {
  const number = (id: ItemId) => parseItemId(id)?.number ?? 0
  return number(left) < number(right) ? { stays: left, goes: right } : { stays: right, goes: left }
}

/**
 * «Слить с…» (DESIGN §3.6): два объекта одного типа становятся одним. Остаётся младший номер,
 * второй становится его старым именем; файлы, связи и отметки «выходило» переходят в него.
 * Выбор — из индекса, без запроса.
 */
export function MergeDialog({ id, onClose }: MergeDialogProps) {
  const model = useCurrentModel().code
  const api = useApi()
  const toast = useActionToast()
  const navigate = useNavigate()
  const item = useItem(model, id)
  const index = useCatalogIndex(model)
  const type = item.data?.entry.type
  const same = useMemo(
    () => (index.data?.items ?? []).filter((entry) => entry.type === type && entry.id !== id),
    [id, index.data, type],
  )
  const form = useForm<MergeItemsCommand>({ resolver: zodResolver(MergeItemsCommandSchema) })
  const into = form.watch('into')
  const plan = into ? survivorOf(id, into) : null

  const merge = useIntentMutation<MergeItemsCommand, ItemCreated>({
    failed: 'Не слилось',
    run: (body, idempotencyKey) =>
      api.objectFiles.merge({
        params: { model, id },
        body,
        ifMatch: item.data?.version,
        idempotencyKey,
      }),
    invalidates: () => itemQueryKeys(model, id),
    onSuccess: ({ item_id: target }) => {
      onClose()
      toast.show({ message: `Слито · остался ${target}` })
      void navigate({ to: '/$model/i/$id', params: { model, id: target } })
    },
  })

  const noun = type ? ITEM_TYPE_INFO[type].noun : 'объект'
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-130">
        <form onSubmit={form.handleSubmit(merge.start)} className="flex min-h-0 flex-col gap-5">
          <DialogHeader>
            <DialogTitle>Слить {id} с другим объектом</DialogTitle>
            <DialogDescription>
              {plan
                ? `Останется ${plan.stays}: файлы, связи и отметки «выходило» ${plan.goes} перейдут в него, ${plan.goes} станет старым именем.`
                : `Сливается ${noun} с объектом того же типа. Останется младший номер, второй станет его старым именем.`}
            </DialogDescription>
          </DialogHeader>
          <Controller
            control={form.control}
            name="into"
            render={({ field }) => (
              <ItemPicker
                label="Найти объект"
                entries={same}
                value={field.value ?? null}
                onChange={field.onChange}
              />
            )}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit" disabled={!into || !item.data} pending={merge.isPending}>
              {into ? `Слить с ${into}` : 'Слить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
