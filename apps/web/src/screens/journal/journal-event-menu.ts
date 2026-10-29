import type { ItemId, JournalEvent, ModelCode } from '@contentops/contracts'
import type { ItemMenuModel, MenuAction } from '@contentops/ui/components/item-menu'
import { useNavigate } from '@tanstack/react-router'
import { CopyIcon, ExternalLinkIcon, HistoryIcon } from 'lucide-react'
import { useCallback } from 'react'
import { useActionToast } from '@/actions/action-toast-context'

/**
 * «⋯» события (§4.18): открыть объект, все его события и «Скопировать номер для
 * разработчика» — `request_id`, по которому находят запрос в логах сервера.
 */
export function useJournalEventMenu(
  model: ModelCode,
  showItemEvents: (item: ItemId) => void,
): (event: JournalEvent) => ItemMenuModel {
  const navigate = useNavigate()
  const toast = useActionToast()
  return useCallback(
    (event: JournalEvent) => {
      const item = event.item_id
      const itemActions: MenuAction[] = item
        ? [
            {
              id: 'open',
              label: `Открыть ${item}`,
              icon: ExternalLinkIcon,
              onSelect: () => void navigate({ to: '/$model/i/$id', params: { model, id: item } }),
            },
            {
              id: 'item-events',
              label: `Все события ${item}`,
              icon: HistoryIcon,
              onSelect: () => showItemEvents(item),
            },
          ]
        : []
      return {
        actions: [
          ...itemActions,
          {
            id: 'request-id',
            label: 'Скопировать номер для разработчика',
            icon: CopyIcon,
            onSelect: () => {
              void navigator.clipboard?.writeText(event.request_id)
              toast.show({ message: `Скопировано · ${event.request_id}` })
            },
          },
        ],
      }
    },
    [model, navigate, showItemEvents, toast],
  )
}
