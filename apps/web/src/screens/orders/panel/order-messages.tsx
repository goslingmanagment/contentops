import { formatWhen, type Order, type OrderMessage } from '@contentops/contracts'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { useClock } from '@/data/api-session'

type FollowingKind = Exclude<OrderMessage['kind'], 'card'>

const KIND_LABEL: Record<FollowingKind, string> = {
  repost: 'перепост',
  delivery: 'сдача',
  revision: 'правка',
  confirmation: 'подтверждение',
  note: 'заметка',
}

/**
 * Значимые сообщения (DESIGN §4.16, п. 6): выдержки с датой — перепост, сдача, правка.
 * Карточка уже стоит первым блоком панели и здесь не повторяется; если, кроме неё,
 * сообщений нет, блока нет. «Только чтение» их не видит: сервер их не отдаёт.
 */
export function OrderMessages({ order }: { order: Order }) {
  const now = useClock().now()
  const messages = order.messages
    .filter((message): message is OrderMessage & { kind: FollowingKind } => message.kind !== 'card')
    .sort((left, right) => left.at.localeCompare(right.at))
  if (messages.length === 0) return null
  return (
    <InfoSection title="Значимые сообщения">
      <ol className="flex flex-col gap-3">
        {messages.map((message) => (
          <li
            key={`${message.at}-${message.kind}-${message.url ?? message.excerpt}`}
            className="flex flex-col gap-0.5"
          >
            <span className="text-ink-3 text-sm tabular-nums">
              {formatWhen(message.at, now)} · {KIND_LABEL[message.kind]}
              {message.url ? (
                <>
                  {' · '}
                  <a
                    href={message.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary-ink underline-offset-4 hover:underline"
                  >
                    сообщение ↗
                  </a>
                </>
              ) : null}
            </span>
            <span className="line-clamp-2 text-base">{message.excerpt}</span>
          </li>
        ))}
      </ol>
    </InfoSection>
  )
}
