import { formatNumber } from '@contentops/contracts'
import type { ItemMenuModel } from '@contentops/ui/components/item-menu'
import { useNavigate } from '@tanstack/react-router'
import { useDeletedItems } from '@/data/catalog'
import { useCurrentModel } from '@/shell/model/model-context'

/**
 * «⋯» в шапке раздела Библиотеки (DESIGN §3.2): выделить всё, что прошло фильтры (как
 * `Ctrl A`), и удалённые объекты модели.
 */
export function useLibraryMenu(visibleCount: number, selectAll: () => void): ItemMenuModel {
  const model = useCurrentModel().code
  const navigate = useNavigate()
  const deleted = useDeletedItems(model).data
  return {
    actions: [
      {
        id: 'select-all',
        label: `Выделить всё · ${formatNumber(visibleCount)}`,
        disabled: visibleCount === 0,
        onSelect: selectAll,
      },
      {
        id: 'deleted',
        label:
          deleted === undefined
            ? 'Удалённые объекты'
            : `Удалённые объекты · ${formatNumber(deleted.length)}`,
        onSelect: () => void navigate({ to: '/$model/library/deleted', params: { model } }),
      },
    ],
  }
}
