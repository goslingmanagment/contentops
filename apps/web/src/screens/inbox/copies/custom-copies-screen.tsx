import { formatWhen, type InboxAlert, isApiError } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { ListRowSkeleton } from '@contentops/ui/components/skeletons'
import { EmptyState, ErrorLine } from '@contentops/ui/components/state-lines'
import { StatusSign } from '@contentops/ui/components/status-sign'
import { Thumb } from '@contentops/ui/components/thumb'
import { Link } from '@tanstack/react-router'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useClock } from '@/data/api-session'
import { useDismissAlertCommand, useInboxAlerts } from '@/data/inbox'
import { queryKeys } from '@/data/query-keys'
import { useRole } from '@/data/session'
import { useItemCover } from '@/objects/use-item-cover'
import { FieldLayout } from '@/shell/field/field-layout'
import { useCurrentModel } from '@/shell/model/model-context'
import { InboxForbidden } from '../shared/inbox-forbidden'
import { InboxHeader } from '../shared/inbox-header'

const SKELETON_ROWS = [0, 1, 2] as const
const SOURCE: Record<InboxAlert['source'], string> = { dropbox: 'Dropbox', yandex_disk: 'Я.Диск' }

/**
 * Приехало › Копии кастомов `/<модель>/inbox/copies` (DESIGN §4.8, SPEC §6.2): байты
 * кастома лежат вне его папки — копия или перенос. Строка — какой кастом, где копия, когда
 * увидели; «Открыть кастом» и «Понятно» владельца. Вкладка видна, пока есть открытые.
 */
export function CustomCopiesScreen() {
  const model = useCurrentModel().code
  const alerts = useInboxAlerts(model)
  const items = alerts.data?.items ?? []
  // «Понятно» — владелец (SPEC §11.1); в интерфейсе всегда человек, агент сигнал не гасит.
  const canDismiss = useRole() === 'owner'
  const dismissCommand = useDismissAlertCommand(model)
  const dismiss = useIntentMutation<InboxAlert, InboxAlert>({
    failed: 'Не отметилось',
    run: (alert, key) => dismissCommand(alert.id, key),
    invalidates: () => [queryKeys.inboxAlerts(model), queryKeys.counters()],
  })

  if (isApiError(alerts.error) && alerts.error.status === 403) {
    return <InboxForbidden />
  }

  return (
    <FieldLayout>
      <InboxHeader active="copies" />
      <p className="mt-2 max-w-3xl text-ink-3 text-sm">
        Байты кастома нашлись вне папки кастомов. Кастом и всё, что из него сделано, не ставится в
        фуп, сториз и на стену без цены — только как PPV.
      </p>
      <div className="-mx-7 flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pt-3 pb-4">
        {alerts.isPending ? (
          <div aria-hidden className="-mx-2 flex flex-col">
            {SKELETON_ROWS.map((row) => (
              <ListRowSkeleton key={row} height={64} thumb="square" />
            ))}
          </div>
        ) : null}
        {alerts.isError ? (
          <ErrorLine
            layout="center"
            message="Не загрузилось"
            onRetry={() => void alerts.refetch()}
          />
        ) : null}
        {alerts.data && items.length === 0 ? (
          <EmptyState>Копий кастомов вне их папки нет</EmptyState>
        ) : null}
        {items.length > 0 ? (
          <ul aria-label="Копии кастомов" className="-mx-2 flex flex-col">
            {items.map((alert) => (
              <CopyRow
                key={alert.id}
                alert={alert}
                model={model}
                canDismiss={canDismiss}
                dismissing={dismiss.isPending}
                onDismiss={() => dismiss.start(alert)}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </FieldLayout>
  )
}

interface CopyRowProps {
  alert: InboxAlert
  model: string
  canDismiss: boolean
  dismissing: boolean
  onDismiss: () => void
}

/** Строка 64: обложка кастома, ▲ «CUS-012 · Название», где лежит копия, когда увидели. */
function CopyRow({ alert, model, canDismiss, dismissing, onDismiss }: CopyRowProps) {
  const now = useClock().now()
  const cover = useItemCover(alert.custom.id)
  const title = alert.custom.title ? `${alert.custom.id} · ${alert.custom.title}` : alert.custom.id
  return (
    <li className="flex h-16 min-w-0 items-center gap-3 rounded-lg px-2 hover:bg-accent">
      <Thumb {...cover} aspect="1:1" showCaptions={false} className="w-10 shrink-0 rounded-md" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <StatusSign kind="trouble" />
          <span className="truncate">{title}</span>
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5 text-ink-3 text-sm">
          <span className="shrink-0">копия на {SOURCE[alert.source]}:</span>
          <span className="truncate font-mono text-xs" title={alert.path}>
            {alert.path}
          </span>
          {alert.also_in.length > 0 ? (
            <span className="shrink-0">· в каталоге {alert.also_in.join(', ')}</span>
          ) : null}
        </span>
      </span>
      <span className="shrink-0 text-ink-3 text-sm tabular-nums">
        {formatWhen(alert.seen_at, now)}
      </span>
      <Button variant="outline" size="sm" asChild>
        <Link to="/$model/i/$id" params={{ model, id: alert.custom.id }}>
          Открыть кастом
        </Link>
      </Button>
      {canDismiss ? (
        <Button variant="secondary" size="sm" disabled={dismissing} onClick={onDismiss}>
          Понятно
        </Button>
      ) : null}
    </li>
  )
}
