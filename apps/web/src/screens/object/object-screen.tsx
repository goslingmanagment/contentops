import { itemTypeOf } from '@contentops/contracts'
import { getRouteApi } from '@tanstack/react-router'
import { useCallback } from 'react'
import { PromoObjectRedirect } from '@/screens/promo'
import type { SearchChangeOptions } from './object-context'
import { ObjectPage } from './object-page'
import type { ObjectSearch } from './search'

const routeApi = getRouteApi('/_shell/$model/i/$id')

/**
 * Объект `/<модель>/i/<ID>` (DESIGN §4.4): понять без просмотра, что внутри и где уже
 * залито; скачать; поставить в план. Вкладка, раскрытая страница и просмотр — в адресе.
 */
export function ObjectScreen() {
  const { id } = routeApi.useParams()
  const search = routeApi.useSearch()
  const navigate = routeApi.useNavigate()
  const changeSearch = useCallback(
    (patch: Partial<ObjectSearch>, options?: SearchChangeOptions) =>
      void navigate({
        search: (previous) => ({ ...previous, ...patch }),
        replace: options?.replace ?? false,
      }),
    [navigate],
  )
  // Подборка промо — не объект со своей страницей, а папка Промо (DESIGN §4.17).
  if (itemTypeOf(id) === 'promo') return <PromoObjectRedirect id={id} />
  return <ObjectPage key={id} id={id} search={search} onSearchChange={changeSearch} />
}
