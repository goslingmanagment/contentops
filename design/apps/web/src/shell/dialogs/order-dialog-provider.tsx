import { lazy, type ReactNode, Suspense, useMemo, useState } from 'react'
import {
  type NewOrderDialogApi,
  NewOrderDialogContext,
  type NewOrderSeed,
} from './order-dialog-context'

const NewOrderDialog = lazy(() =>
  import('@/screens/orders').then((screens) => ({ default: screens.NewOrderDialog })),
)

/** Окно «Новый заказ» (DESIGN §3.9): одно на оболочку, содержимое — из папки заказов. */
export function NewOrderDialogProvider({ children }: { children: ReactNode }) {
  const [seed, setSeed] = useState<NewOrderSeed | null>(null)
  const api = useMemo<NewOrderDialogApi>(
    () => ({ openNewOrderDialog: (next) => setSeed(next ?? {}) }),
    [],
  )
  return (
    <NewOrderDialogContext value={api}>
      {children}
      {seed ? (
        <Suspense fallback={null}>
          <NewOrderDialog
            open
            seed={seed}
            onOpenChange={(open) => {
              if (!open) {
                setSeed(null)
              }
            }}
          />
        </Suspense>
      ) : null}
    </NewOrderDialogContext>
  )
}
