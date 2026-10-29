import { formatWhen, type Order } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { cn } from '@contentops/ui/lib/utils'
import { ExternalLinkIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { useClock } from '@/data/api-session'

const COLLAPSED_LINES = 3

/**
 * Карточка заказа из Telegram (DESIGN §4.16, п. 1): «Карточка в Telegram ↗», автор и
 * дата, текст свёрнутым блоком с эмодзи-заголовками, как в Telegram. Telegram-клиента в
 * продукте нет — текст хранится таким, каким его вставили или прочёл агент.
 */
export function OrderCardBlock({ order }: { order: Order }) {
  const now = useClock().now()
  const [open, setOpen] = useState(false)
  const textId = useId()
  const text = order.card.text
  const lines = text?.split('\n').length ?? 0
  return (
    <InfoSection
      title="Карточка"
      aside={
        <span className="text-ink-3 tabular-nums">
          {order.card.author} · {formatWhen(order.card.posted_at, now)}
        </span>
      }
    >
      {text ? (
        <div className="flex flex-col items-start gap-1.5">
          <div className="w-full rounded-xl bg-accent px-3 py-2.5 text-sm">
            <p id={textId} className={cn('whitespace-pre-line', !open && 'line-clamp-3')}>
              {text}
            </p>
          </div>
          {lines > COLLAPSED_LINES ? (
            <Button
              variant="link"
              size="sm"
              aria-expanded={open}
              aria-controls={textId}
              onClick={() => setOpen((current) => !current)}
            >
              {open ? 'Свернуть' : 'Показать всю карточку'}
            </Button>
          ) : null}
        </div>
      ) : null}
      {order.card.url ? (
        <a
          href={order.card.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit items-center gap-1.5 rounded-sm text-primary-ink text-sm underline-offset-4 hover:underline"
        >
          Карточка в Telegram
          <ExternalLinkIcon aria-hidden className="size-3.5" />
        </a>
      ) : null}
    </InfoSection>
  )
}
