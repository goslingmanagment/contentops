import type { ItemId } from '@contentops/contracts'
import { useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'
import { useHref } from '@/app/use-href'
import { useCurrentModel } from '@/shell/model/model-context'
import { HANDOFF_PANEL_KEY, type HandoffPanelState } from '../handoff/handoff-panel-state'

/** Адреса Промо (DESIGN §2.4) одной модели: корень, передачи, канал, подборка, объект. */
export function usePromoLinks() {
  const model = useCurrentModel().code
  const href = useHref()
  return useMemo(
    () => ({
      library: () => href({ to: '/$model/library', params: { model } }),
      root: () => href({ to: '/$model/library/promo', params: { model } }),
      handoffs: () =>
        href({ to: '/$model/library/promo', params: { model }, search: { view: 'handoffs' } }),
      channel: (channel: string) =>
        href({ to: '/$model/library/promo/$channel', params: { model, channel } }),
      collection: (channel: string, collection: ItemId) =>
        href({
          to: '/$model/library/promo/$channel/$collection',
          params: { model, channel, collection },
        }),
      item: (id: ItemId) => href({ to: '/$model/i/$id', params: { model, id } }),
    }),
    [href, model],
  )
}

/**
 * Переход в подборку с открытой панелью передачи: из списка «Передачи» и после того, как
 * выбор в канале стал новой подборкой. Панель — состояние записи истории, «Назад» её
 * возвращает.
 */
export function useOpenCollection() {
  const model = useCurrentModel().code
  const navigate = useNavigate()
  return (channel: string, collection: ItemId, panel?: HandoffPanelState) => {
    // Запись истории — словарь по ключам экранов (`lib/history-state`).
    const state: Record<string, HandoffPanelState> = panel ? { [HANDOFF_PANEL_KEY]: panel } : {}
    void navigate({
      to: '/$model/library/promo/$channel/$collection',
      params: { model, channel, collection },
      state,
    })
  }
}
