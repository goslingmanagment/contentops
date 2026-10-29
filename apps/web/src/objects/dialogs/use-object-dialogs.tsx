import type { CatalogEntry, ItemId } from '@contentops/contracts'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { ChangeTypeDialog } from './change-type-dialog'
import { DeleteItemDialog } from './delete-item-dialog'
import { MergeRawDialog } from './merge-raw-dialog'
import { SecondPersonDialog } from './second-person-dialog'
import { TagsDialog } from './tags-dialog'

/** Окна объекта из «⋯» и полосы выделения (DESIGN §3.3, §3.6, §3.9). */
export type ObjectDialogRequest =
  | { kind: 'change-type'; id: ItemId }
  | { kind: 'delete'; id: ItemId }
  | { kind: 'merge'; id: ItemId }
  | { kind: 'second-person'; items: readonly ItemId[]; value?: boolean; rows?: number }
  | { kind: 'tags'; entries: readonly CatalogEntry[] }

function DialogHost({ request, onClose }: { request: ObjectDialogRequest; onClose: () => void }) {
  if (request.kind === 'change-type') {
    return <ChangeTypeDialog id={request.id} onClose={onClose} />
  }
  if (request.kind === 'delete') {
    return <DeleteItemDialog id={request.id} onClose={onClose} />
  }
  if (request.kind === 'merge') {
    return <MergeRawDialog id={request.id} onClose={onClose} />
  }
  if (request.kind === 'second-person') {
    return (
      <SecondPersonDialog
        items={request.items}
        value={request.value}
        rows={request.rows}
        onClose={onClose}
      />
    )
  }
  return <TagsDialog entries={request.entries} onClose={onClose} />
}

/**
 * Окна объекта для любого экрана: `open(запрос)` открывает окно, `element` ставится в
 * разметку экрана. Одно окно за раз; после закрытия фокус возвращается на кнопку (Radix).
 */
export function useObjectDialogs(): {
  open: (request: ObjectDialogRequest) => void
  element: ReactNode
} {
  const [request, setRequest] = useState<ObjectDialogRequest | null>(null)
  const close = useCallback(() => setRequest(null), [])
  const element = useMemo(
    () => (request ? <DialogHost request={request} onClose={close} /> : null),
    [close, request],
  )
  return { open: setRequest, element }
}
