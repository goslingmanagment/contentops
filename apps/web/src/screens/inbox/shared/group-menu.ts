import type { InboxGroup } from '@contentops/contracts'
import type { ItemMenuModel, MenuAction } from '@contentops/ui/components/item-menu'
import { draftActionsOf } from '../panel/draft-actions'
import { canMergeGroups } from './batch'

const MERGE_CHOICES = 8

export interface GroupMenuHandlers {
  accept: (group: InboxGroup) => void
  extend: () => void
  split: () => void
  merge: (group: InboxGroup, other: InboxGroup) => void
  download: (group: InboxGroup) => void
  reject: () => void
}

/**
 * Меню группы «Приехало» (DESIGN §3.6): одно и то же у «⋯» панели и по правому клику на
 * плитке. «Принять · Дополнить… · Разделить… · Слить с… · Скачать исходник · — ·
 * Отклонить…»; недоступное — серым с тем же местом.
 */
export function groupMenu(
  group: InboxGroup,
  others: readonly InboxGroup[],
  handlers: GroupMenuHandlers,
): ItemMenuModel {
  const model = draftActionsOf(group)
  const canAccept = model.primary.kind === 'accept' && model.primary.enabled
  const mergeWith: MenuAction[] = others
    .filter((other) => other.id !== group.id && canMergeGroups([group, other]))
    .slice(0, MERGE_CHOICES)
    .map((other) => ({
      id: `merge-${other.id}`,
      label: other.title,
      onSelect: () => handlers.merge(group, other),
    }))
  return {
    actions: [
      {
        id: 'accept',
        label: 'Принять',
        disabled: !canAccept,
        onSelect: () => handlers.accept(group),
      },
      {
        id: 'extend',
        label: 'Дополнить…',
        disabled: !model.secondary.includes('extend'),
        onSelect: handlers.extend,
      },
      {
        id: 'split',
        label: 'Разделить…',
        disabled: group.files.length < 2,
        onSelect: handlers.split,
      },
      { id: 'merge', label: 'Слить с…', disabled: mergeWith.length === 0, items: mergeWith },
      {
        id: 'download',
        label: 'Скачать исходник',
        disabled: group.files.length === 0,
        onSelect: () => handlers.download(group),
      },
    ],
    dangerActions: model.secondary.includes('reject')
      ? [{ id: 'reject', label: 'Отклонить…', onSelect: handlers.reject }]
      : [],
  }
}
