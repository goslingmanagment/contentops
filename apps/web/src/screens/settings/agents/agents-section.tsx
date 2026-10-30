import { Button } from '@contentops/ui/components/button'
import {
  SettingsSection,
  SettingsSectionSkeleton,
} from '@contentops/ui/components/settings-section'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import { BotIcon } from 'lucide-react'
import { useState } from 'react'
import { useModels } from '@/data/session'
import { useAgents } from '@/data/settings'
import { SettingsPage } from '../settings-layout'
import { AddAgentDialog } from './add-agent-dialog'
import { AgentRow } from './agent-row'
import { IssueTokenDialog } from './issue-token-dialog'

/**
 * «Агенты и токены» (DESIGN §4.19): агент, роль, модели, выдан, срок, последнее
 * использование, «Отозвать». «Добавить агента» — имя, роль, модели; «Выдать токен»
 * показывает токен один раз.
 */
export function AgentsSection() {
  const agents = useAgents()
  const models = useModels()
  const [adding, setAdding] = useState(false)
  const [issuing, setIssuing] = useState<string | null>(null)

  return (
    <SettingsPage
      title="Агенты и токены"
      refreshing={agents.isFetching && !agents.isPending}
      actions={
        <Button onClick={() => setAdding(true)}>
          <BotIcon />
          Добавить агента
        </Button>
      }
    >
      {agents.isError && !agents.data ? (
        <ErrorLine layout="center" message="Не загрузилось" onRetry={() => void agents.refetch()} />
      ) : null}
      {agents.isPending ? <SettingsSectionSkeleton rows={3} /> : null}
      {agents.data && models.data ? (
        <SettingsSection>
          {agents.data.length === 0 ? (
            <p className="py-4 text-muted-foreground">Агентов нет</p>
          ) : (
            agents.data.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                models={models.data}
                onIssue={() => setIssuing(agent.id)}
              />
            ))
          )}
        </SettingsSection>
      ) : null}
      <AddAgentDialog open={adding} onOpenChange={setAdding} models={models.data ?? []} />
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
