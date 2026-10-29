import type { ItemId } from '@contentops/contracts'
import { createContext, useCallback, useContext, useMemo } from 'react'
import { z } from 'zod'
import { readHistoryValue } from '@/lib/history-state'
import { useHistoryState } from '@/lib/use-history-state'

/**
 * Выделение файлов объекта (DESIGN §3.3): ключи файлов и кадров мастера. Живёт в
 * `history.state`, поэтому «Назад» из просмотра возвращает его вместе с прокруткой.
 */
export interface FileSelection {
  keys: ReadonlySet<string>
  setKeys(next: Set<string>): void
  /** Галочка на плитке: добавить или убрать один ключ, не трогая остальные. */
  toggle(key: string, on: boolean): void
  clear(): void
}

const KeysSchema = z.array(z.string())

function selectionKey(id: ItemId): string {
  return `object:${id}:selection`
}

/** Выделение, с которым открыли окно поверх объекта: «Сделать мастером PPV» из сырья. */
export function readFileSelection(id: ItemId): readonly string[] {
  return readHistoryValue(selectionKey(id), KeysSchema) ?? []
}

export function useFileSelectionState(id: ItemId): FileSelection {
  const [stored, setStored] = useHistoryState(selectionKey(id), KeysSchema, () => [])
  const keys = useMemo(() => new Set(stored), [stored])
  const setKeys = useCallback((next: Set<string>) => setStored([...next]), [setStored])
  const toggle = useCallback(
    (key: string, on: boolean) =>
      setStored((current) =>
        on ? [...new Set([...current, key])] : current.filter((stored) => stored !== key),
      ),
    [setStored],
  )
  const clear = useCallback(() => setStored([]), [setStored])
  return useMemo(() => ({ keys, setKeys, toggle, clear }), [keys, setKeys, toggle, clear])
}

export const FileSelectionContext = createContext<FileSelection | null>(null)

export function useFileSelection(): FileSelection {
  const selection = useContext(FileSelectionContext)
  if (!selection) {
    throw new Error('Файлы объекта вне FileSelectionContext')
  }
  return selection
}
