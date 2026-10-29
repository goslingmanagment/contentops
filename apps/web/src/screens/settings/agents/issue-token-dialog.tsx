import type { Agent, IssuedToken } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentops/ui/components/dialog'
import { useState } from 'react'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'
import { ChoiceSection } from '../shared/choice-chips'
import { SecretOnce } from '../shared/secret-once'

const TERMS = [
  { value: '30', label: '30 дней', days: 30 },
  { value: '90', label: '90 дней', days: 90 },
  { value: '365', label: 'Год', days: 365 },
  { value: 'none', label: 'Без срока', days: null },
] as const

type Term = (typeof TERMS)[number]['value']

interface IssueTokenDialogProps {
  agents: readonly Agent[]
  /** Агент, для которого открыли окно; `null` — окно закрыто. */
  agentId: string | null
  onOpenChange: (open: boolean) => void
}

/** «Выдать токен» (§3.9, окно 480): агент и срок; токен показывается один раз. */
export function IssueTokenDialog({ agents, agentId, onOpenChange }: IssueTokenDialogProps) {
  const open = agentId !== null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-120">
        {agentId !== null ? (
          <IssueTokenBody
            key={agentId}
            agents={agents}
            initialAgent={agentId}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

interface IssueTokenBodyProps {
  agents: readonly Agent[]
  initialAgent: string
  onClose: () => void
}

function IssueTokenBody({ agents, initialAgent, onClose }: IssueTokenBodyProps) {
  const api = useApi()
  const [agent, setAgent] = useState(initialAgent || (agents[0]?.id ?? ''))
  const [term, setTerm] = useState<Term>('90')
  const [issued, setIssued] = useState<IssuedToken | null>(null)
  const issue = useIntentMutation<{ agent: string; days: number | null }, IssuedToken>({
    failed: 'Токен не выдан',
    run: (request, key) =>
      api.admin.issueToken({
        params: { agent: request.agent },
        body: { agent_id: request.agent, expires_in_days: request.days },
        idempotencyKey: key,
      }),
    invalidates: () => [queryKeys.agents()],
    onSuccess: setIssued,
  })
  const agentName = agents.find((candidate) => candidate.id === agent)?.name ?? ''

  if (issued) {
    return (
      <div className="flex flex-col gap-5">
        <DialogHeader>
          <DialogTitle>Токен для агента «{agentName}»</DialogTitle>
          <DialogDescription className="sr-only">Токен показывается один раз</DialogDescription>
        </DialogHeader>
        <SecretOnce secret={issued.secret} label="Токен" />
        <DialogFooter>
          <Button onClick={onClose}>Готово</Button>
        </DialogFooter>
      </div>
    )
  }

  const submit = () => {
    const days = TERMS.find((option) => option.value === term)?.days ?? null
    if (agent) {
      issue.start({ agent, days })
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>Выдать токен</DialogTitle>
        <DialogDescription className="sr-only">Агент и срок токена</DialogDescription>
      </DialogHeader>
      <ChoiceSection
        label="Агент"
        options={agents.map((option) => ({ value: option.id, label: option.name }))}
        value={agent}
        onChange={setAgent}
      />
      <ChoiceSection label="Срок" options={TERMS} value={term} onChange={setTerm} />
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Отмена
        </Button>
        <Button pending={issue.isPending} onClick={submit}>
          Выдать
        </Button>
      </DialogFooter>
    </div>
  )
}
