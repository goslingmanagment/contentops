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
import { useItem, useItemWriter } from '@/data/object'
import { useCurrentModel } from '@/shell/model/model-context'
import { FilePicker } from './file-picker'

/** Мастер объекта: у фупа он «монтаж» (ключ тот же — `master`). */
const isMaster = (file: ItemFile) => file.key === 'master'

interface MasterVersionDialogProps {
  id: ItemId
  onClose: () => void
}

/**
 * «Новая версия мастера из файла…» у фупа и PPV (DESIGN §4.5): байты файла каталога — в объекте
 * или ушедшего из него (`FYP-0036/master` слитого фупа) — становятся следующей версией мастера.
 * Ключ мастера тот же, прежняя версия остаётся; имя скачивания новой — с `_v2`.
 */
export function MasterVersionDialog({ id, onClose }: MasterVersionDialogProps) {
  const model = useCurrentModel().code
  const api = useApi()
  const toast = useActionToast()
  const write = useItemWriter(model)
  const item = useItem(model, id)
  const entries = useCatalogIndex(model).data?.items ?? []
  const [from, setFrom] = useState('')
  const valid = FileAddressSchema.safeParse(from).success
  const master = item.data?.files.find(isMaster)

  const make = useIntentMutation<string, ItemDetail>({
    failed: 'Версия не сделана',
    run: (address, idempotencyKey) =>
      api.objectFiles.masterVersion({
        params: { model, id },
        body: { from: address },
        ifMatch: item.data?.version,
        idempotencyKey,
      }),
    onSuccess: (detail, address) => {
      write(detail)
      onClose()
      const version = detail.files.find(isMaster)?.current_version
      toast.show({ message: `Мастер ${id} · v${version ?? '?'} из ${address}` })
    },
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-130">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (valid) make.start(from)
          }}
          className="flex min-h-0 flex-col gap-5"
        >
          <DialogHeader>
            <DialogTitle>Новая версия мастера {id}</DialogTitle>
            <DialogDescription>
              Байты выбранного видео станут версией v{(master?.current_version ?? 1) + 1} мастера.
              Нынешняя версия останется в истории, имена её скачиваний — за ней.
            </DialogDescription>
          </DialogHeader>
          <FilePicker
            model={model}
            entries={entries}
            media="video"
            except={`${id}/master`}
            value={from}
            onChange={setFrom}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit" disabled={!valid || !item.data} pending={make.isPending}>
              {valid ? `Взять ${from}` : 'Сделать версию'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
