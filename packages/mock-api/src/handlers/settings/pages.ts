import { settingsRoutes } from '@contentops/contracts/api/routes/settings'
import type { Instant } from '@contentops/contracts/domain/common'
import type { Integration } from '@contentops/contracts/domain/integrations'
import type { Account, Model } from '@contentops/contracts/domain/model'
import type { WeekNorm } from '@contentops/contracts/domain/plan'
import { CONTRACTOR_FORMAT_LABEL } from '@contentops/contracts/domain/promo'
import { DomainError, notFound } from '../../domain-error'
import { smallModel } from '../../fixtures/world'
import type { ModelWorld } from '../../fixtures/world-types'
import { type BoundRoute, bind } from '../../handler'
import type { MockState } from '../../state'
import { actorSays } from '../actor-says'
import { logSettingsChange } from './settings-log'

/** «Модели и страницы» (DESIGN §4.19): новая модель, новая страница, формат подрядчика. */

function integration(patch: Partial<Integration> & Pick<Integration, 'id' | 'kind'>): Integration {
  return {
    model: null,
    account: null,
    state: 'unset',
    last_ok_at: null,
    since: null,
    retry_at: null,
    down_reason: null,
    catch_up: null,
    switches: {},
    ...patch,
  }
}

/** Hub for a new page: working at once when its Hub page is known. */
function hubFor(account: Account, now: Instant): Integration {
  const known = account.hub_page !== null
  return integration({
    id: `hub:${account.code}`,
    kind: 'hub',
    model: account.model,
    account: account.code,
    state: known ? 'working' : 'unset',
    last_ok_at: known ? now : null,
    switches: known ? { receive: true, auto_match: true } : {},
  })
}

/** A new page starts with an empty norm; it is filled in «Страницы и нормы». */
function emptyNorm(account: Account): WeekNorm {
  const idle = [0, 0, 0, 0, 0, 0, 0]
  return {
    account: account.code,
    cells: [
      { kind: 'fyp', per_day: idle, time: null },
      { kind: 'wall', per_day: idle, time: null },
    ],
    release: null,
    usual_assignee: null,
    uniq_level: account.uniq_level,
    version: 1,
  }
}

function modelWorldOf(state: MockState, code: string): ModelWorld {
  const model = state.world.models.get(code)
  if (!model) throw notFound('Такой модели нет')
  return model
}

function accountTaken(state: MockState, code: string): boolean {
  return [...state.world.models.values()].some((model) =>
    model.model.accounts.some((account) => account.code === code),
  )
}

export function pagesHandlers(): BoundRoute[] {
  return [
    bind(settingsRoutes.addModel, 'owner', ({ state, body, log }) => {
      if (state.world.models.has(body.code)) {
        throw new DomainError('invalid_request', 'Такой код модели уже есть', { field: 'code' })
      }
      const model: Model = {
        code: body.code,
        name: body.name,
        name_genitive: body.name,
        timezone: 'Europe/Moscow',
        accounts: [],
      }
      state.world.models.set(model.code, smallModel(model, [], {}))
      for (const person of state.world.people) {
        if (person.role === 'owner') person.models = [...person.models, model.code]
      }
      state.world.integrations.push(
        integration({ id: `ydisk:${model.code}`, kind: 'ydisk', model: model.code }),
      )
      logSettingsChange(log, [model.code], {
        action: 'model.add',
        phrase: `${actorSays(state, 'добавил')} модель ${model.name} · ${model.code}`,
      })
      return model
    }),

    bind(settingsRoutes.addAccount, 'owner', ({ state, params, body, log }) => {
      const world = modelWorldOf(state, params.model)
      if (accountTaken(state, body.code)) {
        throw new DomainError('invalid_request', 'Такой код страницы уже есть', { field: 'code' })
      }
      const account: Account = {
        code: body.code,
        model: world.model.code,
        platform: body.platform,
        label: body.label,
        handle: body.handle,
        hub_page: body.hub_page,
        usual_assignee: null,
        uniq_level: 'soft',
        position: world.model.accounts.length,
      }
      world.model = { ...world.model, accounts: [...world.model.accounts, account] }
      world.norms.set(account.code, emptyNorm(account))
      world.coverage.set(account.code, {
        posts_complete: false,
        vault_complete: false,
        visible_from: null,
      })
      state.world.integrations.push(hubFor(account, state.clock.now()))
      world.summary_version += 1
      logSettingsChange(log, [world.model.code], {
        action: 'account.add',
        phrase: `${actorSays(state, 'добавил')} страницу ${account.label} · ${account.code}`,
      })
      return world.model
    }),

    bind(settingsRoutes.addContractor, 'owner', ({ state, body, log }) => {
      const contractor = {
        id: `c-${state.world.contractors.length + 1}`,
        name: body.name,
        channel: body.channel,
        contact: body.contact,
        format: body.format,
        version: 1,
      }
      state.world.contractors.push(contractor)
      logSettingsChange(log, state.principal.models, {
        action: 'contractor.add',
        phrase: `${actorSays(state, 'добавил')} подрядчика ${contractor.name}`,
      })
      return contractor
    }),

    bind(settingsRoutes.updateContractor, 'owner', ({ state, params, body, log }) => {
      const contractor = state.world.contractors.find(
        (candidate) => candidate.id === params.contractor,
      )
      if (!contractor) throw notFound('Такого подрядчика нет')
      const before = contractor.format
      contractor.format = body.format
      contractor.version += 1
      logSettingsChange(log, state.principal.models, {
        action: 'contractor.update',
        phrase: `${actorSays(state, 'изменил')} формат подрядчика ${contractor.name}`,
        changes: [
          {
            field: 'Формат',
            before: CONTRACTOR_FORMAT_LABEL[before],
            after: CONTRACTOR_FORMAT_LABEL[body.format],
          },
        ],
      })
      return contractor
    }),
  ]
}
