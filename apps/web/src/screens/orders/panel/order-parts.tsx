import type { ItemId, Order } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { StatusSign } from '@contentops/ui/components/status-sign'
import { UiLink } from '@contentops/ui/components/ui-link'
import { useHref } from '@/app/use-href'
import { useToday } from '@/data/api-session'
import { useCurrentModel } from '@/shell/model/model-context'
import { isPartDone, partFacts } from '../order-text'
import type { OrderActions } from './use-order-actions'

function ItemLink({ id }: { id: ItemId }) {
  const model = useCurrentModel().code
  const href = useHref()({ to: '/$model/i/$id', params: { model, id } })
  return (
    <UiLink href={href} className="text-primary-ink underline-offset-4 hover:underline">
      {id}
    </UiLink>
  )
}

interface OrderPartsProps {
  order: Order
  actions: OrderActions
  editable: boolean
}

/**
 * Части заказа (DESIGN §4.16, п. 3): «Видео ✓ 15:37 · сдано 18.09 · CUS-197»,
 * «Фото — 0 из 20». Сданная часть — ✓, несданная — серым. Несколько роликов — одна часть:
 * пока пришли не все, отметку снимают «Ждём ещё», потом ставят «Сдано целиком» (SPEC §8.2).
 */
export function OrderParts({ order, actions, editable }: OrderPartsProps) {
  const today = useToday()
  if (order.parts.length === 0) return null
  return (
    <InfoSection title="Части">
      <ul className="flex flex-col gap-2">
        {order.parts.map((part) => {
          const done = isPartDone(part)
          const facts = partFacts(part, today)
          return (
            <li key={part.kind} className="flex min-w-0 items-center gap-1.5 text-base">
              <span>{part.kind === 'video' ? 'Видео' : 'Фото'}</span>
              {done ? <StatusSign kind="done" label="сдано" /> : null}
              <span className="min-w-0 truncate text-muted-foreground tabular-nums">
                {done ? facts : `— ${facts || 'ещё нет'}`}
                {part.item_id ? ' · ' : null}
              </span>
              {part.item_id ? <ItemLink id={part.item_id} /> : null}
              {editable && part.kind === 'video' && part.delivered > 0 ? (
                <Button
                  variant="link"
                  size="sm"
                  pending={actions.marking}
                  onClick={() => actions.markPart(order, part.kind, !done)}
                  className="ml-auto shrink-0"
                >
                  {done ? 'Ждём ещё' : 'Сдано целиком'}
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>
    </InfoSection>
  )
}
