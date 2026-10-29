import type { CollectionMember } from '@contentops/contracts'
import { useCallback, useMemo } from 'react'
import { z } from 'zod'
import { useHistoryState } from '@/lib/use-history-state'
import { memberKey } from './promo-text'

const SelectionSchema = z.array(z.string())

/**
 * Выбранные материалы подборки или канала: живут в записи истории (DESIGN §2.4), в
 * адрес не пишутся; «Назад» из объекта возвращает их. Выбор, которого больше нет в
 * данных (материал убрали), отбрасывается.
 */
export function useMemberSelection(scope: string, members: readonly CollectionMember[]) {
  const [stored, setStored] = useHistoryState(`promo:selection:${scope}`, SelectionSchema, () => [])
  const present = useMemo(() => new Set(members.map(memberKey)), [members])
  const selectedKeys = useMemo(
    () => new Set(stored.filter((key) => present.has(key))),
    [stored, present],
  )
  const selected = useMemo(
    () => members.filter((member) => selectedKeys.has(memberKey(member))),
    [members, selectedKeys],
  )
  const setSelectedKeys = useCallback(
    (next: ReadonlySet<string>) => setStored([...next]),
    [setStored],
  )
  const clear = useCallback(() => setStored([]), [setStored])
  return { selectedKeys, selected, setSelectedKeys, clear }
}
