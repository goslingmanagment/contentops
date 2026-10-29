import { formatDate, type InboxGroup, type OrderCandidate } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { useToday } from '@/data/api-session'
import { useNewOrderDialog } from '@/shell/dialogs/order-dialog-context'

interface OrderCandidatesProps {
  group: InboxGroup
  pending: boolean
  onChoose: (orderId: string | null) => void
}

/**
 * ◆ «Какой заказ?» (DESIGN §4.8): кандидаты карточками друг под другом, без предвыбора.
 * У каждого — срок, выдержка ТЗ и что совпало словами. Ниже «Без заказа» и «Завести
 * заказ из карточки…» — если кастом пришёл раньше, чем заказ завели.
 */
export function OrderCandidates({ group, pending, onChoose }: OrderCandidatesProps) {
  const { openNewOrderDialog } = useNewOrderDialog()
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
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
        <Button
          variant="link"
          size="inline"
          onClick={() => openNewOrderDialog({ inboxGroupId: group.id })}
        >
          Завести заказ из карточки…
        </Button>
      </div>
    </div>
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
