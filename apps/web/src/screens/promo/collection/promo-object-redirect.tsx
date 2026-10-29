import { type ItemId, isApiError } from '@contentops/contracts'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import { Navigate } from '@tanstack/react-router'
import { usePromoCollection } from '@/data/promo'
import { NotFoundState } from '@/screens/errors'
import { FieldLayout } from '@/shell/field/field-layout'
import { useCurrentModel } from '@/shell/model/model-context'
import { CollectionSkeleton } from './collection-skeleton'

/**
 * Подборка открывается одним экраном (DESIGN §4.17): адрес объекта `#/<модель>/i/PRM-015`
 * (Журнал, поиск, ссылки из других объектов) заменяется адресом подборки в её канале.
 * Канал известен только самой подборке, поэтому сначала она читается — тем же запросом,
 * что потом возьмёт экран подборки.
 */
export function PromoObjectRedirect({ id }: { id: ItemId }) {
  const model = useCurrentModel()
  const query = usePromoCollection(model.code, id)
  if (query.data) {
    return (
      <Navigate
        to="/$model/library/promo/$channel/$collection"
        params={{ model: model.code, channel: query.data.channel, collection: id }}
        replace
      />
    )
  }
  if (query.isError) {
    if (isApiError(query.error) && query.error.status === 404) {
      return <NotFoundState message={`${id} у ${model.name_genitive} нет`} />
    }
    return (
      <FieldLayout>
        <ErrorLine layout="center" message="Не загрузилось" onRetry={() => void query.refetch()} />
      </FieldLayout>
    )
  }
  return (
    <FieldLayout>
      <div className="pt-24">
        <CollectionSkeleton />
      </div>
    </FieldLayout>
  )
}
