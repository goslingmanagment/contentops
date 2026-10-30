import type { Instant } from '@contentops/contracts/domain/common'
import type { Integration } from '@contentops/contracts/domain/integrations'
import { connectedAiSettings } from './fixtures/admin-records'
import { applyAiDrafts } from './fixtures/ai-drafts'
import { buildPeakInbox } from './fixtures/lora-inbox'
import { buildCasesInbox } from './fixtures/lora-inbox-cases'
import { AGENT } from './fixtures/people'
import type { ModelWorld, World } from './fixtures/world-types'
import type { DemoMode } from './options'

/**
 * Data side of `?demo=`: integrations switched, an empty model, a peak day in «Приехало»,
 * every rarer case of acceptance (`cases`), AI markup drafts once the AI service works.
 */

const HUB_DOWN_SINCE: Instant = '2026-09-22T10:52:00Z'
const AI_LAST_OK: Instant = '2026-09-22T11:08:00Z'
/** Агент заказов молчит два дня: и строка Telegram, и его токен помнят одно и то же время. */
const ORDERS_AGENT_LAST_SEEN: Instant = '2026-09-20T09:14:00Z'

function setIntegrations(
  world: World,
  match: (integration: Integration) => boolean,
  patch: Partial<Integration>,
) {
  world.integrations = world.integrations.map((integration) =>
    match(integration) ? { ...integration, ...patch } : integration,
  )
}

const loraHub = (integration: Integration) =>
  integration.kind === 'hub' && integration.model === 'lora'

function emptyModel(model: ModelWorld) {
  model.items.clear()
  model.tracks = []
  model.plan_rows.clear()
  model.releases = []
  model.inbox = []
  model.legacy.disputes = []
  model.orders = []
  model.collections.clear()
  model.promo_unfiled.clear()
  model.handoffs = []
  model.channels = model.channels.map((channel) => ({
    ...channel,
    collection_count: 0,
    file_count: 0,
    last_handoff_on: null,
    covers: [],
  }))
  model.journal = []
  model.recent.clear()
}

const DEMO_CHANGES: Partial<Record<DemoMode, (world: World) => void>> = {
  'hub-off': (world) =>
    setIntegrations(world, loraHub, {
      state: 'off',
      since: '2026-09-21T09:00:00Z',
      switches: { receive: false, auto_match: false, publish: false },
    }),
  'hub-unset': (world) =>
    setIntegrations(world, loraHub, {
      state: 'unset',
      last_ok_at: null,
      since: null,
      switches: {},
    }),
  'hub-down': (world) =>
    setIntegrations(world, loraHub, {
      state: 'down',
      since: HUB_DOWN_SINCE,
      retry_at: '2026-09-22T11:28:00Z',
      down_reason: 'unreachable',
    }),
  'disk-off': (world) =>
    setIntegrations(world, (integration) => integration.kind === 'ydisk', {
      state: 'off',
      switches: { scan: false },
    }),
  'ai-off': (world) => {
    setIntegrations(world, (integration) => integration.kind === 'ai', {
      state: 'off',
      since: '2026-09-22T08:00:00Z',
    })
    world.admin.ai = connectedAiSettings({
      reason: 'много отказов (22 % на 30 объектах)',
      since: '2026-09-22T08:00:00Z',
    })
  },
  'ai-on': (world) => {
    setIntegrations(world, (integration) => integration.kind === 'ai', {
      state: 'working',
      last_ok_at: AI_LAST_OK,
    })
    world.admin.ai = connectedAiSettings(null)
    const lora = world.models.get('lora')
    if (lora) applyAiDrafts(lora, world.tags)
  },
  'all-off': (world) => {
    setIntegrations(world, loraHub, {
      state: 'off',
      since: '2026-09-21T09:00:00Z',
      switches: { receive: false, auto_match: false, publish: false },
    })
    setIntegrations(world, (integration) => integration.kind === 'ydisk', {
      state: 'off',
      switches: { scan: false },
    })
    setIntegrations(
      world,
      (integration) => integration.kind === 'ai' || integration.kind === 'fyper',
      { state: 'off' },
    )
    setIntegrations(world, (integration) => integration.kind === 'agents', {
      state: 'off',
      switches: { enabled: false },
    })
    world.admin.ai = connectedAiSettings(null)
    setIntegrations(world, (integration) => integration.kind === 'telegram', {
      last_ok_at: ORDERS_AGENT_LAST_SEEN,
    })
    for (const token of world.agents.find((agent) => agent.id === AGENT.orders)?.tokens ?? []) {
      token.last_used_at = ORDERS_AGENT_LAST_SEEN
    }
  },
  peak: (world) => {
    const lora = world.models.get('lora')
    if (lora) lora.inbox = buildPeakInbox()
  },
  cases: (world) => {
    const lora = world.models.get('lora')
    if (lora) lora.inbox = buildCasesInbox()
  },
  empty: (world) => {
    const lora = world.models.get('lora')
    if (lora) emptyModel(lora)
  },
}

export function applyDemoToWorld(world: World, demo: DemoMode | null | undefined) {
  if (demo) DEMO_CHANGES[demo]?.(world)
}
