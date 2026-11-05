import {
  FileAddressSchema,
  type ItemDetail,
  type ItemFile,
  type ItemId,
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
import { useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { useCatalogIndex } from '@/data/catalog'
import { itemQueryKeys, useItem, useItemWriter } from '@/data/object'
import { useCurrentModel } from '@/shell/model/model-context'
import { FilePicker } from './file-picker'

interface CopyOfDialogProps {
  id: ItemId
  file: ItemFile
  onClose: () => void
  onDone?: () => void
}

/**
 * «Это копия…» (SPEC §6.2): файл повторяет другой файл каталога — сжатое превью, второй экспорт.
 * Он уходит из объекта, его путь и старые имена находят оригинал, черновик приёмки становится
 * дублем оригинала; байты остаются.
 */
export function CopyOfDialog({ id, file, onClose, onDone }: CopyOfDialogProps) {
  const model = useCurrentModel().code
  const api = useApi()
  const toast = useActionToast()
  const write = useItemWriter(model)
  const item = useItem(model, id)
  const entries = useCatalogIndex(model).data?.items ?? []
  const [original, setOriginal] = useState('')
  const valid = FileAddressSchema.safeParse(original).success

  const mark = useIntentMutation<string, ItemDetail>({
    failed: 'Не отметилось',
    run: (address, idempotencyKey) =>
      api.objectFiles.copyOf({
        params: { model, id },
        body: { files: [{ key: file.key, original: address }] },
        ifMatch: item.data?.version,
        idempotencyKey,
      }),
    invalidates: (address) => itemQueryKeys(model, address.split('/')[0] as ItemId),
    onSuccess: (detail, address) => {
      write(detail)
      onDone?.()
      onClose()
      toast.show({ message: `${id}/${file.key} — копия ${address} · ушла из объекта` })
    },
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-130">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (valid) mark.start(original)
          }}
          className="flex min-h-0 flex-col gap-5"
        >
          <DialogHeader>
            <DialogTitle>
              {id}/{file.key} — копия другого файла
            </DialogTitle>
            <DialogDescription>
              Файл уйдёт из {id}. Его путь и старые имена будут находить оригинал, черновик приёмки
              станет дублем оригинала; байты останутся.
            </DialogDescription>
          </DialogHeader>
          <FilePicker
            model={model}
            entries={entries}
            media={file.media}
            except={`${id}/${file.key}`}
            value={original}
            onChange={setOriginal}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit" disabled={!valid || !item.data} pending={mark.isPending}>
              {valid ? `Копия ${original}` : 'Отметить копией'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
