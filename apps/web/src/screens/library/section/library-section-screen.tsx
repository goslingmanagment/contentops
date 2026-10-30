import { itemTypeBySlug } from '@contentops/contracts'
import { getRouteApi } from '@tanstack/react-router'
import { useCallback } from 'react'
import { CustomsViewSwitch } from '../shared/customs-view-switch'
import type { SectionType } from './section-config'
import { type SearchChangeOptions, type SectionSearch, SectionView } from './section-view'

const sectionApi = getRouteApi('/_shell/$model/library/$section')
const customsApi = getRouteApi('/_shell/$model/library/customs')

function sectionTypeOf(slug: string): SectionType | null {
  const type = itemTypeBySlug(slug)
  return type === null || type === 'promo' ? null : type
}

/** Раздел-тип `/<модель>/library/<тип>` (DESIGN §4.2). */
export function LibrarySectionScreen() {
  const { section } = sectionApi.useParams()
  const search = sectionApi.useSearch()
  const navigate = sectionApi.useNavigate()
  const change = useCallback(
    (patch: Partial<SectionSearch>, options?: SearchChangeOptions) =>
      void navigate({
        search: (previous) => ({ ...previous, ...patch }),
        replace: !options?.push,
      }),
    [navigate],
  )
  const type = sectionTypeOf(section)
  return type ? (
    <SectionView key={type} type={type} search={search} onSearchChange={change} />
  ) : null
}

/**
 * Кастомы как раздел: `/<модель>/library/customs` без `?view=orders`. В шапке —
 * «Все · Заказы · Переделка в PPV»; заказы и переделку рисуют их экраны.
 */
export function CustomsSectionScreen() {
  const { view, ...search } = customsApi.useSearch()
  const navigate = customsApi.useNavigate()
  const change = useCallback(
    (patch: Partial<SectionSearch>, options?: SearchChangeOptions) =>
      void navigate({
        search: (previous) => ({ ...previous, ...patch }),
        replace: !options?.push,
      }),
    [navigate],
  )
  const tileView = view === 'orders' || view === 'to-ppv' ? undefined : view
  return (
    <SectionView
      type="custom"
      search={{ ...search, view: tileView }}
      onSearchChange={change}
      nav={<CustomsViewSwitch value="all" />}
    />
  )
}
