import {
  formatDate,
  formatDuration,
  formatNumber,
  type ItemDetail,
  type Order,
} from '@contentops/contracts'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { UiLink } from '@contentops/ui/components/ui-link'
import { ExternalLinkIcon } from 'lucide-react'
import { useHref } from '@/app/use-href'
import { useToday } from '@/data/api-session'
import { useOrder } from '@/data/orders'
import { StatusLine } from '@/objects/status-line'
import { useObjectPage } from '../object-context'

function partText(part: Order['parts'][number]): string {
  if (part.kind === 'video') {
    const length = part.duration_s ? ` ${formatDuration(part.duration_s)}` : ''
    return part.delivered > 0 ? `видео${length} · есть` : 'видео · ждём'
  }
  return `фото ${formatNumber(part.delivered)} из ${formatNumber(part.required ?? 0)}`
}

/**
 * Заказ кастома (DESIGN §4.5): «Карточка в Telegram ↗», покупатель, ТЗ в две строки,
 * срок, состояние заказа и части. Открыть заказ целиком — ссылкой на него.
 */
export function OrderSection() {
  const { detail } = useObjectPage()
  return detail.order ? <OrderDetails summary={detail.order} /> : null
}

function OrderDetails({ summary }: { summary: NonNullable<ItemDetail['order']> }) {
  const today = useToday()
  const { model } = useObjectPage()
  const href = useHref()
  const order = useOrder(model.code, summary.id).data
  return (
    <InfoSection title="Заказ">
      <StatusLine
        sign={summary.status.sign ?? undefined}
        detail={summary.status.detail ?? undefined}
      >
        {summary.status.word}
      </StatusLine>
      <UiLink
        href={href({
          to: '/$model/library/customs/orders/$order',
          params: { model: model.code, order: summary.id },
        })}
        className="text-primary-ink hover:underline"
      >
        {summary.title}
      </UiLink>
      {order ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {order.buyer ? (
            <>
              <dt className="text-ink-3">Покупатель</dt>
              <dd>{order.buyer}</dd>
            </>
          ) : null}
          {order.brief ? (
            <>
              <dt className="text-ink-3">ТЗ</dt>
              <dd className="line-clamp-2">{order.brief}</dd>
            </>
          ) : null}
          {order.deadline ? (
            <>
              <dt className="text-ink-3">Срок</dt>
              <dd className="tabular-nums">до {formatDate(order.deadline, today)}</dd>
            </>
          ) : null}
          <dt className="text-ink-3">Части</dt>
          <dd>{order.parts.map(partText).join(' · ')}</dd>
        </dl>
      ) : null}
      {order?.card.url ? (
        <a
          href={order.card.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 self-start text-primary-ink text-sm hover:underline"
        >
          Карточка в Telegram
          <ExternalLinkIcon className="size-3.5" />
        </a>
      ) : null}
    </InfoSection>
  )
}
