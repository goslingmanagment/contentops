import type { Model } from '@contentops/contracts'
import { createContext, useContext } from 'react'

/**
 * Модель из адреса (первый сегмент, DESIGN §2.4). Экраны внутри `/<модель>/…` получают
 * её уже проверенной: права есть, страницы загружены.
 */
export const CurrentModelContext = createContext<Model | null>(null)

export function useCurrentModel(): Model {
  const model = useContext(CurrentModelContext)
  if (!model) {
    throw new Error('Экран модели открыт вне маршрута /<модель>/…')
  }
  return model
}

/** Модель, если экран внутри её адреса; настройки и вход живут без модели. */
export function useOptionalModel(): Model | null {
  return useContext(CurrentModelContext)
}
