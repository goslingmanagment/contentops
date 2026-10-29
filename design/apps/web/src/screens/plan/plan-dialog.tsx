import type { ItemId } from '@contentops/contracts'
import { Dialog, DialogContent } from '@contentops/ui/components/dialog'
import type { ReactNode } from 'react'
import type { PlanDialogPreset } from '@/shell/dialogs/plan-dialog-context'
import { CurrentModelContext, useOptionalModel } from '@/shell/model/model-context'
import { useShellModel } from '@/shell/model/use-shell-model'
import { PlanDialogBody } from './dialog/plan-dialog-body'

export interface PlanDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Что ставится в план: объекты из полосы выделения или быстрого взгляда. */
  items: readonly ItemId[]
  /** Подставленные поля: место нормы, ящик недели, «Залить заново». */
  preset?: PlanDialogPreset
}

/**
 * Окно оболочки живёт выше маршрута модели: модель ему даётся из адреса, как колонке,
 * чтобы содержимое окна работало одинаково из Плана, Библиотеки и объекта.
 */
function ModelOfAddress({ children }: { children: ReactNode }) {
  const current = useOptionalModel()
  const { model } = useShellModel()
  if (current) {
    return children
  }
  return model ? <CurrentModelContext value={model}>{children}</CurrentModelContext> : null
}

/**
 * Окно «В план» (DESIGN §4.13, 760 × до 640): поставить строку, несколько объектов или
 * выпуск за 3–5 кликов и сразу увидеть, можно ли. `Ctrl Enter` — поставить, `Esc` — закрыть.
 */
export function PlanDialog({ open, onOpenChange, items, preset = {} }: PlanDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(40rem,calc(100dvh-2.5rem))] max-w-190 flex-col gap-0 overflow-hidden p-0">
        {open ? (
          <ModelOfAddress>
            <PlanDialogBody items={items} preset={preset} onDone={() => onOpenChange(false)} />
          </ModelOfAddress>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
