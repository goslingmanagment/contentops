import {
  type Agent,
  AgentRoleSchema,
  type Model,
  type ModelCode,
  ROLE_LABEL,
  type UpdateAgentCommand,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentops/ui/components/select'
import { ConflictLine } from '@contentops/ui/components/state-lines'
import { KeyRoundIcon } from 'lucide-react'
import { useId } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useVersionedSave } from '@/actions/use-versioned-save'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'
import { ModelChecks } from '../people/model-checks'
import { AGENT_ROLE_CHOICES } from './add-agent-dialog'
import { TokenLine } from './token-line'

interface AgentRowProps {
  agent: Agent
  models: readonly Model[]
  onIssue: () => void
}

/** Роль и модели агента — с `If-Match`, как права человека; токены следуют сразу. */
function useAgentRights(agent: Agent) {
  const api = useApi()
  const toast = useActionToast()
  return useVersionedSave<UpdateAgentCommand, Agent>({
    subject: 'агента',
    failed: 'Агент не сохранился',
    invalidates: [queryKeys.agents()],
    run: (body, version, key) =>
      api.settings.updateAgent({
        params: { agent: agent.id },
        body,
        ifMatch: version,
        idempotencyKey: key,
      }),
    onSuccess: (updated) => toast.show({ message: `Сохранено · ${updated.name}` }),
  })
}

/**
 * Агент (DESIGN §4.19): имя, модели галочками, роль и «Выдать токен»; под ним действующие
 * токены — выдан, срок, последнее использование, «Отозвать…».
 */
export function AgentRow({ agent, models, onIssue }: AgentRowProps) {
  const rights = useAgentRights(agent)
  const roleLabelId = useId()
  const live = agent.tokens.filter((token) => token.revoked_at === null)

  const changeRole = (value: string) => {
    const role = AgentRoleSchema.safeParse(value)
    if (role.success && role.data !== agent.role) {
      rights.save({ role: role.data }, agent.version)
    }
  }
  const toggleModel = (code: ModelCode, checked: boolean) => {
    const next = checked ? [...agent.models, code] : agent.models.filter((item) => item !== code)
    rights.save({ models: next }, agent.version)
  }

  return (
    <div data-slot="settings-row" className="flex flex-col">
      <div className="flex min-h-18 items-center gap-6 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="truncate font-medium">{agent.name}</p>
          <ModelChecks
            holder={agent}
            models={models}
            disabled={rights.isPending}
            onToggle={toggleModel}
          />
        </div>
        <span id={roleLabelId} className="sr-only">
          Роль: {agent.name}
        </span>
        {agent.role === 'owner' ? (
          <span className="w-48 text-sm">{ROLE_LABEL.owner}</span>
        ) : (
          <Select value={agent.role} onValueChange={changeRole} disabled={rights.isPending}>
            <SelectTrigger aria-labelledby={roleLabelId} className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AGENT_ROLE_CHOICES.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button variant="outline" size="sm" onClick={onIssue}>
          <KeyRoundIcon />
          Выдать токен
        </Button>
      </div>
      {live.length > 0 ? (
        live.map((token) => <TokenLine key={token.id} agent={agent} token={token} />)
      ) : (
        <p className="pb-3 text-muted-foreground text-sm">нет токена</p>
      )}
      {rights.conflict ? (
        <ConflictLine
          message={rights.conflict.message}
          theirsLabel={rights.conflict.theirsLabel}
          onShowTheirs={rights.showTheirs}
          onKeepMine={() => rights.keepMine()}
          className="mb-3"
        />
      ) : null}
    </div>
  )
}
