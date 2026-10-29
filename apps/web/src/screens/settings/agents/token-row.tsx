import {
  type Agent,
  type AgentToken,
  formatAgo,
  formatDate,
  type Model,
  mskDate,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { SettingsRow } from '@contentops/ui/components/settings-section'
import { useState } from 'react'
import { useClock, useToday } from '@/data/api-session'
import { modelNamesOf } from '../shared/model-names'
import { RevokeTokenDialog } from './revoke-token-dialog'

interface TokenRowProps {
  agent: Agent
  /** `null` — у агента нет действующего токена. */
  token: AgentToken | null
  models: readonly Model[]
  onIssue: () => void
}

/**
 * «Приёмка · Лора · co_7f3a… · выдан 01.09 · до 01.12» и справа «3 мин назад · Отозвать…»:
 * отзыв не отменить, поэтому он идёт через подтверждение.
 */
export function TokenRow({ agent, token, models, onIssue }: TokenRowProps) {
  const today = useToday()
  const now = useClock().now()
  const [revoking, setRevoking] = useState(false)

  const scope = modelNamesOf(agent.models, models)
  if (!token) {
    return (
      <SettingsRow label={agent.name} detail={`${scope} · нет токена`}>
        <Button variant="outline" size="sm" onClick={onIssue}>
          Выдать токен
        </Button>
      </SettingsRow>
    )
  }
  const issued = `выдан ${formatDate(mskDate(token.issued_at), today)}`
  const expires = token.expires_at
    ? `до ${formatDate(mskDate(token.expires_at), today)}`
    : 'без срока'
  return (
    <SettingsRow
      label={agent.name}
      detail={
        <>
          {scope} · <span className="font-mono text-xs">{token.prefix}…</span> · {issued} ·{' '}
          {expires}
        </>
      }
    >
      <span className="whitespace-nowrap text-muted-foreground text-sm tabular-nums">
        {token.last_used_at
          ? `последнее использование ${formatAgo(token.last_used_at, now)}`
          : 'ещё не использовался'}
      </span>
      <Button variant="outline" size="sm" onClick={() => setRevoking(true)}>
        Отозвать…
      </Button>
      <RevokeTokenDialog agent={agent} token={token} open={revoking} onOpenChange={setRevoking} />
    </SettingsRow>
  )
}
