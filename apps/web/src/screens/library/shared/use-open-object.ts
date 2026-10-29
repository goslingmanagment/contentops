import type { ItemId } from '@contentops/contracts'
import { useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { useCurrentModel } from '@/shell/model/model-context'

/**
 * Открыть объект из списка Библиотеки (`Enter`, двойной клик). Просмотр из сетки (`Space`)
 * открывается поверх неё — `useEntryPreview`.
 */
export function useOpenObject() {
  const model = useCurrentModel().code
  const navigate = useNavigate()
  return useCallback(
    (id: ItemId) => void navigate({ to: '/$model/i/$id', params: { model, id } }),
    [model, navigate],
  )
}
