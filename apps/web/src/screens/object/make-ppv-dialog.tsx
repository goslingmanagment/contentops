import type { ItemId } from '@contentops/contracts'
import { itemTypeOf } from '@contentops/contracts'
import { Dialog, DialogContent } from '@contentops/ui/components/dialog'
import { CurrentModelContext } from '@/shell/model/model-context'
import { useShellModel } from '@/shell/model/use-shell-model'
import { MakeMasterForm } from './dialogs/make-master-form'
import { MakePpvForm } from './dialogs/make-ppv-form'

export interface MakePpvDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Кастом («Сделать PPV») или сырьё («Сделать мастером PPV»). */
  source: ItemId
}

/**
 * Окно «Сделать PPV» из кастома и «Сделать мастером PPV» из сырья (DESIGN §3.9, 520):
 * общее окно оболочки, содержимое — по типу источника. Черновик над тем же файлом,
 * принятие в этом же окне, без повторной обработки.
 */
export function MakePpvDialog({ open, onOpenChange, source }: MakePpvDialogProps) {
  // Окно живёт в оболочке, над маршрутом модели: модель берётся из адреса так же, как
  // её берёт колонка, и отдаётся содержимому окна обычным контекстом.
  const { model } = useShellModel()
  const close = () => onOpenChange(false)
  if (!model) {
    return null
  }
  return (
    <CurrentModelContext value={model}>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-130">
          {itemTypeOf(source) === 'raw' ? (
            <MakeMasterForm source={source} onDone={close} />
          ) : (
            <MakePpvForm source={source} onDone={close} />
          )}
        </DialogContent>
      </Dialog>
    </CurrentModelContext>
  )
}
