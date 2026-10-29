import { type DeletedItem, formatDate, type LocalDate, mskDate } from '@contentops/contracts'
import { FieldHeader } from '@contentops/ui/components/field-header'
import { ListRowSkeleton } from '@contentops/ui/components/skeletons'
import { EmptyState, ErrorLine } from '@contentops/ui/components/state-lines'
import { Thumb } from '@contentops/ui/components/thumb'
import { UiLink } from '@contentops/ui/components/ui-link'
import { useHref } from '@/app/use-href'
import { useToday } from '@/data/api-session'
import { useDeletedItems } from '@/data/catalog'
import { itemCoverById } from '@/lib/item-cover'
import { FieldLayout } from '@/shell/field/field-layout'
import { useCurrentModel } from '@/shell/model/model-context'
import { useLibraryHref } from '../shared/library-hrefs'

/** «Удалён 12.09 · Диана», «Слит 20.09 с PPV-031» (DESIGN §3.10). */
function stateText(item: DeletedItem, today: LocalDate): string {
  const day = formatDate(mskDate(item.deleted_at), today)
  return item.merged_into
    ? `Слит ${day} с ${item.merged_into}`
    : `Удалён ${day} · ${item.deleted_by}`
}

function DeletedRow({ item }: { item: DeletedItem }) {
  const today = useToday()
  const model = useCurrentModel().code
  const href = useHref()
  const linkClass = 'shrink-0 text-primary-ink text-sm hover:underline'
  return (
    <li className="flex h-13 items-center gap-3 rounded-lg px-2">
      <Thumb
        {...itemCoverById(item.item_id)}
        aspect="1:1"
        showCaptions={false}
        className="w-10 shrink-0 rounded-md opacity-60"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="truncate text-base">{item.title}</p>
        <p className="text-ink-3 text-sm tabular-nums">{item.item_id}</p>
      </div>
      <p className="w-56 shrink-0 truncate text-muted-foreground text-sm tabular-nums">
        {stateText(item, today)}
      </p>
      <div className="flex w-40 shrink-0 justify-end gap-4">
        {item.merged_into ? (
          <UiLink
            href={href({ to: '/$model/i/$id', params: { model, id: item.merged_into } })}
            className={linkClass}
          >
            Открыть {item.merged_into}
          </UiLink>
        ) : null}
        <UiLink
          href={href({ to: '/$model/journal', params: { model }, search: { item: item.item_id } })}
          className={linkClass}
        >
          Журнал
        </UiLink>
      </div>
    </li>
  )
}

/**
 * «Удалённые объекты» `#/<модель>/library/deleted` (корень › «⋯»): что удалили или слили,
 * кто и когда; у слитого — переход к объекту, куда он влит, у всех — журнал объекта.
 */
export function DeletedItemsScreen() {
  const model = useCurrentModel().code
  const rootHref = useLibraryHref()
  const deleted = useDeletedItems(model)
  const items = deleted.data
  const body = (() => {
    if (deleted.isPending) {
      return (
        <div aria-busy className="flex flex-col pt-3">
          {Array.from({ length: 3 }, (_, row) => (
            <ListRowSkeleton key={row} height={52} thumb="square" />
          ))}
        </div>
      )
    }
    if (!items) {
      return (
        <ErrorLine
          layout="center"
          message="Не загрузилось"
          onRetry={() => void deleted.refetch()}
        />
      )
    }
    if (items.length === 0) {
      return <EmptyState>Удалённых объектов нет</EmptyState>
    }
    return (
      <ul className="-mx-2 flex flex-col pt-3">
        {items.map((item) => (
          <DeletedRow key={item.item_id} item={item} />
        ))}
      </ul>
    )
  })()
  return (
    <FieldLayout>
      <FieldHeader
        crumbs={[{ label: 'Библиотека', href: rootHref }]}
        title="Удалённые объекты"
        count={items?.length}
      />
      {body}
    </FieldLayout>
  )
}
