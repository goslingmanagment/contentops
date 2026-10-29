import type { ItemId } from '@contentops/contracts'
import { lazy, type ReactNode, Suspense, useMemo, useState } from 'react'
import { type MakePpvDialogApi, MakePpvDialogContext } from './make-ppv-dialog-context'

const MakePpvDialog = lazy(() =>
  import('@/screens/object').then((screens) => ({ default: screens.MakePpvDialog })),
)

/** Окно «Сделать PPV» (DESIGN §3.9): одно на оболочку, содержимое — из папки объекта. */
export function MakePpvDialogProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<ItemId | null>(null)
  const api = useMemo<MakePpvDialogApi>(
    () => ({ openMakePpvDialog: (next) => setSource(next) }),
    [],
  )
  return (
    <MakePpvDialogContext value={api}>
      {children}
      {source ? (
        <Suspense fallback={null}>
          <MakePpvDialog
            open
            source={source}
            onOpenChange={(open) => {
              if (!open) {
                setSource(null)
              }
            }}
          />
        </Suspense>
      ) : null}
    </MakePpvDialogContext>
  )
}
