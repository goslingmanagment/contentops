import type { ItemId } from '@contentops/contracts'
import { lazy, type ReactNode, Suspense, useMemo, useState } from 'react'
import { type PlanDialogApi, PlanDialogContext, type PlanDialogPreset } from './plan-dialog-context'

const PlanDialog = lazy(() =>
  import('@/screens/plan').then((screens) => ({ default: screens.PlanDialog })),
)

interface OpenDialog {
  items: readonly ItemId[]
  preset: PlanDialogPreset | undefined
}

/** Окно «В план» (DESIGN §4.13): одно на оболочку, содержимое — из папки Плана. */
export function PlanDialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<OpenDialog | null>(null)
  const api = useMemo<PlanDialogApi>(
    () => ({ openPlanDialog: (items, preset) => setOpen({ items, preset }) }),
    [],
  )
  return (
    <PlanDialogContext value={api}>
      {children}
      {open ? (
        <Suspense fallback={null}>
          <PlanDialog
            open
            items={open.items}
            preset={open.preset}
            onOpenChange={(next) => {
              if (!next) {
                setOpen(null)
              }
            }}
          />
        </Suspense>
      ) : null}
    </PlanDialogContext>
  )
}
