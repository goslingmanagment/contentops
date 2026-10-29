import { addMinutes } from '../../../clock'
import type { Agent } from '../../../domain/agents'
import type { Integration, IntegrationSwitches } from '../../../domain/integrations'
import type { World } from '../../../fixtures/world-types'
import { pastVerb } from '../../../format'
import { newIdempotencyKey } from '../../idempotency-key'
import type { IntegrationView } from '../../responses'
import { adminRoutes } from '../../routes/admin'
import { notFound } from '../domain-error'
import { type BoundRoute, bind } from '../handler'
import { counters, integrationLineOf } from '../views/counters'
import { wholeList } from '../views/paginate'
import { systemStateView } from './settings/system'

/** Session, counters and settings (DESIGN §4.19). */

function integrationView(world: World, integration: Integration, now: string): IntegrationView {
  return { ...integration, line: integrationLineOf(world, integration, now) }
}

function accountLabel(world: World, integration: Integration): string | null {
  const model = integration.model ? world.models.get(integration.model) : undefined
  return (
    model?.model.accounts.find((account) => account.code === integration.account)?.label ?? null
  )
}

type SwitchKey = keyof IntegrationSwitches

/** The switch that turns the whole integration off; Hub keeps working without «Автосверка». */
const MAIN_SWITCH: Record<Integration['kind'], SwitchKey | null> = {
  hub: 'receive',
  ydisk: 'scan',
  agents: 'enabled',
  ai: null,
  fyper: null,
  telegram: null,
}

const SWITCH_LABEL: Record<SwitchKey, string> = {
  receive: 'Получать данные Hub',
  auto_match: 'Автосверка Hub',
  scan: 'Скан Я.Диска',
  enabled: 'Агенты',
}

/** «Дмитрий выключил автосверку Hub для Fansly 3». */
const SWITCH_OBJECT: Record<SwitchKey, string> = {
  receive: 'получение данных Hub',
  auto_match: 'автосверку Hub',
  scan: 'скан Я.Диска',
  enabled: 'агентов',
}

function switchWord(value: boolean | undefined): string {
  return value === false ? 'выключено' : 'включено'
}

const SWITCH_KEYS: readonly SwitchKey[] = ['receive', 'auto_match', 'scan', 'enabled']

function switchChanges(before: IntegrationSwitches, after: IntegrationSwitches) {
  return SWITCH_KEYS.flatMap((key): [SwitchKey, boolean][] => {
    const value = after[key]
    return value !== undefined && value !== before[key] ? [[key, value]] : []
  })
}

function agentOf(world: World, id: string): Agent {
  const agent = world.agents.find((candidate) => candidate.id === id)
  if (!agent) throw notFound('Такого агента нет')
  return agent
}

export function adminHandlers(): BoundRoute[] {
  return [
    bind(adminRoutes.me, 'read', ({ state }) => ({
      person: state.principal,
      models: state.principal.models,
    })),
    bind(adminRoutes.counters, 'read', ({ state }) =>
      counters(state.world, state.principal, state.clock.now()),
    ),
    bind(adminRoutes.models, 'read', ({ state }) =>
      wholeList(
        [...state.world.models.values()]
          .filter((model) => state.principal.models.includes(model.model.code))
          .map((model) => model.model),
      ),
    ),
    bind(adminRoutes.people, 'owner', ({ state }) => wholeList(state.world.people)),
    bind(adminRoutes.agents, 'owner', ({ state }) => wholeList(state.world.agents)),
    bind(adminRoutes.issueToken, 'owner', ({ state, params, body, log }) => {
      const agent = agentOf(state.world, params.agent)
      const secret = `co_${newIdempotencyKey().replaceAll('-', '')}`
      const now = state.clock.now()
      const token = {
        id: `t-${agent.id}-${agent.tokens.length + 1}`,
        prefix: secret.slice(0, 7),
        issued_at: now,
        expires_at: body.expires_in_days ? addMinutes(now, body.expires_in_days * 24 * 60) : null,
        last_used_at: null,
        revoked_at: null,
      }
      agent.tokens.push(token)
      log({
        area: 'settings',
        action: 'token.issue',
        phrase: `${state.principal.name} ${pastVerb('выдал', state.principal.gender)} токен агенту «${agent.name}»`,
        model: agent.models[0],
      })
      return { token, secret }
    }),
    bind(adminRoutes.revokeToken, 'owner', ({ state, params, log }) => {
      const agent = agentOf(state.world, params.agent)
      const token = agent.tokens.find((candidate) => candidate.id === params.token)
      if (!token) throw notFound('Такого токена нет')
      token.revoked_at = state.clock.now()
      log({
        area: 'settings',
        action: 'token.revoke',
        phrase: `${state.principal.name} ${pastVerb('отозвал', state.principal.gender)} токен агента «${agent.name}»`,
        model: agent.models[0],
      })
      return agent
    }),
    bind(adminRoutes.integrations, 'staff', ({ state }) =>
      wholeList(
        state.world.integrations
          .filter(
            (integration) =>
              integration.model === null || state.principal.models.includes(integration.model),
          )
          .map((integration) => integrationView(state.world, integration, state.clock.now())),
      ),
    ),
    bind(adminRoutes.updateIntegration, 'owner', ({ state, params, body, log }) => {
      const integration = state.world.integrations.find(
        (candidate) => candidate.id === params.integration,
      )
      if (!integration) throw notFound('Такой интеграции нет')
      const before = integration.switches
      integration.switches = { ...before, ...body.switches }
      // Only the main switch turns the integration off; «Автосверка» alone does not.
      const main = MAIN_SWITCH[integration.kind]
      const off = main !== null && integration.switches[main] === false
      if (off && integration.state === 'working') {
        integration.state = 'off'
        integration.since = state.clock.now()
      } else if (!off && integration.state === 'off') {
        integration.state = 'working'
        integration.since = null
      }
      const label = accountLabel(state.world, integration)
      const scope = label ? ` для ${label}` : ''
      for (const [key, value] of switchChanges(before, integration.switches)) {
        const verb = pastVerb(value ? 'включил' : 'выключил', state.principal.gender)
        log({
          area: 'settings',
          action: 'integration.update',
          phrase: `${state.principal.name} ${verb} ${SWITCH_OBJECT[key]}${scope}`,
          changes: [
            {
              field: `${SWITCH_LABEL[key]}${label ? ` · ${label}` : ''}`,
              before: switchWord(before[key]),
              after: switchWord(value),
            },
          ],
          model: integration.model ?? undefined,
        })
      }
      return integrationView(state.world, integration, state.clock.now())
    }),
    bind(adminRoutes.tags, 'read', ({ state }) => wholeList(state.world.tags)),
    bind(adminRoutes.state, 'read', ({ state }) => systemStateView(state)),
    bind(adminRoutes.operation, 'read', ({ state, params }) => {
      const operation = state.operations.view(params.operation)
      if (!operation) throw notFound('Такой операции нет')
      return operation
    }),
  ]
}
