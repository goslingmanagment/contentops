import type { Agent, AgentToken } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  SettingsSection,
  SettingsSectionSkeleton,
} from '@contentops/ui/components/settings-section'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import { KeyRoundIcon } from 'lucide-react'
import { useState } from 'react'
import { useModels } from '@/data/session'
import { useAgents } from '@/data/settings'
import { SettingsPage } from '../settings-layout'
import { IssueTokenDialog } from './issue-token-dialog'
import { TokenRow } from './token-row'

/** Действующие токены агента; без них — одна строка «нет токена». */
function rowsOf(agent: Agent): (AgentToken | null)[] {
  const live = agent.tokens.filter((token) => token.revoked_at === null)
  return live.length > 0 ? live : [null]
}

/**
 * «Агенты и токены» (DESIGN §4.19): агент, модели, выдан, срок, последнее использование,
 * «Отозвать». «Выдать токен» показывает токен один раз.
 */
export function AgentsSection() {
  const agents = useAgents()
  const models = useModels()
  const [issuing, setIssuing] = useState<string | null>(null)

  return (
    <SettingsPage
      title="Агенты и токены"
      refreshing={agents.isFetching && !agents.isPending}
      actions={
        <Button onClick={() => setIssuing(agents.data?.[0]?.id ?? '')} disabled={!agents.data}>
          <KeyRoundIcon />
          Выдать токен
        </Button>
      }
    >
      {agents.isError && !agents.data ? (
        <ErrorLine layout="center" message="Не загрузилось" onRetry={() => void agents.refetch()} />
      ) : null}
      {agents.isPending ? <SettingsSectionSkeleton rows={3} /> : null}
      {agents.data ? (
        <SettingsSection>
          {agents.data.flatMap((agent) =>
            rowsOf(agent).map((token) => (
              <TokenRow
                key={`${agent.id}:${token?.id ?? 'none'}`}
                agent={agent}
                token={token}
                models={models.data ?? []}
                onIssue={() => setIssuing(agent.id)}
              />
            )),
          )}
        </SettingsSection>
      ) : null}
      <IssueTokenDialog
        agents={agents.data ?? []}
        agentId={issuing}
        onOpenChange={(open) => {
          if (!open) {
            setIssuing(null)
          }
        }}
      />
    </SettingsPage>
  )
}
