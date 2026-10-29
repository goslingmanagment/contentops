import type { ItemId, Order } from '@contentops/contracts'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { StatusSign } from '@contentops/ui/components/status-sign'
import { UiLink } from '@contentops/ui/components/ui-link'
import { useHref } from '@/app/use-href'
import { useToday } from '@/data/api-session'
import { useCurrentModel } from '@/shell/model/model-context'
import { isPartDone, partFacts } from '../order-text'

function ItemLink({ id }: { id: ItemId }) {
  const model = useCurrentModel().code
  const href = useHref()({ to: '/$model/i/$id', params: { model, id } })
  return (
    <UiLink href={href} className="text-primary-ink underline-offset-4 hover:underline">
      {id}
    </UiLink>
  )
}

/**
 * Части заказа (DESIGN §4.16, п. 3): «Видео ✓ 15:37 · сдано 18.09 · CUS-197»,
 * «Фото — 0 из 20». Сданная часть — ✓, несданная — серым.
 */
export function OrderParts({ order }: { order: Order }) {
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
            </li>
          )
        })}
      </ul>
    </InfoSection>
  )
}
