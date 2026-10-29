import { formatNumber, type ItemId, mskDate } from '@contentops/contracts'
import { FieldHeader } from '@contentops/ui/components/field-header'
import type { ItemMenuModel, MenuAction } from '@contentops/ui/components/item-menu'
import { EmptyState } from '@contentops/ui/components/state-lines'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'
import { useHref } from '@/app/use-href'
import { useClock } from '@/data/api-session'
import { useCatalogIndex } from '@/data/catalog'
import { useRole } from '@/data/session'
import { CustomsViewSwitch } from '@/screens/library/shared/customs-view-switch'
import { useMakePpvDialog } from '@/shell/dialogs/make-ppv-dialog-context'
import { FieldLayout } from '@/shell/field/field-layout'
import { QueryErrorLine } from '@/shell/field/query-error-line'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { useCurrentModel } from '@/shell/model/model-context'
import { useCustomsCount, useCustomsCrumbs } from '../customs-crumbs'
import { ToPpvChips } from './to-ppv-chips'
import { ToPpvList } from './to-ppv-list'
import { type ToPpvFilters, type ToPpvRow, toPpvList } from './to-ppv-rows'
import { ToPpvSkeleton } from './to-ppv-skeleton'

const routeApi = getRouteApi('/_shell/$model/library/customs')

type CustomRow = Extract<ToPpvRow, { kind: 'custom' }>

/**
 * Кастомы › Переделка в PPV `?view=to-ppv` (DESIGN §4.2): «Сделано 38 из 197», какие
 * кастомы ещё не стали PPV и есть ли в них имя фана. Та самая табличка, которую владелец
 * просил 29.08; считается в браузере по индексу каталога.
 */
export function ToPpvScreen() {
  const model = useCurrentModel()
  const role = useRole()
  const editable = role === 'owner' || role === 'manager'
  const search = routeApi.useSearch()
  const navigate = useNavigate({ from: '/$model/library/customs' })
  const href = useHref()
  const clock = useClock()
  const crumbs = useCustomsCrumbs()
  const customsCount = useCustomsCount()
  const { openMakePpvDialog } = useMakePpvDialog()
  const index = useCatalogIndex(model.code)

  const { todo = false, name, delivered } = search
  const filters: ToPpvFilters = { todo, name, delivered }
  const today = mskDate(clock.now())
  const items = index.data?.items
  const list = useMemo(
    () => (items ? toPpvList(items, { todo, name, delivered }, today) : null),
    [items, todo, name, delivered, today],
  )

  const changeFilters = (next: ToPpvFilters) =>
    void navigate({
      search: (previous) => ({
        ...previous,
        todo: next.todo || undefined,
        name: next.name,
        delivered: next.delivered,
      }),
      replace: true,
    })
  const resetFilters = () => changeFilters({ todo: false, name: undefined, delivered: undefined })
  const openItem = (id: ItemId) =>
    void navigate({ to: '/$model/i/$id', params: { model: model.code, id } })
  const ppvHref = (id: ItemId) => href({ to: '/$model/i/$id', params: { model: model.code, id } })

  const menuFor = (row: CustomRow): ItemMenuModel => {
    const { entry } = row
    const actions: MenuAction[] = [
      { id: 'open', label: 'Открыть', onSelect: () => openItem(entry.id) },
    ]
    const made = entry.ppv_made_as
    if (made) {
      actions.push({ id: 'ppv', label: `Открыть ${made}`, onSelect: () => openItem(made) })
    } else if (editable) {
      actions.push({
        id: 'make',
        label: 'Сделать PPV',
        onSelect: () => openMakePpvDialog(entry.id),
      })
    }
    return { actions }
  }

  const filtered = todo || name !== undefined || delivered !== undefined
  const hasData = index.data !== undefined

  return (
    <FieldLayout>
      <FieldHeader
        crumbs={crumbs}
        title="Кастомы"
        count={customsCount}
        note={
          list && list.total > 0 ? (
            <span className="min-w-0 truncate text-ink-3 text-sm tabular-nums">
              Сделано {formatNumber(list.done)} из {formatNumber(list.total)}
            </span>
          ) : null
        }
        nav={<CustomsViewSwitch value="to-ppv" />}
      />
      <ToPpvChips filters={filters} onChange={changeFilters} />
      <RefreshStrip active={index.isFetching && hasData} />
      <div className="-mx-7 flex min-h-0 flex-1 flex-col px-7 pt-2">
        <QueryErrorLine query={index} hasData={hasData} shownAt={index.data?.generatedAt} />
        {index.isPending ? <ToPpvSkeleton /> : null}
        {list && list.total === 0 ? (
          <EmptyState>Кастомов пока нет — всё новое приходит в Приехало</EmptyState>
        ) : null}
        {list && list.total > 0 && list.shown === 0 ? (
          <EmptyState action={filtered ? { label: 'Сбросить', onSelect: resetFilters } : undefined}>
            {filtered ? 'По этим фильтрам ничего' : 'Все кастомы уже в PPV'}
          </EmptyState>
        ) : null}
        {list && list.rows.length > 0 ? (
          <ToPpvList
            rows={list.rows}
            ppvHref={ppvHref}
            onOpen={openItem}
            onMakePpv={editable ? openMakePpvDialog : null}
            menuFor={menuFor}
          />
        ) : null}
      </div>
    </FieldLayout>
  )
}
