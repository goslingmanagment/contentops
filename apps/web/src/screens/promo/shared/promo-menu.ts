import type { ItemMenuModel } from '@contentops/ui/components/item-menu'
import { useNavigate } from '@tanstack/react-router'
import { useCurrentModel } from '@/shell/model/model-context'

/** «⋯» канала и подборки (DESIGN §3.6): «Передачи» — список всех передач модели. */
export function usePromoMenu(): ItemMenuModel {
  const model = useCurrentModel().code
  const navigate = useNavigate()
  return {
    actions: [
      {
        id: 'handoffs',
        label: 'Передачи',
        onSelect: () =>
          void navigate({
            to: '/$model/library/promo',
            params: { model },
            search: { view: 'handoffs' },
          }),
      },
    ],
  }
}
