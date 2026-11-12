import {
  formatDate,
  type HubOrder,
  type InboxGroup,
  type OrderCandidate,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { StatusWord } from '@contentops/ui/components/status-word'
import { ExternalLinkIcon } from 'lucide-react'
import { useToday } from '@/data/api-session'
import { useHubOrderList } from '@/data/hub-orders'
import { useNewOrderDialog } from '@/shell/dialogs/order-dialog-context'
import { useCurrentModel } from '@/shell/model/model-context'

interface OrderCandidatesProps {
  group: InboxGroup
  pending: boolean
  onChoose: (orderId: string | null) => void
}

/**
 * ◆ «Какой заказ?» (DESIGN §4.8): без предвыбора. Сверху — заказы Hub в производстве (пакет N:
 * дом заказа — Hub, «Принять как сдачу» уходит туда), ниже под «Архив» — заказы ContentOps до
 * Hub, которые нашло правило, с выдержкой ТЗ и тем, что совпало. Ниже «Без заказа» и новый заказ
 * — на доске Hub (без Hub — «Завести заказ из карточки…»).
 */
export function OrderCandidates({ group, pending, onChoose }: OrderCandidatesProps) {
  const { openNewOrderDialog } = useNewOrderDialog()
  const hub = useHubOrderList(useCurrentModel().code).data
  const board = hub?.board_url ?? null
  const hubOrders = hub?.items ?? []
  return (
    <div className="flex flex-col gap-2">
      {hubOrders.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="Заказы Hub">
          {hubOrders.map((order) => (
            <li key={order.code}>
              <HubOrderCard order={order} pending={pending} onChoose={() => onChoose(order.code)} />
            </li>
          ))}
        </ul>
      ) : null}
      {hubOrders.length > 0 && group.candidates.length > 0 ? (
        <h4 className="pt-2 text-ink-3 text-sm">Архив</h4>
      ) : null}
      <ul className="flex flex-col gap-2" aria-label="Архив">
        {group.candidates.map((candidate) => (
          <li key={candidate.order_id}>
            <CandidateCard
              candidate={candidate}
              pending={pending}
              onChoose={() => onChoose(candidate.order_id)}
            />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
        <Button variant="link" size="inline" disabled={pending} onClick={() => onChoose(null)}>
          Без заказа
        </Button>
        {board ? (
          <Button variant="link" size="inline" asChild>
            <a href={board} target="_blank" rel="noreferrer">
              Новый заказ — на доске Hub
              <ExternalLinkIcon aria-hidden />
            </a>
          </Button>
        ) : (
          <Button
            variant="link"
            size="inline"
            onClick={() => openNewOrderDialog({ inboxGroupId: group.id })}
          >
            Завести заказ из карточки…
          </Button>
        )}
      </div>
    </div>
  )
}

/** Заказ Hub карточкой: код, что заказано, срок и шаг Hub. */
function HubOrderCard({
  order,
  pending,
  onChoose,
}: {
  order: HubOrder
  pending: boolean
  onChoose: () => void
}) {
  const today = useToday()
  return (
    <article className="flex flex-col gap-2 rounded-xl border border-border p-3">
      <header className="flex items-baseline justify-between gap-3">
        <h4 className="min-w-0 truncate font-semibold text-base">
          <span className="font-normal text-ink-3 tabular-nums">{order.code}</span> «{order.title}»
        </h4>
        {order.deadline ? (
          <span className="shrink-0 whitespace-nowrap text-ink-3 text-sm tabular-nums">
            до {formatDate(order.deadline, today)}
          </span>
        ) : null}
      </header>
      <StatusWord sign={order.status.sign ?? undefined} detail={order.status.detail}>
        {order.status.word}
      </StatusWord>
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={onChoose}
        className="self-start"
      >
        Этот заказ
      </Button>
    </article>
  )
}

function CandidateCard({
  candidate,
  pending,
  onChoose,
}: {
  candidate: OrderCandidate
  pending: boolean
  onChoose: () => void
}) {
  const today = useToday()
  return (
    <article className="flex flex-col gap-2 rounded-xl border border-border p-3">
      <header className="flex items-baseline justify-between gap-3">
        <h4 className="min-w-0 truncate font-semibold text-base">«{candidate.title}»</h4>
        {candidate.deadline ? (
          <span className="shrink-0 text-ink-3 text-sm tabular-nums">
            до {formatDate(candidate.deadline, today)}
          </span>
        ) : null}
      </header>
      <p className="line-clamp-2 text-muted-foreground text-sm">{candidate.excerpt}</p>
      <p className="text-sm">{candidate.matched.join(' · ')}</p>
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={onChoose}
        className="self-start"
      >
        Этот заказ
      </Button>
    </article>
  )
}
