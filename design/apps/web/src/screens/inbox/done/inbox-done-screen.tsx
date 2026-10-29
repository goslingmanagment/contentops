import { isApiError } from '@contentops/contracts'
import { FilterChipsRow, FilterToggleChip } from '@contentops/ui/components/filter-chips'
import { ListRowSkeleton } from '@contentops/ui/components/skeletons'
import { EmptyState, ErrorLine } from '@contentops/ui/components/state-lines'
import { VirtualList } from '@contentops/ui/components/virtual-list'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useInboxList } from '@/data/inbox'
import { useRole } from '@/data/session'
import { useHistoryScroll } from '@/lib/use-history-state'
import { useObjectDialogs } from '@/objects/dialogs/use-object-dialogs'
import { usePlanDialog } from '@/shell/dialogs/plan-dialog-context'
import { FieldLayout } from '@/shell/field/field-layout'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { useCurrentModel } from '@/shell/model/model-context'
import type { DecidedShow } from '../search'
import { InboxForbidden } from '../shared/inbox-forbidden'
import { InboxHeader } from '../shared/inbox-header'
import { useIntakeActions } from '../shared/use-intake-actions'
import { decidedMenu } from './decided-menu'
import { DecidedRow } from './decided-row'

const routeApi = getRouteApi('/_shell/$model/inbox/done')
const ROW_HEIGHT = 52
const SKELETON_ROWS = [0, 1, 2, 3, 4] as const

const EMPTY_TEXT: Record<DecidedShow, string> = {
  accepted: 'За 14 дней ничего не принято',
  rejected: 'Отклонённого за 30 дней нет',
}

/**
 * Приехало › Решённое `#/<модель>/inbox/done` (DESIGN §4.10): принятое за 14 дней — кто
 * принял: человек, агент, при загрузке или сам; отклонённое за 30 дней — с причиной,
 * сроком и «Вернуть в работу». Отмены принятия нет: номер выдан.
 */
export function InboxDoneScreen() {
  const model = useCurrentModel().code
  const show: DecidedShow = routeApi.useSearch().show ?? 'accepted'
  const navigate = useNavigate({ from: '/$model/inbox/done' })
  const list = useInboxList(model, show)
  const actions = useIntakeActions()
  const scroll = useHistoryScroll(`inbox-done:${show}:scroll`)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const items = list.data?.items ?? []

  const setShow = (next: DecidedShow) =>
    void navigate({
      search: (previous) => ({ ...previous, show: next === 'accepted' ? undefined : next }),
      replace: true,
    })
  const openItem = (id: string) => void navigate({ to: '/$model/i/$id', params: { model, id } })
  const role = useRole()
  const canAct = role === 'owner' || role === 'manager'
  const toast = useActionToast()
  const dialogs = useObjectDialogs()
  const { openPlanDialog } = usePlanDialog()
  const menuHandlers = {
    open: openItem,
    plan: (id: string) => openPlanDialog([id]),
    copy: (id: string) =>
      void navigator.clipboard.writeText(id).then(
        () => toast.show({ message: `Скопировано: ${id}` }),
        (error: unknown) => toast.showFailure(error, { failed: 'Не скопировалось' }),
      ),
    journal: (id: string) =>
      void navigate({ to: '/$model/journal', params: { model }, search: { item: id } }),
    changeType: (id: string) => dialogs.open({ kind: 'change-type', id }),
    remove: (id: string) => dialogs.open({ kind: 'delete', id }),
  }

  if (isApiError(list.error) && list.error.status === 403) {
    return <InboxForbidden />
  }

  return (
    <FieldLayout>
      <InboxHeader active="done" />
      <FilterChipsRow canReset={false} onReset={() => setShow('accepted')} className="mt-2">
        <FilterToggleChip
          label="Принятые"
          pressed={show === 'accepted'}
          onPressedChange={() => setShow('accepted')}
        />
        <FilterToggleChip
          label="Отклонённые"
          pressed={show === 'rejected'}
          onPressedChange={() => setShow('rejected')}
        />
      </FilterChipsRow>
      <RefreshStrip active={list.isFetching && list.data !== undefined} />
      <div className="-mx-7 flex min-h-0 flex-1 flex-col px-7 pt-2 pb-4">
        {list.isPending ? (
          <div aria-hidden className="-mx-2 flex flex-col">
            {SKELETON_ROWS.map((row) => (
              <ListRowSkeleton key={row} height={ROW_HEIGHT} thumb="square" />
            ))}
          </div>
        ) : null}
        {list.isError ? (
          <ErrorLine layout="center" message="Не загрузилось" onRetry={() => void list.refetch()} />
        ) : null}
        {list.data && items.length === 0 ? <EmptyState>{EMPTY_TEXT[show]}</EmptyState> : null}
        {items.length > 0 ? (
          <VirtualList
            key={show}
            items={items}
            getKey={(group) => group.id}
            getItemHeight={() => ROW_HEIGHT}
            selectedKeys={selected}
            onSelectedKeysChange={setSelected}
            onOpen={(group) => {
              if (group.state.kind === 'accepted') {
                openItem(group.state.item_id)
              }
            }}
            label={show === 'accepted' ? 'Принятые' : 'Отклонённые'}
            initialScrollOffset={scroll.initialOffset}
            onScrollOffsetChange={scroll.onScrollOffsetChange}
            className="-mx-2"
            renderItem={(group, state) => (
              <DecidedRow
                group={group}
                selected={state.selected}
                restoring={actions.restoring}
                onRestore={actions.restore}
                menu={
                  group.state.kind === 'accepted'
                    ? decidedMenu(group.state.item_id, group.state.how, canAct, menuHandlers)
                    : null
                }
              />
            )}
          />
        ) : null}
      </div>
      {dialogs.element}
    </FieldLayout>
  )
}
