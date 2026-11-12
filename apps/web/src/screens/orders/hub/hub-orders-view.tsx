import { formatNumber, type HubOrder } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { FieldHeader, HeaderAction } from '@contentops/ui/components/field-header'
import { IntegrationLine } from '@contentops/ui/components/integration-line'
import { EmptyState } from '@contentops/ui/components/state-lines'
import { UiLink } from '@contentops/ui/components/ui-link'
import { ExternalLinkIcon, PlusIcon, RefreshCwIcon } from 'lucide-react'
import { useMemo } from 'react'
import { useHref } from '@/app/use-href'
import { useClock } from '@/data/api-session'
import { useHubOrderList } from '@/data/hub-orders'
import { useRole } from '@/data/session'
import { useKeyboardShortcut } from '@/lib/use-keyboard-shortcut'
import { useMediaQuery } from '@/lib/use-media-query'
import { CustomsViewSwitch } from '@/screens/library/shared/customs-view-switch'
import { FieldLayout } from '@/shell/field/field-layout'
import { QueryErrorLine } from '@/shell/field/query-error-line'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { useCurrentModel } from '@/shell/model/model-context'
import { useCustomsCount, useCustomsCrumbs } from '../customs-crumbs'
import { OrdersSkeleton } from '../orders-skeleton'
import { HubOrderPanel } from './hub-order-panel'
import { HubOrderRow } from './hub-order-row'
import {
  HUB_GROUP_ORDER,
  type HubOrderGroup,
  hubGroupLabel,
  hubGroupOf,
  readLine,
} from './hub-order-text'
import { useHubOrderActions } from './use-hub-order-actions'

interface HubOrdersViewProps {
  /** Заказ в панели; `null` — панель закрыта. */
  selectedCode: string | null
  onSelect: (code: string) => void
  onClosePanel: () => void
}

/**
 * Кастомы › Заказы с 12.11.2026 (пакет N): дом заказа — Hub. Здесь заказы Hub в
 * производстве — у модели, сдано частично, правка, снято и не отдано, — по коду Hub, с
 * файлами, что держит ContentOps. Новый заказ заводят на доске Hub; заказы ContentOps до
 * Hub — в «Архиве заказов». Hub недоступен — экран показывает последнее чтение и время.
 */
export function HubOrdersView({ selectedCode, onSelect, onClosePanel }: HubOrdersViewProps) {
  const model = useCurrentModel()
  const role = useRole()
  const editable = role === 'owner' || role === 'manager'
  const list = useHubOrderList(model.code)
  const actions = useHubOrderActions()
  const narrow = useMediaQuery('(max-width: 1319px)')
  const crumbs = useCustomsCrumbs()
  const customsCount = useCustomsCount()
  const now = useClock().now()
  const href = useHref()
  useKeyboardShortcut({ code: 'Escape', enabled: selectedCode !== null }, onClosePanel)

  const data = list.data
  const groups = useMemo(() => {
    const byGroup = new Map<HubOrderGroup, HubOrder[]>()
    for (const order of data?.items ?? []) {
      const group = hubGroupOf(order)
      byGroup.set(group, [...(byGroup.get(group) ?? []), order])
    }
    return HUB_GROUP_ORDER.flatMap((group) => {
      const orders = byGroup.get(group)
      return orders ? [{ group, orders }] : []
    })
  }, [data])
  const line = data ? readLine(data, now) : null
  const archiveHref = href({
    to: '/$model/library/customs',
    params: { model: model.code },
    search: { view: 'archive' },
  })

  const headerActions = (
    <>
      {editable ? (
        <HeaderAction
          icon={<RefreshCwIcon />}
          label="Обновить"
          pending={actions.refreshing}
          onClick={() => actions.refresh()}
        />
      ) : null}
      {data?.board_url ? (
        <Button variant="secondary" asChild>
          <a href={data.board_url} target="_blank" rel="noreferrer">
            <PlusIcon />
            Новый заказ в Hub
            <ExternalLinkIcon aria-hidden />
          </a>
        </Button>
      ) : null}
    </>
  )

  return (
    <FieldLayout
      aside={
        selectedCode ? (
          <HubOrderPanel
            code={selectedCode}
            accounts={model.accounts}
            width={narrow ? 'narrow' : 'wide'}
            actions={actions}
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
        actions={headerActions}
      />
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-6 gap-y-1 pb-1">
        {line ? <IntegrationLine state={line.state}>{line.text}</IntegrationLine> : <span />}
        <UiLink
          href={archiveHref}
          className="shrink-0 text-ink-3 text-sm underline-offset-4 hover:underline"
        >
          Архив заказов ContentOps
        </UiLink>
      </div>
      <RefreshStrip active={list.isFetching && data !== undefined} />
      <div className="@container -mx-7 flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pt-2 pb-8">
        <QueryErrorLine query={list} hasData={data !== undefined} />
        {list.isPending ? <OrdersSkeleton /> : null}
        {data && groups.length === 0 ? (
          <EmptyState>
            {data.read_at
              ? 'Заказов в производстве нет: новые появятся, когда Hub отметит «у модели»'
              : 'Hub ещё не прочитан'}
          </EmptyState>
        ) : null}
        {groups.map(({ group, orders }) => (
          <section key={group} aria-label={hubGroupLabel(group, model.name_genitive)}>
            <div className="flex h-11 items-end px-2 pb-2">
              <h2 className="flex items-baseline gap-2 text-lg">
                {hubGroupLabel(group, model.name_genitive)}
                <span className="font-normal text-ink-3 text-sm tabular-nums">
                  {formatNumber(orders.length)}
                </span>
              </h2>
            </div>
            <ul className="-mx-2 flex flex-col">
              {orders.map((order) => (
                <li key={order.code}>
                  <HubOrderRow
                    order={order}
                    accounts={model.accounts}
                    selected={order.code === selectedCode}
                    onOpen={() => onSelect(order.code)}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </FieldLayout>
  )
}
