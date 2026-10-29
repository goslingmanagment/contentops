import type { InboxGroup } from '@contentops/contracts'
import type { ItemMenuModel } from '@contentops/ui/components/item-menu'
import { type RefObject, useCallback } from 'react'
import { draftActionsOf } from '../panel/draft-actions'
import type { DraftPanelHandle } from '../panel/draft-panel'
import { groupMenu } from './group-menu'
import type { IntakeActions } from './use-intake-actions'

/** Меню исчезает за 120 мс (§7.8) и в конце возвращает фокус своей кнопке. */
const MENU_CLOSE_MS = 160

/**
 * Всплывашку открываем, когда меню уже закрылось и вернуло фокус своей кнопке, — иначе
 * этот возврат фокуса сразу закрыл бы её, а поле ввода осталось бы без фокуса.
 */
function afterMenuCloses(open: () => void): () => void {
  return () => window.setTimeout(open, MENU_CLOSE_MS)
}

/**
 * Меню группы для «⋯» панели и правого клика на плитке (DESIGN §3.6). Пункты, которым
 * нужно поле ввода («Дополнить…», «Отклонить…», «Разделить…»), открываются в панели —
 * группа к этому времени уже выбрана.
 */
export function useGroupMenu(
  groups: readonly InboxGroup[],
  actions: IntakeActions,
  panelRef: RefObject<DraftPanelHandle | null>,
): (group: InboxGroup) => ItemMenuModel {
  return useCallback(
    (group: InboxGroup) =>
      groupMenu(group, groups, {
        accept: (target) => actions.accept(target, draftActionsOf(target).primary.command),
        extend: afterMenuCloses(() => panelRef.current?.extend()),
        split: () => panelRef.current?.showFiles(),
        merge: (target, other) => actions.merge([target.id, other.id]),
        download: (target) => actions.download(target),
        reject: afterMenuCloses(() => panelRef.current?.reject()),
      }),
    [actions, groups, panelRef],
  )
}
