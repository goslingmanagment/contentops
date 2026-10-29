import { AI_TASK_LABEL, type AiService } from '../../../../domain/admin'
import type { Integration } from '../../../../domain/integrations'
import { formatNumber } from '../../../../format'
import { settingsRoutes } from '../../../routes/settings'
import { notFound } from '../../domain-error'
import { type BoundRoute, bind } from '../../handler'
import type { MockState } from '../../state'
import { actorSays } from '../actor-says'
import { logSettingsChange } from './settings-log'

/** «Сервис ИИ» (DESIGN §4.19, §4.20): сервисы, согласие на каждый, бюджет, остановка. */

function aiIntegration(state: MockState): Integration {
  const integration = state.world.integrations.find((candidate) => candidate.kind === 'ai')
  if (!integration) throw notFound('Интеграции ИИ нет')
  return integration
}

function serviceOf(state: MockState, id: string): AiService {
  const service = state.world.admin.ai.services.find((candidate) => candidate.id === id)
  if (!service) throw notFound('Такого сервиса нет')
  return service
}

function markWorking(state: MockState): void {
  const integration = aiIntegration(state)
  integration.state = 'working'
  integration.since = null
  integration.last_ok_at = state.clock.now()
  state.world.admin.ai.stopped = null
}

function budgetWord(budget: number | null): string {
  return budget === null ? 'не задан' : `$${formatNumber(budget)} в месяц`
}

export function aiHandlers(): BoundRoute[] {
  return [
    bind(settingsRoutes.ai, 'owner', ({ state }) => state.world.admin.ai),

    bind(settingsRoutes.addAiService, 'owner', ({ state, body, log }) => {
      const ai = state.world.admin.ai
      const service: AiService = {
        id: `ai-${ai.services.length + 1}`,
        name: body.name,
        tasks: body.tasks,
        consent: { by: state.principal.name, at: state.clock.now() },
        spent_month_usd: 0,
      }
      ai.services = [...ai.services, service]
      // The first service connects AI: from now on the «Сервис ИИ» section is listed.
      if (aiIntegration(state).state === 'unset') markWorking(state)
      logSettingsChange(log, state.principal.models, {
        action: 'ai.service.add',
        phrase: `${actorSays(state, 'подключил')} сервис ИИ «${service.name}»`,
        changes: [
          {
            field: 'Что делает',
            before: 'нет',
            after: service.tasks.map((task) => AI_TASK_LABEL[task]).join(', '),
          },
        ],
      })
      return ai
    }),

    bind(settingsRoutes.updateAiService, 'owner', ({ state, params, body, log }) => {
      const service = serviceOf(state, params.service)
      service.consent = body.consent ? { by: state.principal.name, at: state.clock.now() } : null
      logSettingsChange(log, state.principal.models, {
        action: 'ai.consent',
        phrase: `${actorSays(state, body.consent ? 'дал' : 'отозвал')} согласие сервису «${service.name}»`,
      })
      return state.world.admin.ai
    }),

    bind(settingsRoutes.updateAiBudget, 'owner', ({ state, body, log }) => {
      const ai = state.world.admin.ai
      const before = ai.budget_month_usd
      ai.budget_month_usd = body.budget_month_usd
      logSettingsChange(log, state.principal.models, {
        action: 'ai.budget',
        phrase: `${actorSays(state, 'изменил')} бюджет ИИ`,
        changes: [
          { field: 'Бюджет', before: budgetWord(before), after: budgetWord(ai.budget_month_usd) },
        ],
      })
      return ai
    }),

    bind(settingsRoutes.resumeAi, 'owner', ({ state, log }) => {
      markWorking(state)
      logSettingsChange(log, state.principal.models, {
        action: 'ai.resume',
        phrase: `${actorSays(state, 'включил')} разметку ИИ`,
      })
      return state.world.admin.ai
    }),
  ]
}
