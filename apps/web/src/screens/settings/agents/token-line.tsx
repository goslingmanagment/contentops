import { type Agent, type AgentToken, formatAgo, formatDate, mskDate } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { useState } from 'react'
import { useClock, useToday } from '@/data/api-session'
import { RevokeTokenDialog } from './revoke-token-dialog'

interface TokenLineProps {
  agent: Agent
  token: AgentToken
}

/**
 * Токен под строкой агента: «co_7f3a… · выдан 01.09 · до 01.12» и справа «3 мин назад ·
 * Отозвать…»: отзыв не отменить, поэтому он идёт через подтверждение.
 */
export function TokenLine({ agent, token }: TokenLineProps) {
  const today = useToday()
  const now = useClock().now()
  const [revoking, setRevoking] = useState(false)
  const issued = `выдан ${formatDate(mskDate(token.issued_at), today)}`
  const expires = token.expires_at
    ? `до ${formatDate(mskDate(token.expires_at), today)}`
    : 'без срока'
  return (
    <div className="flex min-h-10 items-center gap-6 pb-2 text-sm">
      <p className="min-w-0 flex-1 truncate text-muted-foreground">
        <span className="font-mono text-xs">{token.prefix}…</span> · {issued} · {expires}
      </p>
      <span className="whitespace-nowrap text-muted-foreground tabular-nums">
        {token.last_used_at
          ? `последнее использование ${formatAgo(token.last_used_at, now)}`
          : 'ещё не использовался'}
      </span>
      <Button variant="outline" size="sm" onClick={() => setRevoking(true)}>
        Отозвать…
      </Button>
      <RevokeTokenDialog agent={agent} token={token} open={revoking} onOpenChange={setRevoking} />
    </div>
  )
}
