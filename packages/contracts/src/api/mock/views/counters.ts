import { mskDate } from '../../../clock'
import type { Instant } from '../../../domain/common'
import type { Integration, IntegrationLine } from '../../../domain/integrations'
import type { Person } from '../../../domain/people'
import type { PlacementLevel } from '../../../domain/placement'
import type { Counters, ModelCounters, SpaceCard } from '../../../domain/system'
import { evaluateRow, type FactsContext } from '../../../fixtures/facts'
import type { ModelWorld, World } from '../../../fixtures/world-types'
import { formatBytes } from '../../../format'
import { belongsToSpaceCard, describeIntegration } from '../../../integration-line'
import { inboxList } from './inbox'

/** Counters of the left column and the space card (DESIGN §2.2), one request for all models. */

const NEEDS_STEP: ReadonlySet<PlacementLevel> = new Set<PlacementLevel>([
  'planned',
  'missed',
  'blocked_second_person',
])

export function modelCounters(
  world: World,
  model: ModelWorld,
  person: Person,
  now: Instant,
): ModelCounters {
  const context: FactsContext = { now, world, model }
  const today = mskDate(now)
  const todayRows = [...model.plan_rows.values()].filter(
    (row) => row.date === today && !row.cancelled,
  )
  const verdicts = todayRows.map((row) => ({ row, verdict: evaluateRow(context, row) }))
  const mine = verdicts.filter(({ row }) => person.role === 'owner' || row.assignee === person.id)
  const steps = mine.filter(
    ({ verdict }) => NEEDS_STEP.has(verdict.level) || verdict.sign === 'turn',
  )
  const inbox = inboxList(model, now, 'active')
  const decisions = inbox.items.filter(
    (group) => group.state.kind === 'decision' || group.state.kind === 'error',
  )
  return {
    model: model.model.code,
    inbox: person.role === 'reader' ? 0 : inbox.count,
    plan: person.role === 'reader' ? 0 : steps.length,
    plan_missed: steps.some(({ verdict }) => verdict.level === 'missed'),
    attention:
      decisions.length > 0 ||
      verdicts.some(({ verdict }) => verdict.sign === 'turn' || verdict.sign === 'trouble'),
  }
}

/** The phrase of an integration with its page label. */
export function integrationLineOf(
  world: World,
  integration: Integration,
  now: Instant,
): IntegrationLine {
  const model = integration.model ? world.models.get(integration.model) : undefined
  const account = model?.model.accounts.find((candidate) => candidate.code === integration.account)
  return describeIntegration(integration, { now, accountLabel: account?.label ?? null })
}

export function spaceCard(world: World, person: Person, now: Instant): SpaceCard {
  const disk = world.system.disks[0]
  const alerts = world.integrations
    .filter((integration) => belongsToSpaceCard(integration))
    .filter(
      (integration) => integration.model === null || person.models.includes(integration.model),
    )
    .map((integration) => integrationLineOf(world, integration, now))
  return {
    label: disk ? `${disk.name} свободно ${formatBytes(disk.free_bytes)}` : '',
    used_fraction: disk ? 1 - disk.free_bytes / disk.total_bytes : 0,
    alerts,
  }
}

export function counters(world: World, person: Person, now: Instant): Counters {
  return {
    models: person.models.flatMap((code) => {
      const model = world.models.get(code)
      return model ? [modelCounters(world, model, person, now)] : []
    }),
    space: spaceCard(world, person, now),
    generated_at: now,
  }
}
