import {
  formatDate,
  mskDate,
  type Order,
  type OrderRevision,
  pastVerb,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { StatusWord } from '@contentops/ui/components/status-word'
import { ExternalLinkIcon, PlusIcon } from 'lucide-react'
import { useToday } from '@/data/api-session'
import { CompleteRevisionMenu } from './complete-revision-menu'
import { RevisionForm } from './revision-form'
import type { OrderActions } from './use-order-actions'

/** «выполнена · проверила Диана» или «выполнена · новая версия CUS-195». */
function doneDetail(done: NonNullable<OrderRevision['done']>): string {
  if (done.basis === 'new_version') return done.version_label ?? 'новая версия'
  return `${pastVerb('проверил', done.by.gender)} ${done.by.name}`
}

interface RevisionRowProps {
  order: Order
  revision: OrderRevision
  actions: OrderActions
  editable: boolean
  /** «Выполнена» этой правки уже стоит главной кнопкой панели. */
  inHeader: boolean
}

function RevisionRow({ order, revision, actions, editable, inHeader }: RevisionRowProps) {
  const today = useToday()
  const done = revision.done
  return (
    <li className="flex flex-col gap-1">
      {revision.text ? <p className="text-base">«{revision.text}»</p> : null}
      <p className="flex items-center gap-1.5 text-ink-3 text-sm tabular-nums">
        {formatDate(mskDate(revision.created_at), today)} · {revision.created_by.name}
        {revision.message_url ? (
          <>
            {' · '}
            <a
              href={revision.message_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary-ink underline-offset-4 hover:underline"
            >
              сообщение
              <ExternalLinkIcon aria-hidden className="size-3.5" />
            </a>
          </>
        ) : null}
      </p>
      <div className="flex min-h-7.5 items-center justify-between gap-2">
        {done ? (
          <StatusWord sign="done" detail={doneDetail(done)}>
            выполнена
          </StatusWord>
        ) : (
          <StatusWord sign="turn">открыта</StatusWord>
        )}
        {editable && done ? (
          <Button
            variant="link"
            size="sm"
            pending={actions.reopening}
            onClick={() => actions.reopen(order, revision.id)}
          >
            Переоткрыть
          </Button>
        ) : null}
        {editable && !done && !inHeader ? (
          <CompleteRevisionMenu
            pending={actions.completing}
            onComplete={(basis) => actions.complete(order, revision.id, basis)}
          />
        ) : null}
      </div>
    </li>
  )
}

interface OrderRevisionsProps {
  order: Order
  actions: OrderActions
  editable: boolean
  /** Правка, чья «Выполнена» стоит в шапке панели. */
  headerRevision: string | null
  adding: boolean
  onAddingChange: (adding: boolean) => void
}

/**
 * Правки (DESIGN §4.16, п. 5): требование, «сообщение ↗», дата, «открыта» или
 * «выполнена» с основанием; «Выполнена ▾», «Переоткрыть»; внизу «Добавить правку».
 */
export function OrderRevisions({
  order,
  actions,
  editable,
  headerRevision,
  adding,
  onAddingChange,
}: OrderRevisionsProps) {
  const canAdd = editable && order.state !== 'closed'
  if (order.revisions.length === 0 && !canAdd) return null
  return (
    <InfoSection title="Правки">
      {order.revisions.length > 0 ? (
        <ul className="flex flex-col gap-4">
          {order.revisions.map((revision) => (
            <RevisionRow
              key={revision.id}
              order={order}
              revision={revision}
              actions={actions}
              editable={editable}
              inHeader={revision.id === headerRevision}
            />
          ))}
        </ul>
      ) : null}
      {canAdd && adding ? (
        <RevisionForm
          pending={actions.addingRevision}
          onCancel={() => onAddingChange(false)}
          onSubmit={(body) => actions.addRevision(order, body, () => onAddingChange(false))}
        />
      ) : null}
      {canAdd && !adding ? (
        <div>
          <Button variant="outline" size="sm" onClick={() => onAddingChange(true)}>
            <PlusIcon />
            Добавить правку
          </Button>
        </div>
      ) : null}
    </InfoSection>
  )
}
