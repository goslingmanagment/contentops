import {
  type ItemCreated,
  type ItemId,
  type MergeRawCommand,
  MergeRawCommandSchema,
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

interface MergeRawDialogProps {
  id: ItemId
  onClose: () => void
}

/**
 * «Слить с…» у сырья (DESIGN §4.5): эта съёмка входит в другую, её номер остаётся старым
 * именем. Выбор — из индекса, без запроса.
 */
export function MergeRawDialog({ id, onClose }: MergeRawDialogProps) {
  const model = useCurrentModel().code
  const api = useApi()
  const toast = useActionToast()
  const navigate = useNavigate()
  const item = useItem(model, id)
  const index = useCatalogIndex(model)
  const shoots = useMemo(
    () => (index.data?.items ?? []).filter((entry) => entry.type === 'raw' && entry.id !== id),
    [id, index.data],
  )
  const form = useForm<MergeRawCommand>({ resolver: zodResolver(MergeRawCommandSchema) })
  const into = form.watch('into')

  const merge = useIntentMutation<MergeRawCommand, ItemCreated>({
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
      toast.show({ message: `${id} слит с ${target}` })
      void navigate({ to: '/$model/i/$id', params: { model, id: target } })
    },
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-130">
        <form onSubmit={form.handleSubmit(merge.start)} className="flex min-h-0 flex-col gap-5">
          <DialogHeader>
            <DialogTitle>Слить {id} с другой съёмкой</DialogTitle>
            <DialogDescription>
              Файлы перейдут в выбранную съёмку, {id} останется её старым именем.
            </DialogDescription>
          </DialogHeader>
          <Controller
            control={form.control}
            name="into"
            render={({ field }) => (
              <ItemPicker
                label="Найти съёмку"
                entries={shoots}
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
