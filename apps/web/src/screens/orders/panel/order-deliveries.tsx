import {
  type ActorRef,
  formatDate,
  mskDate,
  type Order,
  type OrderDelivery,
  pastVerb,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { Thumb } from '@contentops/ui/components/thumb'
import { UiLink } from '@contentops/ui/components/ui-link'
import { useMemo, useState } from 'react'
import { useHref } from '@/app/use-href'
import { useToday } from '@/data/api-session'
import { useCatalogIndex } from '@/data/catalog'
import { itemCoverById } from '@/lib/item-cover'
import { useCurrentModel } from '@/shell/model/model-context'
import { LinkDeliveryPopover } from './link-delivery-popover'
import { ReasonForm } from './reason-form'
import type { OrderActions } from './use-order-actions'

/** Агент в середине фразы — со строчной: «связал: агент заказов». */
function actorName(actor: ActorRef): string {
  return actor.type === 'person' ? actor.name : actor.name.toLowerCase()
}

/**
 * «связал: агент заказов · подтвердила: Диана»; подтверждение агента — «подтверждено
 * агентом» (SPEC §11.1): владелец находит такие решения фильтром «Кто: агенты».
 */
function whoLinked(delivery: OrderDelivery): string {
  const linked = `${pastVerb('связал', delivery.linked_by.gender)}: ${actorName(delivery.linked_by)}`
  if (!delivery.confirmed_by) return linked
  if (delivery.confirmed_by.type === 'agent') return `${linked} · подтверждено агентом`
  const confirmed = pastVerb('подтвердил', delivery.confirmed_by.gender)
  return `${linked} · ${confirmed}: ${actorName(delivery.confirmed_by)}`
}

const PART_WORD = { video: 'видео', photos: 'фото' } as const

const UNLINK_REASONS = ['ошибочная привязка', 'это другой заказ'] as const

interface DeliveryRowProps {
  order: Order
  delivery: OrderDelivery
  actions: OrderActions
  editable: boolean
}

function DeliveryRow({ order, delivery, actions, editable }: DeliveryRowProps) {
  const today = useToday()
  const [unlinking, setUnlinking] = useState(false)
  const retracted = delivery.retracted
  const model = useCurrentModel().code
  const href = useHref()({ to: '/$model/i/$id', params: { model, id: delivery.item_id } })
  const title = useCatalogIndex(model).data?.byId.get(delivery.item_id)?.title
  return (
    <li className={retracted ? 'flex gap-3 opacity-60' : 'flex gap-3'}>
      <Thumb
        {...itemCoverById(delivery.item_id)}
        showCaptions={false}
        className="w-10 shrink-0 self-start rounded-md"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex min-w-0 items-baseline justify-between gap-2">
          <UiLink href={href} className="min-w-0 truncate underline-offset-4 hover:underline">
            <span className="text-ink-3 tabular-nums">{delivery.item_id}</span>
            {title ? ` ${title}` : null}
          </UiLink>
          <span
            className="shrink-0 text-ink-3 text-sm tabular-nums"
            title="Когда файлы появились в источнике"
          >
            {PART_WORD[delivery.part]} · {formatDate(mskDate(delivery.delivered_at), today)}
          </span>
        </p>
        <p className="text-muted-foreground text-sm">{delivery.matched.join(' · ')}</p>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <p className="min-w-0 text-ink-3 text-sm">
            {retracted
              ? `${pastVerb('отвязал', retracted.by.gender)}: ${actorName(retracted.by)}${retracted.reason ? ` · ${retracted.reason}` : ''}`
              : whoLinked(delivery)}
          </p>
          {editable && !retracted && !unlinking ? (
            <Button
              variant="link"
              size="sm"
              onClick={() => setUnlinking(true)}
              className="shrink-0"
            >
              Отвязать…
            </Button>
          ) : null}
        </div>
        {unlinking ? (
          <ReasonForm
            label="Почему отвязываем сдачу"
            choices={UNLINK_REASONS}
            submitLabel="Отвязать"
            pending={actions.unlinking}
            onCancel={() => setUnlinking(false)}
            onSubmit={(reason) => {
              actions.unlink(order, delivery, reason)
              setUnlinking(false)
            }}
          />
        ) : null}
      </div>
    </li>
  )
}

interface OrderDeliveriesProps {
  order: Order
  actions: OrderActions
  editable: boolean
  linkOpen: boolean
  onLinkOpenChange: (open: boolean) => void
}

/**
 * Сдачи (DESIGN §4.16, п. 4): у каждой — что совпало и кто связал; «Отвязать» с возвратом
 * из полоски. Ниже «Привязать сдачу…» — если сдача пришла раньше заказа.
 */
export function OrderDeliveries({
  order,
  actions,
  editable,
  linkOpen,
  onLinkOpenChange,
}: OrderDeliveriesProps) {
  const linked = useMemo(
    () =>
      order.deliveries
        .filter((delivery) => delivery.retracted === null)
        .map((delivery) => delivery.item_id),
    [order.deliveries],
  )
  if (order.deliveries.length === 0 && !editable) return null
  return (
    <InfoSection title="Сдачи">
      {order.deliveries.length > 0 ? (
        <ul className="flex flex-col gap-4">
          {order.deliveries.map((delivery) => (
            <DeliveryRow
              key={delivery.id}
              order={order}
              delivery={delivery}
              actions={actions}
              editable={editable}
            />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">Сдач пока нет</p>
      )}
      {editable ? (
        <div>
          <LinkDeliveryPopover
            linked={linked}
            open={linkOpen}
            onOpenChange={onLinkOpenChange}
            onPick={(item) => actions.link(order, item)}
            pending={actions.linking}
          />
        </div>
      ) : null}
    </InfoSection>
  )
}
