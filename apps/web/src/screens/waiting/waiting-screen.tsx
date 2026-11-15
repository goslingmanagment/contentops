import { FieldHeader } from '@contentops/ui/components/field-header'
import { EmptyState } from '@contentops/ui/components/state-lines'
import { useRole } from '@/data/session'
import { useWaiting } from '@/data/waiting'
import { FieldLayout } from '@/shell/field/field-layout'
import { useCurrentModel } from '@/shell/model/model-context'
import { WaitingLines } from './waiting-lines'

/**
 * «Ждут вас» `/<модель>/waiting` (план продуктов §2.4, §4.4): дела человека из Hub по этой модели
 * и свои строки ContentOps. Дело открывается там, где его решают; здесь ничего не копируется.
 */
export function WaitingScreen() {
  const model = useCurrentModel()
  const role = useRole()
  const waiting = useWaiting(model.code, role, { withChecks: true })
  const hub = waiting.hub.data?.hub
  const empty = waiting.matters.length === 0 && waiting.own.length === 0
  return (
    <FieldLayout className="overflow-y-auto pb-6">
      <FieldHeader title="Ждут вас" meta={model.name} />
      {hub === 'unreachable' ? (
        <p className="py-2 text-muted-foreground text-sm">
          Hub не ответил: его дела покажутся, когда ответит.
        </p>
      ) : null}
      {hub === 'no_hub' ? (
        <p className="py-2 text-muted-foreground text-sm">
          Дела из Hub видны, когда вы вошли через Hub.
        </p>
      ) : null}
      {waiting.hub.isPending ? null : empty ? (
        <EmptyState>Ничего не ждёт</EmptyState>
      ) : (
        <div className="max-w-180">
          <WaitingLines model={model.code} waiting={waiting} />
        </div>
      )}
    </FieldLayout>
  )
}
