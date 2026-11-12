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
import { useHubOrderList } from '@/data/hub-orders'
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
  return (
    <>
      {detail.hub_order ? <HubOrderDetails summary={detail.hub_order} /> : null}
      {detail.order ? <OrderDetails summary={detail.order} /> : null}
    </>
  )
}

/**
 * Заказ Hub, сдача которого — этот кастом (пакет N): код ссылкой в Hub, что заказано и шаг
 * Hub; карточка заказа с файлами — в «Заказах» ContentOps.
 */
function HubOrderDetails({ summary }: { summary: NonNullable<ItemDetail['hub_order']> }) {
  const { model } = useObjectPage()
  const href = useHref()
  const board = useHubOrderList(model.code).data?.board_url ?? null
  return (
    <InfoSection title="Заказ в Hub">
      <StatusLine
        sign={summary.status.sign ?? undefined}
        detail={summary.status.detail ?? undefined}
      >
        {summary.status.word}
      </StatusLine>
      <p className="flex min-w-0 items-baseline gap-2">
        {board ? (
          <a
            href={`${board}/${summary.code}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-primary-ink tabular-nums hover:underline"
          >
            {summary.code}
            <ExternalLinkIcon className="size-3.5" />
          </a>
        ) : (
          <span className="shrink-0 tabular-nums">{summary.code}</span>
        )}
        <UiLink
          href={href({
            to: '/$model/library/customs/orders/$order',
            params: { model: model.code, order: summary.code },
          })}
          className="min-w-0 truncate text-primary-ink hover:underline"
        >
          {summary.title}
        </UiLink>
      </p>
    </InfoSection>
  )
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
