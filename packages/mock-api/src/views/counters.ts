import { mskDate } from '@contentops/contracts/clock'
import type { Instant } from '@contentops/contracts/domain/common'
import type { Integration, IntegrationLine } from '@contentops/contracts/domain/integrations'
import type { Person } from '@contentops/contracts/domain/people'
import type { PlacementLevel } from '@contentops/contracts/domain/placement'
import type { Counters, ModelCounters, SpaceCard } from '@contentops/contracts/domain/system'
import { formatBytes } from '@contentops/contracts/format'
import { belongsToSpaceCard, describeIntegration } from '@contentops/contracts/integration-line'
import { evaluateRow, type FactsContext } from '../fixtures/facts'
import type { ModelWorld, World } from '../fixtures/world-types'
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
  const free = disk?.free_bytes ?? null
  const total = disk?.total_bytes ?? null
  if (!disk || free === null || total === null) {
    return { label: `${disk?.name ?? 'Место'} нет данных`, used_fraction: 0, alerts }
  }
  return {
    label: `${disk.name} свободно ${formatBytes(free)}`,
    used_fraction: 1 - free / total,
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
