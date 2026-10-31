import type { Crumb } from '@contentops/ui/components/field-header'
import { usePromoLinks } from './shared/promo-links'

/** Канал в крошках подборки: адрес по коду, подпись — имя канала. */
interface ChannelCrumb {
  id: string
  name: string
}

/**
 * Крошки Промо (DESIGN §3.2) до родителя экрана: у каналов и «Передач» — «Библиотека», у
 * канала — «Библиотека › Промо», у подборки ещё и «› Instagram».
 */
export function usePromoCrumbs(parent: 'library' | 'promo' | ChannelCrumb): Crumb[] {
  const links = usePromoLinks()
  const crumbs: Crumb[] = [{ label: 'Библиотека', href: links.library() }]
  if (parent === 'library') return crumbs
  crumbs.push({ label: 'Промо', href: links.root() })
  if (parent === 'promo') return crumbs
  crumbs.push({ label: parent.name, href: links.channel(parent.id) })
  return crumbs
}
