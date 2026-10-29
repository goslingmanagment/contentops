import type { MarkKind, PlanRow } from '@contentops/contracts'
import type { ItemMenuModel, MenuAction } from '@contentops/ui/components/item-menu'
import { isOpenRow } from './plan-text'

/** Правка строки в панели: перенос, заметка, передача другому (§3.9 — не окном). */
export type RowEditMode = 'move' | 'note' | 'assignee'

export interface RowMenuHandlers {
  canAct: boolean
  openItem: () => void
  mark: (kind: MarkKind) => void
  markConfirm: () => void
  download: () => void
  edit: (mode: RowEditMode) => void
  replaceManifest: () => void
  unmark: () => void
  cancel: () => void
}

/**
 * Меню строки плана для «⋯» и правого клика (DESIGN §3.6): Отметить ▾ · Скачать ·
 * Перенести… · Заменить состав (есть v2) · Заметка · Передать другому · — · Снять
 * отметку… · Отменить строку…. Неприменимые пункты не показываются.
 */
export function rowMenu(row: PlanRow, handlers: RowMenuHandlers): ItemMenuModel {
  const openItem: MenuAction = { id: 'open', label: 'Открыть объект', onSelect: handlers.openItem }
  const hasItem = row.manifest !== null
  if (!handlers.canAct || row.cancelled) {
    return { actions: hasItem ? [openItem] : [] }
  }
  const open = isOpenRow(row)
  const actions: MenuAction[] = []
  if (open && row.mark_button === 'mark') {
    actions.push({
      id: 'mark',
      label: 'Отметить',
      items: [
        { id: 'posted', label: 'Выложено', onSelect: () => handlers.mark('posted') },
        { id: 'scheduled', label: 'В планировщике', onSelect: () => handlers.mark('scheduled') },
      ],
    })
  }
  if (open && row.mark_button === 'mark_confirm') {
    actions.push({
      id: 'mark-confirm',
      label: 'Отметить и подтвердить',
      onSelect: handlers.markConfirm,
    })
  }
  if (hasItem) {
    actions.push({ id: 'download', label: 'Скачать', onSelect: handlers.download })
  }
  if (!row.mark) {
    actions.push({ id: 'move', label: 'Перенести…', onSelect: () => handlers.edit('move') })
  }
  if (row.has_newer_version) {
    actions.push({
      id: 'replace',
      label: 'Заменить состав (есть v2)',
      onSelect: handlers.replaceManifest,
    })
  }
  actions.push(
    { id: 'note', label: 'Заметка', onSelect: () => handlers.edit('note') },
    { id: 'assignee', label: 'Передать другому', onSelect: () => handlers.edit('assignee') },
  )
  if (hasItem) {
    actions.push(openItem)
  }
  const dangerActions: MenuAction[] = []
  if (row.mark) {
    dangerActions.push({ id: 'unmark', label: 'Снять отметку…', onSelect: handlers.unmark })
  } else {
    dangerActions.push({ id: 'cancel', label: 'Отменить строку…', onSelect: handlers.cancel })
  }
  return { actions, dangerActions }
}
