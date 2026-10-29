import type { ItemId } from '@contentops/contracts'
import { createContext, useContext } from 'react'

/**
 * Окна «Сделать PPV» (из кастома) и «Сделать мастером PPV» (из сырья) — DESIGN §3.9 —
 * открываются из объекта и из «Переделки в PPV», а живут в папке объекта.
 */
export interface MakePpvDialogApi {
  openMakePpvDialog(source: ItemId): void
}

export const MakePpvDialogContext = createContext<MakePpvDialogApi | null>(null)

export function useMakePpvDialog(): MakePpvDialogApi {
  const api = useContext(MakePpvDialogContext)
  if (!api) {
    throw new Error('MakePpvDialogContext не подключён: экран вне оболочки')
  }
  return api
}
