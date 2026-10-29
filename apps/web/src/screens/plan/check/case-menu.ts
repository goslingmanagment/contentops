import type { Account, CheckCase } from '@contentops/contracts'
import type { ItemMenuModel } from '@contentops/ui/components/item-menu'
import { isOpenCase } from '@/data/check'

interface CaseMenuHandlers {
  onReview: () => void
  onOutside: () => void
}

function openPost(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * Меню случая (DESIGN §3.6): «Разобрать · Пост на платформе ↗ · — · Не наше». Одна модель для «⋯» в панели и правого клика по строке. Неприменимых пунктов
 * нет; у «только чтение» — только ссылка на пост.
 */
export function caseMenu(
  entry: CheckCase,
  account: Account | undefined,
  canDecide: boolean,
  handlers: CaseMenuHandlers,
): ItemMenuModel {
  const open = isOpenCase(entry) && canDecide
  const post = entry.posts[0]
  const platform = account?.platform === 'onlyfans' ? 'OnlyFans' : 'Fansly'
  return {
    actions: [
      ...(open ? [{ id: 'review', label: 'Разобрать', onSelect: handlers.onReview }] : []),
      ...(post
        ? [{ id: 'post', label: `Пост на ${platform} ↗`, onSelect: () => openPost(post.url) }]
        : []),
    ],
    dangerActions:
      open && entry.kind === 'unplanned'
        ? [{ id: 'outside', label: 'Не наше', onSelect: handlers.onOutside }]
        : [],
  }
}
