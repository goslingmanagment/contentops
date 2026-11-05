import type { ItemDetail, ItemId, MoveFilesCommand } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentops/ui/components/dialog'
import { useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { useCatalogIndex } from '@/data/catalog'
import { itemQueryKeys, useItem, useItemWriter } from '@/data/object'
import { filesWord } from '@/lib/words'
import { useCurrentModel } from '@/shell/model/model-context'
import { ItemPicker } from './item-picker'

interface MoveFilesDialogProps {
  id: ItemId
  keys: readonly string[]
  onClose: () => void
  /** После переноса: снять выделение файлов. */
  onMoved?: () => void
}

/**
 * «Перенести в…» (DESIGN §3.3): выбранные файлы уходят в другой объект модели любого типа и
 * получают там следующие номера своих ролей; старые ключи остаются старыми именами. Файл,
 * которому там нет места (видео в сет, второй мастер), сервер называет — ничего не переносится.
 */
export function MoveFilesDialog({ id, keys, onClose, onMoved }: MoveFilesDialogProps) {
  const model = useCurrentModel().code
  const api = useApi()
  const toast = useActionToast()
  const navigate = useNavigate()
  const write = useItemWriter(model)
  const item = useItem(model, id)
  const index = useCatalogIndex(model)
  const [into, setInto] = useState<ItemId | null>(null)
  const others = useMemo(
    () => (index.data?.items ?? []).filter((entry) => entry.id !== id),
    [id, index.data],
  )

  const move = useIntentMutation<MoveFilesCommand, ItemDetail>({
    failed: 'Не перенеслось',
    run: (body, idempotencyKey) =>
      api.objectFiles.move({
        params: { model, id },
        body,
        ifMatch: item.data?.version,
        idempotencyKey,
      }),
    invalidates: (body) => itemQueryKeys(model, body.into),
    onSuccess: (detail, body) => {
      write(detail)
      onMoved?.()
      onClose()
      toast.show({
        message: `Перенесено в ${body.into} · ${filesWord(body.keys.length)}${detail.files.length === 0 ? ` · ${id} пуст` : ''}`,
        action: {
          label: 'Открыть',
          onSelect: () => void navigate({ to: '/$model/i/$id', params: { model, id: body.into } }),
        },
      })
    },
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-130">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (into) move.start({ keys: [...keys], into })
          }}
          className="flex min-h-0 flex-col gap-5"
        >
          <DialogHeader>
            <DialogTitle>Перенести {filesWord(keys.length)} в другой объект</DialogTitle>
            <DialogDescription>
              {keys.join(', ')} из {id} получат следующие номера в выбранном объекте; старые ключи
              найдутся поиском.
            </DialogDescription>
          </DialogHeader>
          <ItemPicker label="Найти объект" entries={others} value={into} onChange={setInto} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit" disabled={!into || !item.data} pending={move.isPending}>
              {into ? `Перенести в ${into}` : 'Перенести'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
