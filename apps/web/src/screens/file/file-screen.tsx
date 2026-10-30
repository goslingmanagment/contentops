import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'
import { ObjectPage } from '@/screens/object/object-page'
import type { ObjectSearch } from '@/screens/object/search'
import { useCurrentModel } from '@/shell/model/model-context'

const routeApi = getRouteApi('/_shell/$model/a/$id/$file')

/**
 * Файл объекта `/<модель>/a/<ID>/<файл>` (DESIGN §2.4): адрес, которым делятся, открывает
 * объект с этим файлом в просмотре. Закрытие и любая смена вида ведут на адрес объекта.
 */
export function FileScreen() {
  const { id, file } = routeApi.useParams()
  const model = useCurrentModel().code
  const navigate = useNavigate()
  const search = useMemo<ObjectSearch>(() => ({ view: file }), [file])
  const changeSearch = useCallback(
    (patch: Partial<ObjectSearch>) =>
      void navigate({
        to: '/$model/i/$id',
        params: { model, id },
        search: { ...search, ...patch },
        replace: true,
      }),
    [id, model, navigate, search],
  )
  return <ObjectPage key={id} id={id} search={search} onSearchChange={changeSearch} />
}
