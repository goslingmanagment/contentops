import { describe, expect, it } from 'vitest'
import { createFrozenClock, PROTOTYPE_NOW } from '../../clock'
import { ConflictDetailsSchema } from '../../domain/errors'
import { type Threshold, thresholdFor } from '../../domain/system'
import { type ApiClient, createApiClient } from '../client'
import { ApiError } from '../errors'
import { createMockFetch, type MockFetch } from './mock-fetch'
import type { MockOptions } from './options'

function setup(options: MockOptions = {}): { api: ApiClient; mock: MockFetch } {
  const mock = createMockFetch({
    latency: false,
    clock: createFrozenClock(PROTOTYPE_NOW),
    operation_ms: 0,
    role: 'owner',
    ...options,
  })
  return { api: createApiClient(mock), mock }
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error('Запрос прошёл, а должен был упасть')
}

describe('пороги', () => {
  it('меняются по версии, пишут «было → стало» в журнал и закрыты для КМ', async () => {
    const { api } = setup()
    const before = await api.admin.thresholds({})
    const tolerance = before.items.find((threshold) => threshold.key === 'time_tolerance_min')
    expect(tolerance?.value).toBe(30)
    const saved = await api.admin.updateThreshold({
      body: { key: 'time_tolerance_min', value: null },
      ifMatch: tolerance?.version,
    })
    expect(saved).toMatchObject({ value: null, version: 2 })
    const journal = await api.journal.list({
      params: { model: 'lora' },
      query: { area: 'settings' },
    })
    expect(journal.items[0]?.changes).toEqual([
      { field: 'Допуск времени', before: '30', after: 'не задано' },
    ])

    const manager = setup({ role: 'km' }).api
    const denied = await failure(
      manager.admin.updateThreshold({ body: { key: 'wait_hub_hours', value: 4 }, ifMatch: 1 }),
    )
    expect(denied.status).toBe(403)
  })

  it('в `?demo=conflict` первое сохранение получает 412, «Оставить мой» проходит', async () => {
    const { api } = setup({ demo: 'conflict' })
    const conflict = await failure(
      api.admin.updateThreshold({ body: { key: 'wait_hub_hours', value: 6 }, ifMatch: 1 }),
    )
    expect(conflict.status).toBe(412)
    const details = ConflictDetailsSchema.parse(conflict.body.details)
    expect(details).toMatchObject({ changed_by: 'Дмитрий', current_version: 2, current_value: 12 })
    const kept = await api.admin.updateThreshold({
      body: { key: 'wait_hub_hours', value: 6 },
      ifMatch: details.current_version,
    })
    expect(kept).toMatchObject({ value: 6, version: 3 })
  })
})

describe('исключения порогов', () => {
  it('самое узкое исключение побеждает: страница, тип, модель, всё', () => {
    const row = (scope: Threshold['scope'], scope_value: string | null, value: number) => ({
      key: 'too_early_days' as const,
      label: '«Слишком рано»',
      unit: 'дней',
      version: 1,
      scope,
      scope_value,
      value,
    })
    const rows = [
      row('all', null, 14),
      row('model', 'lora', 10),
      row('type', 'life', 7),
      row('account', 'lora-vip-of', 30),
    ]
    const target = { model: 'lora', account: 'lora-vip-of', type: 'life' }
    expect(thresholdFor(rows, 'too_early_days', target)).toBe(30)
    expect(thresholdFor(rows, 'too_early_days', { ...target, account: 'lora-2' })).toBe(7)
    expect(thresholdFor(rows, 'too_early_days', { model: 'lora', type: 'ppv' })).toBe(10)
    expect(thresholdFor(rows, 'too_early_days', { model: 'lily' })).toBe(14)
    expect(thresholdFor(rows, 'wait_hub_hours', target)).toBeNull()
  })

  it('заводится без версии, меняется и убирается по версии, пишется в журнал модели', async () => {
    const { api } = setup()
    const created = await api.admin.updateThreshold({
      body: { key: 'too_early_days', scope: 'account', scope_value: 'lora-2', value: 21 },
    })
    expect(created).toMatchObject({
      scope: 'account',
      scope_value: 'lora-2',
      value: 21,
      version: 1,
    })
    const list = await api.admin.thresholds({})
    const early = list.items.filter((threshold) => threshold.key === 'too_early_days')
    expect(early.map((threshold) => threshold.scope_value)).toEqual([null, 'life', 'lora-2'])

    const again = await failure(
      api.admin.updateThreshold({
        body: { key: 'too_early_days', scope: 'account', scope_value: 'lora-2', value: 28 },
      }),
    )
    expect(again.status).toBe(428)
    const changed = await api.admin.updateThreshold({
      body: { key: 'too_early_days', scope: 'account', scope_value: 'lora-2', value: 28 },
      ifMatch: 1,
    })
    expect(changed).toMatchObject({ value: 28, version: 2 })

    await api.admin.removeThreshold({
      body: { key: 'too_early_days', scope: 'account', scope_value: 'lora-2' },
      ifMatch: 2,
    })
    const after = await api.admin.thresholds({})
    expect(after.items.some((threshold) => threshold.scope_value === 'lora-2')).toBe(false)
    const journal = await api.journal.list({
      params: { model: 'lora' },
      query: { area: 'settings' },
    })
    expect(journal.items.slice(0, 3).map((event) => event.phrase)).toEqual([
      'Дмитрий убрал порог «Слишком рано» для страницы Fansly 2',
      'Дмитрий изменил порог «Слишком рано» для страницы Fansly 2',
      'Дмитрий задал порог «Слишком рано» для страницы Fansly 2',
    ])
    expect(journal.items[0]?.changes).toEqual([
      { field: '«Слишком рано» · Fansly 2', before: '28', after: 'как для всего: 14' },
    ])
  })

  it('проверка строки плана берёт порог типа объекта', async () => {
    const { api } = setup()
    const row = {
      item_id: 'SET-071',
      account: 'lora-1',
      surface: 'wall' as const,
      date: '2026-09-22',
      time: null,
      fyp_version: null,
      assignee: null,
      note: null,
      requires_new_upload: false,
      awaiting_montage: null,
      marked: null,
    }
    const early = (await api.plan.checkRow({ params: { model: 'lora' }, body: row })).warnings
    expect(early.map((warning) => warning.kind)).toContain('too_early')
    await api.admin.updateThreshold({
      body: { key: 'too_early_days', scope: 'type', scope_value: 'set', value: 1 },
    })
    const relaxed = (await api.plan.checkRow({ params: { model: 'lora' }, body: row })).warnings
    expect(relaxed.map((warning) => warning.kind)).not.toContain('too_early')
  })

  it('порог для всего не убирается, у исключения нужна область', async () => {
    const { api } = setup()
    const base = await failure(
      api.admin.removeThreshold({ body: { key: 'too_early_days' }, ifMatch: 1 }),
    )
    expect(base.status).toBe(400)
    const unknown = await failure(
      api.admin.updateThreshold({
        body: { key: 'too_early_days', scope: 'type', scope_value: 'clips', value: 3 },
      }),
    )
    expect(unknown.status).toBe(400)
  })
})

describe('люди и доступ', () => {
  it('новый человек получает временный пароль один раз и историю прав', async () => {
    const { api } = setup()
    const created = await api.settings.addPerson({
      body: { name: 'Анна', login: 'anna', role: 'manager', models: ['lily'] },
    })
    expect(created.person).toMatchObject({ gender: 'f', models: ['lily'], version: 1 })
    expect(created.temporary_password).toMatch(/^\w{4}-\w{4}-\w{4}$/)
    const again = await failure(
      api.settings.addPerson({ body: { name: 'Анна', login: 'anna', role: 'reader', models: [] } }),
    )
    expect(again.status).toBe(400)

    const updated = await api.settings.updatePerson({
      params: { person: created.person.id },
      body: { models: ['lily', 'lora'] },
      ifMatch: 1,
    })
    expect(updated.models).toEqual(['lora', 'lily'])
    const grants = await api.settings.personGrants({ params: { person: created.person.id } })
    expect(grants.items.map((grant) => grant.text)).toEqual([
      'добавил Лора',
      'выдал роль «Контент-менеджер» · Lily',
    ])
  })

  it('свою роль владелец не меняет, сессии другого отзывает', async () => {
    const { api } = setup()
    const own = await failure(
      api.settings.updatePerson({
        params: { person: 'p-dmitriy' },
        body: { role: 'reader' },
        ifMatch: 1,
      }),
    )
    expect(own.status).toBe(403)
    const revoked = await api.settings.revokePersonSessions({ params: { person: 'p-diana' } })
    expect(revoked.sessions).toBe(0)
  })
})

describe('агенты и токены', () => {
  it('секрет токена приходит только в ответе на выдачу', async () => {
    const { api } = setup()
    const issued = await api.admin.issueToken({
      params: { agent: 'a-orders' },
      body: { agent_id: 'a-orders', expires_in_days: 90 },
    })
    expect(issued.secret.startsWith(issued.token.prefix)).toBe(true)
    const agents = await api.admin.agents({})
    const listed = agents.items.find((agent) => agent.id === 'a-orders')?.tokens.at(-1)
    expect(listed).toEqual(issued.token)
    expect(JSON.stringify(agents)).not.toContain(issued.secret)
  })
})

describe('вход и выход', () => {
  it('после «Выйти везде» всё отвечает 401, вход возвращает доступ', async () => {
    const { api } = setup({ role: 'km' })
    await api.auth.signOutEverywhere({})
    expect((await failure(api.admin.me({}))).status).toBe(401)
    const wrong = await failure(api.auth.signIn({ body: { login: 'nobody', password: 'x' } }))
    expect(wrong.message).toBe('Логин или пароль не подходят')
    const signed = await api.auth.signIn({ body: { login: 'diana', password: 'пароль' } })
    expect(signed.person.name).toBe('Диана')
    expect((await api.admin.me({})).person.login).toBe('diana')
  })

  it('`?demo=signed-out` открывается страницей входа', async () => {
    const { api } = setup({ demo: 'signed-out' })
    expect((await failure(api.admin.models({}))).status).toBe(401)
  })
})

describe('интеграции и ИИ', () => {
  it('«Настроить» у Hub страницы Ари записывает код страницы и включает Hub', async () => {
    const { api } = setup()
    const connected = await api.settings.connectIntegration({
      params: { integration: 'hub:ari-2' },
      body: { hub_page: 'ari-2' },
    })
    expect(connected.state).toBe('working')
    const models = await api.admin.models({})
    const ari = models.items.find((model) => model.code === 'ari')
    expect(ari?.accounts.find((account) => account.code === 'ari-2')?.hub_page).toBe('ari-2')
  })

  it('выключенная автосверка не выключает Hub, выключенное получение — выключает', async () => {
    const { api } = setup()
    const auto = await api.admin.updateIntegration({
      params: { integration: 'hub:lora-3' },
      body: { switches: { auto_match: false } },
    })
    expect(auto.state).toBe('working')
    const receive = await api.admin.updateIntegration({
      params: { integration: 'hub:lora-3' },
      body: { switches: { receive: false } },
    })
    expect(receive.line.text).toBe('Hub выключен для Fansly 3 — отметки работают')
  })

  it('первый сервис ИИ подключает разметку', async () => {
    const { api } = setup()
    expect((await api.settings.ai({})).services).toEqual([])
    const ai = await api.settings.addAiService({
      body: { name: 'Сервис разметки', tasks: ['markup'], consent: true },
    })
    expect(ai.services[0]?.consent?.by).toBe('Дмитрий')
    const integrations = await api.admin.integrations({})
    expect(integrations.items.find((item) => item.kind === 'ai')?.state).toBe('working')
  })
})

describe('теги', () => {
  it('слияние переносит объекты и убирает тег из словаря', async () => {
    const { api } = setup()
    const before = await api.admin.tags({})
    const nylon = before.items.find((tag) => tag.key === 'nylon')
    const tights = before.items.find((tag) => tag.key === 'tights')
    const merged = await api.settings.mergeTag({
      params: { tag: 'nylon' },
      body: { into: 'tights' },
    })
    expect(merged.uses).toBeGreaterThan(tights?.uses ?? 0)
    expect(merged.uses).toBeLessThanOrEqual((tights?.uses ?? 0) + (nylon?.uses ?? 0))
    const after = await api.admin.tags({})
    expect(after.items.some((tag) => tag.key === 'nylon')).toBe(false)
  })
})

describe('журнал', () => {
  it('фильтрует по автору и результату и отдаёт «было → стало»', async () => {
    const { api } = setup()
    const denied = await api.journal.list({
      params: { model: 'lora' },
      query: { actor_type: 'agent', result: 'denied' },
    })
    expect(denied.items.map((event) => event.phrase)).toEqual([
      'Агент импорта: отказ — нет прав на модель Ари',
    ])
    const system = await api.journal.list({ params: { model: 'lora' }, query: { area: 'system' } })
    expect(system.items.some((event) => event.changes.length > 0)).toBe(true)
  })
})

describe('люди модели', () => {
  it('КМ видит имена людей своей модели, без логинов и ролей, и не видит чужую модель', async () => {
    const { api } = setup({ role: 'km' })
    const people = await api.settings.modelPeople({ params: { model: 'lora' } })
    expect(people.items.map((person) => person.name)).toContain('Никита')
    expect(Object.keys(people.items[0] ?? {})).toEqual(['id', 'name'])

    const other = await failure(api.settings.modelPeople({ params: { model: 'ari' } }))
    expect(other.status).toBe(403)
  })
})
