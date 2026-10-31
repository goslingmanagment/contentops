import {
  formatDate,
  type ItemDetail,
  type ItemId,
  isApiError,
  type LocalDate,
  mskDate,
} from '@contentops/contracts'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import { useNavigate } from '@tanstack/react-router'
import { useToday } from '@/data/api-session'
import { useCatalogIndex } from '@/data/catalog'
import { useItem } from '@/data/object'
import { ForbiddenState, GoneState, NotFoundState } from '@/screens/errors'
import { FieldLayout } from '@/shell/field/field-layout'
import { useCurrentModel } from '@/shell/model/model-context'
import { instrumentalName } from './header/person-name'
import type { SearchChangeOptions } from './object-context'
import { ObjectHeaderSkeleton, ObjectSkeleton } from './object-skeleton'
import { ObjectView } from './object-view'
import type { ObjectSearch } from './search'

interface ObjectPageProps {
  id: ItemId
  search: ObjectSearch
  onSearchChange: (patch: Partial<ObjectSearch>, options?: SearchChangeOptions) => void
}

/**
 * Страница объекта со всеми состояниями (DESIGN §3.10): до ответа — шапка, мета и обложка
 * из каталога модели, заготовки на месте остального; 404 и 403 на месте поля, удалённый
 * и слитый объект, ошибка без данных.
 */
export function ObjectPage({ id, search, onSearchChange }: ObjectPageProps) {
  const today = useToday()
  const model = useCurrentModel()
  const item = useItem(model.code, id)
  // Каталог модели уже в памяти: пока карточка идёт, шапка и мета стоят по его записи.
  const known = useCatalogIndex(model.code).data?.byId.get(id)

  if (item.data) {
    const gone = goneMessage(item.data, today)
    if (gone) {
      return <GoneObject detail={item.data} message={gone} />
    }
    return (
      <ObjectView
        detail={item.data}
        search={search}
        onSearchChange={onSearchChange}
        refreshing={item.isFetching}
        query={item}
      />
    )
  }
  if (item.isError) {
    if (isApiError(item.error) && item.error.status === 404) {
      // «PPV-099 у Лоры нет» (§3.10), как у подборки промо, — не фраза сервера для агента.
      return <NotFoundState message={`${id} у ${model.name_genitive} нет`} />
    }
    if (isApiError(item.error) && item.error.status === 403) {
      return <ForbiddenState />
    }
    return (
      <FieldLayout>
        <ObjectHeaderSkeleton id={id} failed />
        <ErrorLine layout="center" message="Не загрузилось" onRetry={() => void item.refetch()} />
      </FieldLayout>
    )
  }
  return <ObjectSkeleton id={id} entry={known} />
}

/** «PPV-032 слит с PPV-031», «Удалён 12.09 Дианой»; у живого объекта — `null`. */
function goneMessage(detail: ItemDetail, today: LocalDate): string | null {
  const { lifecycle, entry } = detail
  if (lifecycle.state === 'merged') {
    return `${entry.id} слит с ${lifecycle.into}`
  }
  if (lifecycle.state === 'deleted') {
    return `Удалён ${formatDate(mskDate(lifecycle.at), today)} ${instrumentalName(lifecycle.by)}`
  }
  return null
}

function GoneObject({ detail, message }: { detail: ItemDetail; message: string }) {
  const model = useCurrentModel().code
  const navigate = useNavigate()
  const { lifecycle, entry } = detail
  const action =
    lifecycle.state === 'merged'
      ? {
          label: `Открыть ${lifecycle.into}`,
          onSelect: () =>
            void navigate({ to: '/$model/i/$id', params: { model, id: lifecycle.into } }),
        }
      : {
          label: 'Журнал',
          onSelect: () =>
            void navigate({ to: '/$model/journal', params: { model }, search: { item: entry.id } }),
        }
  return (
    <GoneState
      kind={lifecycle.state === 'merged' ? 'merged' : 'deleted'}
      message={message}
      action={action}
    />
  )
}
