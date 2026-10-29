import { ErrorLine } from '@contentops/ui/components/state-lines'
import { getRouteApi, Outlet, useLocation, useParams } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useCatalogIndex, usePageSummaries } from '@/data/catalog'
import { useModels } from '@/data/session'
import { ForbiddenState, NotFoundState } from '@/screens/errors'
import { FieldSkeleton } from '../field/field-skeleton'
import { rememberSection } from '../last-section'
import { sectionOfPath } from '../section-of-path'
import { CurrentModelContext } from './model-context'

const routeApi = getRouteApi('/_shell/$model')

/**
 * Индекс модели — каталог и сводка по страницам — нужен почти каждому экрану. Оба ресурса
 * запрашиваются по коду из адреса сразу, вместе с сессией и списком моделей, а не третьим
 * шагом после них (DESIGN §3.10, §3.13). Без прав сервер ответит 403, и это ни на что не
 * влияет: экран «Нет доступа» решает список моделей.
 */
export function useModelIndexPrefetch(code: string | undefined) {
  const model = code ?? ''
  useCatalogIndex(model, code !== undefined)
  usePageSummaries(model, code !== undefined)
}

/**
 * Всё внутри `#/<модель>/…`: права на модель проверяются один раз, дальше экраны берут
 * модель из контекста. Без прав — «Нет доступа к этой модели» на месте поля. Пока список
 * моделей идёт, поле показывает шапку с заготовками, а индекс модели уже запрошен.
 */
export function ModelScope() {
  const { model: code } = routeApi.useParams()
  useModelIndexPrefetch(code)
  const models = useModels()
  const pathname = useLocation({ select: (location) => location.pathname })
  const model = models.data?.find((candidate) => candidate.code === code)

  const section = sectionOfPath(pathname)
  useEffect(() => {
    if (model && section) {
      rememberSection({ model: model.code, section })
    }
  }, [model, section])

  if (models.isPending) {
    return <FieldSkeleton />
  }
  if (models.isError) {
    return (
      <ErrorLine layout="center" message="Не загрузилось" onRetry={() => void models.refetch()} />
    )
  }
  if (!model) {
    return <ForbiddenState />
  }
  return (
    <CurrentModelContext value={model}>
      <Outlet />
    </CurrentModelContext>
  )
}

/** Адреса, которых нет, внутри модели: 404 на месте поля и строка поиска. */
export function ModelNotFound() {
  const code = useParams({ strict: false, select: (params) => params.model })
  const models = useModels()
  const model = models.data?.find((candidate) => candidate.code === code)
  if (!model) {
    return <NotFoundState />
  }
  return (
    <CurrentModelContext value={model}>
      <NotFoundState />
    </CurrentModelContext>
  )
}
