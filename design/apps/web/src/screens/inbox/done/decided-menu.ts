import { type AcceptHow, type ItemId, type ItemType, itemTypeOf } from '@contentops/contracts'
import type { ItemMenuModel } from '@contentops/ui/components/item-menu'

export interface DecidedMenuHandlers {
  open: (id: ItemId) => void
  plan: (id: ItemId) => void
  copy: (id: ItemId) => void
  journal: (id: ItemId) => void
  changeType: (id: ItemId) => void
  remove: (id: ItemId) => void
}

/** Кастом и промо в план не ставятся — как в «⋯» объекта. */
const NO_PLAN: ReadonlySet<ItemType> = new Set(['custom', 'promo'])

/** Приёмка, которая создала объект: его и исправляют «Сменить тип» или «Удалить» (§4.10). */
const CREATED: ReadonlySet<AcceptHow> = new Set(['new', 'delivery', 'upload'])

/**
 * «⋯» строки «Решённого» (DESIGN §3.6, §4.10): меню объекта, в который приняли группу.
 * Отмены принятия нет — номер выдан; ошибку исправляют «Сменить тип (будет новый
 * номер)…» и «Удалить…». У дубля, дополнения и исправления объект был и раньше — его
 * отсюда не удаляют. «Только чтение» видит ссылки, но не действия.
 */
export function decidedMenu(
  id: ItemId,
  how: AcceptHow,
  canAct: boolean,
  handlers: DecidedMenuHandlers,
): ItemMenuModel {
  const links = [
    { id: 'open', label: 'Открыть', onSelect: () => handlers.open(id) },
    ...(canAct && !NO_PLAN.has(itemTypeOf(id))
      ? [{ id: 'plan', label: 'В план', onSelect: () => handlers.plan(id) }]
      : []),
    { id: 'copy', label: 'Скопировать ID', onSelect: () => handlers.copy(id) },
    { id: 'journal', label: 'Журнал объекта', onSelect: () => handlers.journal(id) },
  ]
  if (!canAct || !CREATED.has(how)) {
    return { actions: links }
  }
  return {
    actions: links,
    dangerActions: [
      {
        id: 'change-type',
        label: 'Сменить тип (будет новый номер)…',
        onSelect: () => handlers.changeType(id),
      },
      { id: 'delete', label: 'Удалить…', onSelect: () => handlers.remove(id) },
    ],
  }
}
