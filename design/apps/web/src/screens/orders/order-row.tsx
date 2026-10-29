import type { Account, Order } from '@contentops/contracts'
import { StatusWord } from '@contentops/ui/components/status-word'
import { StopRowClick } from '@contentops/ui/components/stop-row-click'
import { Thumb } from '@contentops/ui/components/thumb'
import { WhyPopover } from '@contentops/ui/components/why-popover'
import { cn } from '@contentops/ui/lib/utils'
import { ExternalLinkIcon } from 'lucide-react'
import { useToday } from '@/data/api-session'
import { itemCoverById } from '@/lib/item-cover'
import {
  deadlineText,
  orderMeta,
  orderTitle,
  orderWhyFacts,
  placeholderCaption,
  rowStatus,
} from './order-text'

interface OrderRowProps {
  order: Order
  accounts: readonly Account[]
  selected: boolean
  /** «Открыть заказ» из «почему»: то же, что выбор строки. */
  onOpen: () => void
}

/** Сдача, если она есть: миниатюра первой сданной части. */
function deliveredItem(order: Order) {
  return order.parts.find((part) => part.item_id !== null)?.item_id ?? null
}

/** Миниатюра сдачи 40 × 53 или пунктирная рамка с заказанной длительностью (§4.16). */
function OrderThumb({ order }: { order: Order }) {
  const item = deliveredItem(order)
  if (item) {
    return (
      <Thumb {...itemCoverById(item)} showCaptions={false} className="w-10 shrink-0 rounded-md" />
    )
  }
  return (
    <span className="flex aspect-[3/4] w-10 shrink-0 items-center justify-center rounded-md border border-input border-dashed px-0.5 text-center text-2xs text-ink-3">
      {placeholderCaption(order)}
    </span>
  )
}

/**
 * Строка заказа 64 (DESIGN §4.16): сдача или рамка, название, покупатель и страница,
 * срок, состояние словом («почему» — по нажатию на слово) и «Карточка в Telegram ↗».
 * При узком поле (открыта панель)
 * ссылка уходит в панель, строка не переносится.
 */
export function OrderRow({ order, accounts, selected, onOpen }: OrderRowProps) {
  const today = useToday()
  const status = rowStatus(order, today)
  const word = (
    <StatusWord sign={status.sign ?? undefined} detail={status.detail} className="max-w-full">
      {status.word}
    </StatusWord>
  )
  return (
    <div
      data-selected={selected}
      className={cn(
        'flex h-16 min-w-0 items-center gap-3 rounded-lg px-2 transition-colors duration-120 hover:bg-accent',
        selected && 'bg-primary-tint hover:bg-primary-tint',
      )}
    >
      <OrderThumb order={order} />
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="truncate text-base">{orderTitle(order)}</p>
        <p className="truncate text-muted-foreground text-sm tabular-nums">
          {orderMeta(order, accounts)}
        </p>
      </div>
      <span className="w-16 shrink-0 text-muted-foreground text-sm tabular-nums">
        {deadlineText(order, today)}
      </span>
      <span className="flex w-44 shrink-0 @3xl:w-64 @4xl:w-80">
        <StopRowClick>
          <WhyPopover
            title={word}
            tone={status.sign ?? undefined}
            facts={orderWhyFacts(order, today)}
            action={selected ? undefined : { label: 'Открыть заказ', onSelect: onOpen }}
            className="max-w-full"
          >
            {word}
          </WhyPopover>
        </StopRowClick>
      </span>
      {order.card.url ? <CardLink url={order.card.url} /> : null}
    </div>
  )
}

/** «Карточка в Telegram ↗» — в строке, пока поле широкое; при открытой панели она в панели. */
function CardLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      className="hidden shrink-0 items-center gap-1.5 rounded-sm text-primary-ink text-sm underline-offset-4 hover:underline @4xl:inline-flex"
    >
      Карточка в Telegram
      <ExternalLinkIcon aria-hidden className="size-3.5" />
    </a>
  )
}
