import type { ItemId, ItemType } from '@contentops/contracts'
import { useCallback } from 'react'
import { useHref } from '@/app/use-href'
import { useCurrentModel } from '@/shell/model/model-context'
import type { LibrarySectionSlug } from '../search'

/** Разделы-типы со своим адресом `library/<раздел>`; Кастомы и Промо — отдельные адреса. */
const SECTION_SLUG: Record<Exclude<ItemType, 'custom' | 'promo'>, LibrarySectionSlug> = {
  ppv: 'ppv',
  fyp: 'fyp',
  set: 'sets',
  sexting: 'sextings',
  life: 'life',
  raw: 'raw',
}

/** Адрес корня Библиотеки текущей модели — для крошек разделов. */
export function useLibraryHref(): string {
  const model = useCurrentModel().code
  return useHref()({ to: '/$model/library', params: { model } })
}

/** Адреса папок, объектов и заказов Библиотеки текущей модели. */
export function useLibraryLinks() {
  const model = useCurrentModel().code
  const href = useHref()

  const folder = useCallback(
    (key: ItemType | 'not-uploaded' | 'markup'): string => {
      if (key === 'not-uploaded') {
        return href({ to: '/$model/library/not-uploaded', params: { model } })
      }
      if (key === 'markup') {
        return href({ to: '/$model/library/markup', params: { model } })
      }
      if (key === 'custom') {
        return href({ to: '/$model/library/customs', params: { model } })
      }
      if (key === 'promo') {
        return href({ to: '/$model/library/promo', params: { model } })
      }
      return href({
        to: '/$model/library/$section',
        params: { model, section: SECTION_SLUG[key] },
      })
    },
    [href, model],
  )

  const item = useCallback(
    (id: ItemId): string => href({ to: '/$model/i/$id', params: { model, id } }),
    [href, model],
  )

  const orders = useCallback(
    (): string =>
      href({ to: '/$model/library/customs', params: { model }, search: { view: 'orders' } }),
    [href, model],
  )

  return { folder, item, orders }
}
