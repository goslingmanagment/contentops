import { apiRoutes } from '@contentops/contracts'
import { type ApiClient, createApiClient } from '@contentops/contracts/api/client'
import { ApiError } from '@contentops/contracts/api/errors'
import { createFrozenClock } from '@contentops/contracts/clock'
import { describe, expect, it } from 'vitest'
import { createMockFetch, type MockFetch } from './mock-fetch'
import type { MockOptions } from './options'
import { PROTOTYPE_NOW } from './prototype-clock'

function setup(options: MockOptions = {}): { api: ApiClient; mock: MockFetch } {
  const mock = createMockFetch({
    latency: false,
    clock: createFrozenClock(PROTOTYPE_NOW),
    operation_ms: 0,
    ...options,
  })
  return { api: createApiClient(mock), mock }
}

const lora = { model: 'lora' }

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error('Запрос прошёл, а должен был упасть')
}

describe('индекс модели', () => {
  it('отдаёт каталог и сводку по страницам со своими ETag и 304 на повтор', async () => {
    const { api } = setup()
    const first = await api.conditional(apiRoutes.objects.catalogIndex, {
      params: lora,
      etag: null,
    })
    expect(first.status).toBe('ok')
    if (first.status !== 'ok') return
    expect(first.data.items).toHaveLength(1391)
    const again = await api.conditional(apiRoutes.objects.catalogIndex, {
      params: lora,
      etag: first.etag,
    })
    expect(again.status).toBe('not_modified')
    const pages = await api.objects.pageSummaries({ params: lora })
    expect(pages.etag).not.toBe(first.etag)
    expect(pages.entries.length).toBeGreaterThan(1000)
  })
})

describe('изменение видно при следующем чтении', () => {
  it('принятая группа становится объектом, уходит из «Новое» и пишется в журнал', async () => {
    const { api } = setup()
    const before = await api.inbox.list({ params: lora })
    const result = await api.inbox.accept({
      params: { model: 'lora', group: 'g-sets-2109' },
      body: { as: 'default' },
    })
    expect(result).toEqual({ item_id: 'SET-075', how: 'new', next_step: 'Отобрать кадры' })
    const after = await api.inbox.list({ params: lora })
    expect(after.count).toBe(before.count - 1)
    const index = await api.objects.catalogIndex({ params: lora })
    expect(index.items.find((entry) => entry.id === 'SET-075')?.photo_count).toBe(22)
    const journal = await api.journal.list({ params: lora, query: { item: 'SET-075' } })
    expect(journal.items[0]?.phrase).toBe('Диана приняла SET-075 из «4. Sets/21.09.26»')
  })

  it('отметка строки меняет слово в плане и счётчик колонки', async () => {
    const { api } = setup()
    const day = await api.plan.day({ params: lora, query: { date: '2026-09-22' } })
    const story = day.rows.find((row) => row.manifest?.item_id === 'PPV-075')
    expect(story?.verdict.word).toBe('пропущено')
    expect(story?.mark_button).toBe('mark_confirm')
    const counters = await api.admin.counters({})
    expect(counters.models.find((entry) => entry.model === 'lora')?.plan).toBe(2)
    await api.plan.markConfirm({
      params: { model: 'lora', row: story?.id ?? '' },
      body: { stated_occurred_at: null },
    })
    const next = await api.plan.day({ params: lora, query: { date: '2026-09-22' } })
    const confirmed = next.rows.find((row) => row.id === story?.id)
    expect(confirmed?.verdict).toMatchObject({
      sign: 'done',
      word: 'подтверждено',
      detail: 'вручную, Диана',
    })
  })

  it('«Это оно» закрывает случай сверки', async () => {
    const { api } = setup()
    const list = await api.check.list({ params: lora })
    expect(list.items).toHaveLength(8)
    expect(list.unambiguous_ids).toHaveLength(2)
    const target = list.items.find((entry) => entry.version_label === 'FYP-0801 версия 1')
    expect(target?.pair_phrase).toBe('Пост 03:06 (+6 мин) · видео 0:09 — совпадает')
    const resolution = await api.check.confirmPair({
      params: { model: 'lora', case: target?.id ?? '' },
      body: { evidence_id: null },
    })
    expect(resolution.verdict.level).toBe('confirmed_manual')
    const after = await api.check.list({ params: lora })
    expect(after.items).toHaveLength(7)
    expect(after.resolved_count).toBe(list.resolved_count + 1)
  })

  it('правка названия с версией поля сохраняется, без версии — 428, со старой — 412', async () => {
    const { api } = setup()
    const item = await api.objects.get({ params: { model: 'lora', id: 'PPV-073' } })
    const title = item.markup.find((field) => field.field.key === 'title')
    const route = { params: { model: 'lora', id: 'PPV-073', field: 'title' } }
    const body = { key: 'title' as const, value: 'Торт и кружево' }
    expect((await failure(api.objects.updateField({ ...route, body }))).status).toBe(428)
    expect((await failure(api.objects.updateField({ ...route, body, ifMatch: 99 }))).status).toBe(
      412,
    )
    const saved = await api.objects.updateField({ ...route, body, ifMatch: title?.version ?? 0 })
    expect(saved.entry.title).toBe('Торт и кружево')
    const reread = await api.objects.get({ params: { model: 'lora', id: 'PPV-073' } })
    expect(reread.entry.title).toBe('Торт и кружево')
  })

  it('заказ: правка видна в заказе, закрыть незавершённый нельзя (422)', async () => {
    const { api } = setup()
    const orders = await api.orders.list({ params: lora })
    expect(orders.open_count).toBe(7)
    expect(orders.overdue_count).toBe(1)
    const red = orders.items.find((order) => order.title === 'вся в красном')
    expect(red?.status).toEqual({ sign: 'trouble', word: 'просрочено', detail: '3 дня' })
    const closing = await failure(
      api.orders.close({ params: { model: 'lora', order: red?.id ?? '' } }),
    )
    expect(closing.status).toBe(422)
    expect(closing.code).toBe('order_not_complete')
    // Not delivered yet: the revision is kept, the order stays overdue (SPEC §5: «Сдано,
    // требуется правка» needs a delivery).
    const updated = await api.orders.addRevision({
      params: { model: 'lora', order: red?.id ?? '' },
      body: { text: 'добавить чулки', message_url: null },
    })
    expect(updated.revisions.at(-1)?.text).toBe('добавить чулки')
    expect(updated.state).toBe('overdue')
  })
})

describe('сценарии дня Дианы (DESIGN §6.1)', () => {
  it('«Какой заказ?» → «Этот заказ» → «Принять как сдачу»: CUS-198, заказ сдан', async () => {
    const { api } = setup()
    const group = { model: 'lora', group: 'g-2254' }
    const decided = await api.inbox.decide({
      params: group,
      body: { decision: 'which_order', order_id: 'tg-1002627984998-12-9901' },
    })
    expect(decided.state).toEqual({
      kind: 'ready',
      note: { kind: 'order_part', order_id: 'tg-1002627984998-12-9901', part: 'видео' },
    })
    const accepted = await api.inbox.accept({ params: group, body: { as: 'default' } })
    expect(accepted).toEqual({ item_id: 'CUS-198', how: 'delivery', next_step: 'Закрыть заказ' })
    const order = await api.orders.get({
      params: { model: 'lora', order: 'tg-1002627984998-12-9901' },
    })
    expect(order.status).toMatchObject({ sign: 'done', word: 'сдано' })
  })

  it('«Уже залито» убирает объект из «Ещё не залито» этой страницы', async () => {
    const { api } = setup()
    const query = { account: 'lora-2' }
    const before = await api.objects.notUploaded({ params: lora, query })
    const ppv = before.groups.find((group) => group.type === 'ppv')
    expect(ppv?.item_ids).toContain('PPV-075')
    const result = await api.objects.alreadyUploaded({
      params: lora,
      body: { account: 'lora-2', items: ['PPV-075'] },
    })
    expect(result.results).toEqual([{ id: 'PPV-075', ok: true, code: null }])
    const after = await api.objects.notUploaded({ params: lora, query })
    expect(after.groups.find((group) => group.type === 'ppv')?.count).toBe((ppv?.count ?? 0) - 1)
  })

  it('поставленную строку автор может удалить в течение 6 с, отмеченную — нет', async () => {
    const { api } = setup()
    const created = await api.plan.createRows({
      params: lora,
      body: {
        rows: [
          {
            item_id: 'LIFE-141',
            account: 'lora-1',
            surface: 'vault',
            date: '2026-09-22',
            time: null,
            fyp_version: null,
            assignee: null,
            note: null,
            requires_new_upload: false,
            awaiting_montage: null,
            marked: null,
          },
        ],
      },
    })
    const row = created.rows[0]
    expect(row?.verdict.word).toBe('в плане')
    await api.plan.undoCreate({ params: { model: 'lora', row: row?.id ?? '' } })
    const reread = await failure(api.plan.row({ params: { model: 'lora', row: row?.id ?? '' } }))
    expect(reread.status).toBe(404)
  })
})

describe('правила ответа', () => {
  it('долгая операция отвечает 202 и доводится опросом', async () => {
    const { api } = setup()
    const started = await api.promo.prepareHandoff({
      params: { model: 'lora', collection: 'PRM-016' },
      body: {
        contractor_id: 'c-coraline',
        strip_metadata: true,
        exclude_already_handed: true,
        members: null,
      },
    })
    expect(started.kind).toBe('operation')
    const operation = await api.operations.get({
      params: { model: 'lora', operation: started.operation_id },
    })
    expect(operation.state).toBe('done')
    const sent = await api.promo.markSent({
      params: { model: 'lora', collection: 'PRM-016', handoff: started.handoff_id },
    })
    expect(sent.status).toMatchObject({ sign: 'done', word: 'передано' })
  })

  it('проверка «уже передавали» находит 38 из PRM-011', async () => {
    const { api } = setup()
    const overlap = await api.promo.handoffCheck({
      params: { model: 'lora', collection: 'PRM-016' },
      query: { contractor: 'c-coraline' },
    })
    expect(overlap.text).toBe('38 из 100 уже передавали Coraline Red (PRM-011, 02.09)')
  })

  it('повтор с тем же ключом отдаёт прежний ответ, с другим телом — 409', async () => {
    const { api } = setup()
    const input = {
      params: { model: 'lora', group: 'g-life-16' },
      body: { as: 'default' as const },
      idempotencyKey: 'k-1',
    }
    const first = await api.inbox.accept(input)
    const repeat = await api.inbox.accept(input)
    expect(repeat).toEqual(first)
    const clash = await failure(api.inbox.accept({ ...input, body: { as: 'separate' } }))
    expect(clash.status).toBe(409)
  })

  it('непринятую группу принять нельзя (422 с причиной)', async () => {
    const { api } = setup()
    const error = await failure(
      api.inbox.accept({ params: { model: 'lora', group: 'g-2254' }, body: { as: 'default' } }),
    )
    expect(error.status).toBe(422)
    // Приставку «Не выполнено:» добавляет интерфейс (describeFailure), сервер даёт одну причину.
    expect(error.message).toBe('Сначала выберите заказ')
  })

  it('слишком частые изменения получают 429 с временем повтора', async () => {
    const { api } = setup({ rate_limit: { requests: 2, window_ms: 60_000 } })
    const mark = (row: string) =>
      api.plan.cancel({ params: { model: 'lora', row }, body: { reason: null } })
    const day = await api.plan.day({ params: lora, query: { date: '2026-09-25' } })
    const [first, second, third] = day.rows.filter((row) => row.mark === null)
    await mark(first?.id ?? '')
    await mark(second?.id ?? '')
    const limited = await failure(mark(third?.id ?? ''))
    expect(limited.status).toBe(429)
    expect(limited.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('права: только чтение не меняет, КМ не видит чужую модель', async () => {
    const reader = setup({ role: 'reader' }).api
    const denied = await failure(reader.inbox.list({ params: lora }))
    expect(denied.status).toBe(403)
    const km = setup({ role: 'km' }).api
    const foreign = await failure(km.objects.catalogIndex({ params: { model: 'ari' } }))
    expect(foreign.status).toBe(403)
    expect(foreign.message).toBe('Нет доступа к этой модели')
  })
})

describe('режимы demo', () => {
  it('conflict отвечает 412 с тем, кто изменил', async () => {
    const { api } = setup({ demo: 'conflict' })
    const error = await failure(
      api.objects.updateField({
        params: { model: 'lora', id: 'PPV-073', field: 'title' },
        body: { key: 'title', value: 'x' },
        ifMatch: 1,
      }),
    )
    expect(error.status).toBe(412)
    // Правит Диана (КМ по умолчанию) — «успел изменить» другой человек, с родом для глагола.
    expect(error.body.details).toMatchObject({ changed_by: 'Никита', changed_by_gender: 'm' })
  })

  it('empty даёт пустую библиотеку, hub-down — строку интеграции в плане', async () => {
    const empty = await setup({ demo: 'empty' }).api.objects.catalogIndex({ params: lora })
    expect(empty.items).toHaveLength(0)
    const day = await setup({ demo: 'hub-down' }).api.plan.day({
      params: lora,
      query: { date: '2026-09-22' },
    })
    expect(day.groups.every((group) => group.integration?.state === 'down')).toBe(true)
  })

  it('error отвечает 500, а сессия всё равно доступна', async () => {
    const { api } = setup({ demo: 'error' })
    expect((await api.admin.me({})).person.name).toBe('Диана')
    expect(
      (await failure(api.plan.day({ params: lora, query: { date: '2026-09-22' } }))).status,
    ).toBe(500)
  })
})
