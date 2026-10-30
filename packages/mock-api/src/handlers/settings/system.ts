import { settingsRoutes } from '@contentops/contracts/api/routes/settings'
import type { Integration } from '@contentops/contracts/domain/integrations'
import { INTEGRATION_NAME } from '@contentops/contracts/domain/integrations'
import type { SystemState } from '@contentops/contracts/domain/system'
import { DomainError, notFound } from '../../domain-error'
import type { World } from '../../fixtures/world-types'
import { type BoundRoute, bind } from '../../handler'
import type { MockState } from '../../state'
import { integrationLineOf } from '../../views/counters'
import { actorSays } from '../actor-says'
import { logSettingsChange } from './settings-log'

/** «Состояние» и «Интеграции» (DESIGN §4.19): пауза очереди, «Настроить» у Hub и Fyper. */

/** Cross-model duplicates are shown only to whoever has rights on more than one model. */
export function systemStateView(state: MockState): SystemState {
  const system = state.world.system
  return state.principal.models.length > 1 ? system : { ...system, cross_model_duplicates: null }
}

function integrationOf(world: World, id: string): Integration {
  const integration = world.integrations.find((candidate) => candidate.id === id)
  if (!integration) throw notFound('Такой интеграции нет')
  return integration
}

/** Hub of a page learns its page code; the page in the model gets it too. */
function connectHub(state: MockState, integration: Integration, hubPage: string): string {
  const model = integration.model ? state.world.models.get(integration.model) : undefined
  const account = model?.model.accounts.find((candidate) => candidate.code === integration.account)
  if (!model || !account) throw notFound('Такой страницы нет')
  model.model = {
    ...model.model,
    accounts: model.model.accounts.map((candidate) =>
      candidate.code === account.code ? { ...candidate, hub_page: hubPage } : candidate,
    ),
  }
  integration.switches = { receive: true, auto_match: true, publish: false }
  return `Hub для ${account.label}`
}

export function systemHandlers(): BoundRoute[] {
  return [
    bind(settingsRoutes.pauseQueue, 'owner', ({ state, params, body, log }) => {
      const queue = state.world.system.queues.find((candidate) => candidate.key === params.queue)
      if (!queue) throw notFound('Такой очереди нет')
      queue.paused = body.paused
      logSettingsChange(log, state.principal.models, {
        action: body.paused ? 'queue.pause' : 'queue.resume',
        phrase: `${actorSays(state, body.paused ? 'поставил' : 'снял')} ${body.paused ? 'на паузу' : 'с паузы'} очередь «${queue.label}»`,
      })
      return systemStateView(state)
    }),

    bind(settingsRoutes.connectIntegration, 'owner', ({ state, params, body, log }) => {
      const integration = integrationOf(state.world, params.integration)
      let subject: string
      if (integration.kind === 'hub' && body.hub_page) {
        subject = connectHub(state, integration, body.hub_page)
      } else if (integration.kind === 'fyper' && body.key) {
        subject = INTEGRATION_NAME.fyper
      } else {
        throw new DomainError('invalid_request', 'Для этой интеграции нужны другие данные')
      }
      const now = state.clock.now()
      integration.state = 'working'
      integration.last_ok_at = now
      integration.since = null
      logSettingsChange(log, integration.model ? [integration.model] : state.principal.models, {
        action: 'integration.connect',
        phrase: `${actorSays(state, 'настроил')} ${subject}`,
        changes: [{ field: subject, before: 'не настроено', after: 'работает' }],
      })
      return { ...integration, line: integrationLineOf(state.world, integration, now) }
    }),
  ]
}
