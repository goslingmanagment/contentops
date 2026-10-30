import { type DeletedItem, formatDate, type LocalDate, mskDate } from '@contentops/contracts'
import { FieldHeader } from '@contentops/ui/components/field-header'
import { ListRowSkeleton } from '@contentops/ui/components/skeletons'
import { EmptyState, ErrorLine } from '@contentops/ui/components/state-lines'
import { Thumb } from '@contentops/ui/components/thumb'
import { UiLink } from '@contentops/ui/components/ui-link'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useHref } from '@/app/use-href'
import { useApi, useToday } from '@/data/api-session'
import { useDeletedItems } from '@/data/catalog'
import { queryKeys } from '@/data/query-keys'
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

/** «Вернуть»: удалённый (не слитый) объект возвращается с тем же номером (SPEC §4.1). */
function useRestore() {
  const api = useApi()
  const toast = useActionToast()
  const model = useCurrentModel().code
  return useIntentMutation<DeletedItem, unknown>({
    failed: 'Не вернулось',
    run: (item, idempotencyKey) =>
      api.objects.restore({ params: { model, id: item.item_id }, idempotencyKey }),
    invalidates: (item) => [
      queryKeys.deleted(model),
      queryKeys.catalogIndex(model),
      queryKeys.item(model, item.item_id),
    ],
    onSuccess: (_, item) => toast.show({ message: `${item.item_id} вернулся в библиотеку` }),
  })
}

function DeletedRow({ item }: { item: DeletedItem }) {
  const today = useToday()
  const model = useCurrentModel().code
  const href = useHref()
  const restore = useRestore()
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
        ) : (
          <button
            type="button"
            className={linkClass}
            disabled={restore.isPending}
            onClick={() => restore.start(item)}
          >
            Вернуть
          </button>
        )}
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
 * «Удалённые объекты» `/<модель>/library/deleted` (корень › «⋯»): что удалили или слили,
 * кто и когда; у слитого — переход к объекту, куда он влит, у удалённого — «Вернуть», у всех —
 * журнал объекта.
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
