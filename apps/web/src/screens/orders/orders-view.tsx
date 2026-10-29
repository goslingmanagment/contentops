import { formatNumber, orderGroupLabel } from '@contentops/contracts'
import { FieldHeader, HeaderAction } from '@contentops/ui/components/field-header'
import { FilterChipsRow, FilterToggleChip } from '@contentops/ui/components/filter-chips'
import { IntegrationLine } from '@contentops/ui/components/integration-line'
import { EmptyState } from '@contentops/ui/components/state-lines'
import { useNavigate } from '@tanstack/react-router'
import { PlusIcon } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { type OrderTab, useOrderList } from '@/data/orders'
import { useRole } from '@/data/session'
import { useKeyboardShortcut } from '@/lib/use-keyboard-shortcut'
import { useMediaQuery } from '@/lib/use-media-query'
import { CustomsViewSwitch } from '@/screens/library/shared/customs-view-switch'
import { useNewOrderDialog } from '@/shell/dialogs/order-dialog-context'
import { FieldLayout } from '@/shell/field/field-layout'
import { QueryErrorLine } from '@/shell/field/query-error-line'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { useCurrentModel } from '@/shell/model/model-context'
import { useCustomsCount, useCustomsCrumbs } from './customs-crumbs'
import { OrderList } from './order-list'
import { type OrderPanelIntent, orderMenu } from './order-menu'
import { closedOrderRows, type OrderListRow, openOrderRows } from './order-rows'
import { OrdersSkeleton } from './orders-skeleton'
import { OrderPanel } from './panel/order-panel'
import { useOrderActions } from './panel/use-order-actions'

interface OrdersViewProps {
  tab: OrderTab
  /** Заказ в панели; `null` — панель закрыта. */
  selectedId: string | null
  onSelect: (id: string) => void
  onClosePanel: () => void
  onTabChange: (tab: OrderTab) => void
  /** Текущее место прокрутки — адрес заказа уносит его с собой. */
  onScrolled?: (offset: number) => void
}

/** Якорь строки Telegram в «Интеграциях» (screens/settings/integrations). */
const TELEGRAM_ROW = 'telegram'

interface PendingIntent {
  order: string
  kind: OrderPanelIntent
}

/**
 * Кастомы › Заказы (DESIGN §4.16): группы «Просрочено», «Правка», «Ждём от Лоры», «Сдано
 * частично», «Сдано — можно закрыть», строки 64 и панель заказа 400. Один вид на оба
 * адреса: `?view=orders` и `…/customs/orders/<id>`.
 */
export function OrdersView({
  tab,
  selectedId,
  onSelect,
  onClosePanel,
  onTabChange,
  onScrolled,
}: OrdersViewProps) {
  const model = useCurrentModel()
  const role = useRole()
  const editable = role === 'owner' || role === 'manager'
  const navigate = useNavigate()
  const { openNewOrderDialog } = useNewOrderDialog()
  const list = useOrderList(model.code, tab)
  const actions = useOrderActions()
  const narrow = useMediaQuery('(max-width: 1319px)')
  const [intent, setIntent] = useState<PendingIntent | null>(null)
  const crumbs = useCustomsCrumbs()
  const customsCount = useCustomsCount()

  const data = list.data
  const rows = useMemo<OrderListRow[]>(() => {
    if (!data) return []
    return tab === 'open' ? openOrderRows(data.items) : closedOrderRows(data.items)
  }, [data, tab])

  useKeyboardShortcut({ code: 'Escape', enabled: selectedId !== null }, onClosePanel)
  const onIntentHandled = useCallback(() => setIntent(null), [])

  const groupLabel = (row: Extract<OrderListRow, { kind: 'group' }>) =>
    orderGroupLabel(row.state, model.name_genitive)
  const menuFor = (row: Extract<OrderListRow, { kind: 'order' }>) =>
    orderMenu(row.order, {
      editable,
      open: () => onSelect(row.key),
      intent: (kind) => {
        setIntent({ order: row.key, kind })
        onSelect(row.key)
      },
      close: () => actions.close(row.order),
    })

  const newOrder = editable ? (
    <HeaderAction icon={<PlusIcon />} label="Новый заказ" onClick={() => openNewOrderDialog()} />
  ) : null

  return (
    <FieldLayout
      aside={
        selectedId ? (
          <OrderPanel
            orderId={selectedId}
            accounts={model.accounts}
            width={narrow ? 'narrow' : 'wide'}
            intent={intent?.order === selectedId ? intent.kind : null}
            onIntentHandled={onIntentHandled}
            onClose={onClosePanel}
          />
        ) : null
      }
    >
      <FieldHeader
        crumbs={crumbs}
        title="Кастомы"
        count={customsCount}
        nav={<CustomsViewSwitch value="orders" />}
        actions={newOrder}
      />
      <FilterChipsRow
        canReset={false}
        onReset={() => onTabChange('open')}
        trailing={
          data?.agent_silence ? (
            <IntegrationLine
              state="down"
              action={{
                label: 'Подробнее',
                // Строка Telegram в «Интеграциях» пишет, когда агент заказов писал, из той же
                // записи интеграции, по которой сервер считает молчание.
                onSelect: () =>
                  void navigate({
                    to: '/settings/$tab',
                    params: { tab: 'integrations' },
                    hash: TELEGRAM_ROW,
                  }),
              }}
            >
              {data.agent_silence}
            </IntegrationLine>
          ) : null
        }
      >
        <FilterToggleChip
          label={data ? `Открытые · ${formatNumber(data.open_count)}` : 'Открытые'}
          pressed={tab === 'open'}
          onPressedChange={() => onTabChange('open')}
        />
        <FilterToggleChip
          label="Закрытые"
          pressed={tab === 'closed'}
          onPressedChange={() => onTabChange('closed')}
        />
      </FilterChipsRow>
      <RefreshStrip active={list.isFetching && data !== undefined} />
      <div className="-mx-7 flex min-h-0 flex-1 flex-col px-7 pt-2">
        <QueryErrorLine query={list} hasData={data !== undefined} />
        {list.isPending ? <OrdersSkeleton /> : null}
        {data && rows.length === 0 ? (
          <EmptyState
            action={
              editable && tab === 'open'
                ? { label: 'Новый заказ', onSelect: () => openNewOrderDialog() }
                : undefined
            }
          >
            {tab === 'open' ? 'Открытых заказов нет' : 'Закрытых заказов нет'}
          </EmptyState>
        ) : null}
        {rows.length > 0 ? (
          <OrderList
            key={tab}
            rows={rows}
            accounts={model.accounts}
            groupLabel={groupLabel}
            selectedId={selectedId}
            onSelect={onSelect}
            menuFor={menuFor}
            scrollKey={`orders:scroll:${tab}`}
            onScrolled={onScrolled}
          />
        ) : null}
      </div>
    </FieldLayout>
  )
}
