import { newIdempotencyKey } from '@contentops/contracts/api/idempotency-key'
import type { IntegrationView } from '@contentops/contracts/api/responses'
import { adminRoutes } from '@contentops/contracts/api/routes/admin'
import { settingsRoutes } from '@contentops/contracts/api/routes/settings'
import { addMinutes } from '@contentops/contracts/clock'
import type { Agent } from '@contentops/contracts/domain/agents'
import type { Integration, IntegrationSwitches } from '@contentops/contracts/domain/integrations'
import { ROLE_LABEL } from '@contentops/contracts/domain/people'
import { pastVerb } from '@contentops/contracts/format'
import { DomainError, notFound } from '../domain-error'
import type { World } from '../fixtures/world-types'
import { type BoundRoute, bind } from '../handler'
import { counters, integrationLineOf } from '../views/counters'
import { wholeList } from '../views/paginate'
import { logSettingsChange } from './settings/settings-log'
import { systemStateView } from './settings/system'
import { checkVersion } from './settings/versions'

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
  dropbox: 'scan',
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

/** Known model codes only, like the server: an unknown one is a 400. */
function agentModels(world: World, codes: readonly string[]): string[] {
  const missing = codes.filter((code) => !world.models.has(code))
  if (missing.length > 0) {
    throw new DomainError('invalid_request', 'Такой модели нет', { models: missing })
  }
  return [...world.models.keys()].filter((code) => codes.includes(code))
}

export function adminHandlers(): BoundRoute[] {
  return [
    bind(adminRoutes.me, 'read', ({ state }) => ({
      person: state.principal,
      models: state.principal.models,
      ui_skin: 'blue',
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
    bind(settingsRoutes.addAgent, 'owner', ({ state, body, log }) => {
      const agent: Agent = {
        id: `a-${newIdempotencyKey().slice(0, 8)}`,
        name: body.name,
        role: body.role,
        models: agentModels(state.world, body.models),
        tokens: [],
        version: 1,
      }
      state.world.agents.push(agent)
      logSettingsChange(log, agent.models, {
        action: 'agent.add',
        phrase: `${state.principal.name} ${pastVerb('добавил', state.principal.gender)} агента «${agent.name}» · ${ROLE_LABEL[agent.role]}`,
      })
      return agent
    }),
    bind(settingsRoutes.updateAgent, 'owner', ({ state, params, body, if_match, log }) => {
      const agent = agentOf(state.world, params.agent)
      checkVersion(state, if_match, agent, {
        field: `агента ${agent.name}`,
        rival: (record) => {
          record.role = record.role === 'reader' ? 'manager' : 'reader'
        },
        valueOf: (record) => ({ name: record.name, role: record.role, models: record.models }),
      })
      const models = body.models ? agentModels(state.world, body.models) : agent.models
      const before = { ...agent }
      agent.name = body.name ?? agent.name
      agent.role = body.role ?? agent.role
      agent.models = models
      agent.version += 1
      logSettingsChange(log, [...new Set([...before.models, ...agent.models])], {
        action: 'agent.update',
        phrase: `${state.principal.name} ${pastVerb('изменил', state.principal.gender)} агента «${agent.name}»`,
      })
      return agent
    }),
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
