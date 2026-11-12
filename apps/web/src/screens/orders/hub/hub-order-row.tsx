import type { Account, HubOrder, ItemId } from '@contentops/contracts'
import { StatusWord } from '@contentops/ui/components/status-word'
import { Thumb } from '@contentops/ui/components/thumb'
import { cn } from '@contentops/ui/lib/utils'
import { useToday } from '@/data/api-session'
import { useItemCover } from '@/objects/use-item-cover'
import { hubDeadlineText, hubOrderMeta } from './hub-order-text'

interface HubOrderRowProps {
  order: HubOrder
  accounts: readonly Account[]
  selected: boolean
  onOpen: () => void
}

function firstFile(order: HubOrder): ItemId | null {
  return order.files.find((file) => file.retracted === null)?.item_id ?? null
}

/** Миниатюра первого файла или пунктирная рамка с длительностью из карточки. */
function HubOrderThumb({ order }: { order: HubOrder }) {
  const item = firstFile(order)
  if (item) return <FileThumb item={item} />
  return (
    <span className="flex aspect-[3/4] w-10 shrink-0 items-center justify-center rounded-md border border-input border-dashed px-0.5 text-center text-2xs text-ink-3">
      {order.duration ?? (order.wants_video ? 'видео' : 'фото')}
    </span>
  )
}

function FileThumb({ item }: { item: ItemId }) {
  const cover = useItemCover(item)
  return <Thumb {...cover} showCaptions={false} className="w-10 shrink-0 rounded-md" />
}

/**
 * Строка заказа Hub 64: файл или рамка, что заказано, код, покупатель и страница, срок,
 * состояние Hub словом и сколько файлов держит ContentOps.
 */
export function HubOrderRow({ order, accounts, selected, onOpen }: HubOrderRowProps) {
  const today = useToday()
  const live = order.files.filter((file) => file.retracted === null).length
  return (
    <button
      type="button"
      data-selected={selected}
      onClick={onOpen}
      className={cn(
        'flex h-16 w-full min-w-0 items-center gap-3 rounded-lg px-2 text-left transition-colors duration-120 hover:bg-accent',
        selected && 'bg-primary-tint hover:bg-primary-tint',
      )}
    >
      <HubOrderThumb order={order} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-base">Кастом «{order.title}»</span>
        <span className="truncate text-muted-foreground text-sm tabular-nums">
          {hubOrderMeta(order, accounts)}
        </span>
      </span>
      <span className="min-w-20 shrink-0 whitespace-nowrap text-muted-foreground text-sm tabular-nums">
        {hubDeadlineText(order, today)}
      </span>
      <span className="hidden w-20 shrink-0 text-muted-foreground text-sm tabular-nums @3xl:inline">
        {live > 0 ? `файлов ${live}` : 'файлов нет'}
      </span>
      <span className="flex w-44 shrink-0 @3xl:w-64 @4xl:w-80">
        <StatusWord
          sign={order.status.sign ?? undefined}
          detail={order.status.detail}
          className="max-w-full"
        >
          {order.status.word}
        </StatusWord>
      </span>
    </button>
  )
}
