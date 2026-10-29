import type { PlanRow } from '@contentops/contracts'
import type { ItemMenuModel } from '@contentops/ui/components/item-menu'
import { useNavigate } from '@tanstack/react-router'
import { useCurrentModel } from '@/shell/model/model-context'
import { useMarkActions } from './actions/use-mark-actions'
import { useRowActions } from './actions/use-row-actions'
import { type RowEditMode, rowMenu } from './row-menu'

interface RowMenusOptions {
  canAct: boolean
  /** «Перенести…», «Заметка», «Передать другому» — правка в панели. */
  onEdit: (row: PlanRow, mode: RowEditMode) => void
}

/**
 * Меню строки для «⋯», правого клика и панели (DESIGN §3.6): один список пунктов,
 * команды — те же, что у кнопок строки.
 */
export function useRowMenus({ canAct, onEdit }: RowMenusOptions) {
  const model = useCurrentModel().code
  const navigate = useNavigate()
  const marks = useMarkActions()
  const actions = useRowActions()
  return (row: PlanRow): ItemMenuModel =>
    rowMenu(row, {
      canAct,
      openItem: () => {
        const id = row.manifest?.item_id
        if (id) {
          void navigate({ to: '/$model/i/$id', params: { model, id } })
        }
      },
      mark: (kind) => marks.mark(row, kind),
      markConfirm: () => marks.markConfirm(row),
      download: () => actions.download(row),
      edit: (mode) => onEdit(row, mode),
      replaceManifest: () => actions.replaceManifest(row),
      unmark: () => marks.unmark([row]),
      cancel: () => actions.cancel([row]),
    })
}
