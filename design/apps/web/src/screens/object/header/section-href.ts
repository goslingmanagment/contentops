import type { ItemType } from '@contentops/contracts'
import { useCallback } from 'react'
import { useHref } from '@/app/use-href'
import type { LibrarySectionSlug } from '@/screens/library/search'
import { useCurrentModel } from '@/shell/model/model-context'

/** Разделы-типы с адресом `library/<раздел>`; Кастомы и Промо живут по своим адресам. */
const SECTION_SLUG: Record<Exclude<ItemType, 'custom' | 'promo'>, LibrarySectionSlug> = {
  ppv: 'ppv',
  fyp: 'fyp',
  set: 'sets',
  sexting: 'sextings',
  life: 'life',
  raw: 'raw',
}

/** Адреса Библиотеки для крошек объекта: корень и раздел его типа (DESIGN §2.4). */
export function useSectionHref() {
  const model = useCurrentModel().code
  const href = useHref()
  const section = useCallback(
    (type: ItemType): string => {
      if (type === 'custom') {
        return href({ to: '/$model/library/customs', params: { model } })
      }
      if (type === 'promo') {
        return href({ to: '/$model/library/promo', params: { model } })
      }
      return href({
        to: '/$model/library/$section',
        params: { model, section: SECTION_SLUG[type] },
      })
    },
    [href, model],
  )
  return { library: href({ to: '/$model/library', params: { model } }), section }
}
