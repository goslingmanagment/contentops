import { type ApiClient, createApiClient } from '@contentops/contracts/api/client'
import { ApiError } from '@contentops/contracts/api/errors'
import { createFrozenClock } from '@contentops/contracts/clock'
import { describe, expect, it } from 'vitest'
import { ORDER_ID } from './fixtures/lora-orders'
import { createMockFetch } from './mock-fetch'
import type { MockOptions } from './options'
import { PROTOTYPE_NOW } from './prototype-clock'

/** «Приехало» on the mock server: decisions, «Дополнить…», files, rare cases (DESIGN §4.8). */

function setup(options: MockOptions = {}): ApiClient {
  const mock = createMockFetch({
    latency: false,
    clock: createFrozenClock(PROTOTYPE_NOW),
    operation_ms: 0,
    ...options,
  })
  return createApiClient(mock)
}

const lora = { model: 'lora' }
const groupOf = (group: string) => ({ model: 'lora', group })

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error('Запрос прошёл, а должен был упасть')
}

describe('разбор в панели группы', () => {
  it('«Этот заказ» делает группу сдачей, «Принять как сдачу» закрывает часть заказа', async () => {
    const api = setup()
    const decided = await api.inbox.decide({
      params: groupOf('g-2254'),
      body: { decision: 'which_order', order_id: ORDER_ID.breastsButt },
    })
    expect(decided.state).toEqual({
      kind: 'ready',
      note: { kind: 'order_part', order_id: ORDER_ID.breastsButt, part: 'видео' },
    })
    const accepted = await api.inbox.accept({ params: groupOf('g-2254'), body: { as: 'default' } })
    expect(accepted.how).toBe('delivery')
    const order = await api.orders.get({ params: { model: 'lora', order: ORDER_ID.breastsButt } })
    expect(order.parts[0]?.item_id).toBe(accepted.item_id)
  })

  it('«Дополнить…» кладёт файлы в выбранный объект в выбранной роли', async () => {
    const api = setup()
    const result = await api.inbox.accept({
      params: groupOf('g-sets-2109'),
      body: { as: 'default', extend: { item_id: 'SET-074', role: 'photos' } },
    })
    expect(result).toMatchObject({ item_id: 'SET-074', how: 'extend' })
    const index = await api.objects.catalogIndex({ params: lora })
    expect(index.items.find((entry) => entry.id === 'SET-074')?.photo_count).toBe(46 + 22)
  })

  it('порядок и роли файлов меняются одной правкой, фото нумеруются заново', async () => {
    const api = setup()
    const before = await api.inbox.get({ params: groupOf('g-life-16') })
    const keys = before.files.map((file) => file.key)
    const reversed = [...keys].reverse()
    const after = await api.inbox.files({
      params: groupOf('g-life-16'),
      body: { order: reversed, roles: [{ key: keys[0] ?? '', role: 'teaser' }] },
      ifMatch: before.version,
    })
    expect(after.files.map((file) => file.key)).toEqual(reversed)
    expect(after.files[0]?.role_label).toBe('фото 1')
    expect(after.files.at(-1)?.role_label).toBe('тизер')
    const stale = await failure(
      api.inbox.files({ params: groupOf('g-life-16'), body: {}, ifMatch: before.version }),
    )
    expect(stale.status).toBe(412)
  })

  it('исходник одного файла готов сразу под именем с Я.Диска, нескольких — архивом', async () => {
    const api = setup()
    const single = await api.inbox.download({ params: groupOf('g-2254') })
    expect(single).toMatchObject({ kind: 'ready', file_name: '2:54 грудь попа .mov' })
    const zip = await api.inbox.download({ params: groupOf('g-sets-2109') })
    expect(zip.kind).toBe('operation')
  })

  it('пакет не принимает «похоже на исправление» и называет, чем стала каждая группа', async () => {
    const api = setup()
    const batch = await api.inbox.acceptMany({
      params: lora,
      body: { group_ids: ['g-sets-2109', 'g-set074-plus3', 'g-341'] },
    })
    expect(batch.results.map((entry) => [entry.id, entry.ok, entry.accepted?.item_id])).toEqual([
      ['g-sets-2109', true, 'SET-075'],
      ['g-set074-plus3', true, 'SET-074'],
      ['g-341', false, undefined],
    ])
    const fix = await api.inbox.get({ params: groupOf('g-341') })
    expect(fix.state.kind).toBe('ready')
  })

  it('«В сырьё» уводит видео отдельной группой, и названия следуют за составом', async () => {
    const api = setup()
    const group = await api.inbox.decide({
      params: groupOf('g-sets-2009'),
      body: { decision: 'video_in_set', destination: 'raw' },
    })
    expect(group.title).toBe('Сеты · 20.09.26 · 33 фото')
    const list = await api.inbox.list({ params: lora, query: { state: 'active' } })
    const part = list.items.find((item) => item.id.startsWith('g-sets-2009-part'))
    expect(part?.title).toBe('Сеты · 20.09.26 · 1 видео')
    expect(part?.fields.type).toBe('raw')
  })

  it('конфликт правки называет поле', async () => {
    const api = setup({ demo: 'conflict' })
    const error = await failure(
      api.inbox.update({ params: groupOf('g-sets-2109'), body: { title: 'Новое' }, ifMatch: 1 }),
    )
    expect(error.status).toBe(412)
    expect(error.body.details?.field).toBe('title')
  })
})

describe('редкие случаи приёмки (?demo=cases)', () => {
  it('номер не выдаётся до разбора старого: «Принять» и пакет отказывают', async () => {
    const api = setup({ demo: 'cases' })
    const single = await failure(
      api.inbox.accept({ params: groupOf('g-sxt-robe'), body: { as: 'default' } }),
    )
    expect(single.code).toBe('number_not_issued')
    const batch = await api.inbox.acceptMany({
      params: lora,
      body: { group_ids: ['g-sxt-robe', 'g-life-coffee'] },
    })
    expect(batch.results).toEqual([
      { id: 'g-sxt-robe', ok: false, code: 'number_not_issued', accepted: null },
      {
        id: 'g-life-coffee',
        ok: true,
        code: null,
        accepted: { item_id: 'LIFE-192', how: 'new', next_step: 'Лента / чаты' },
      },
    ])
  })

  it('своя загрузка без типа ждёт «Что это?», после выбора — просто «готово»', async () => {
    const api = setup({ demo: 'cases' })
    const before = await api.inbox.get({ params: groupOf('g-web-photos') })
    expect(before.state).toEqual({ kind: 'decision', decision: 'what_is_it' })
    const typed = await api.inbox.decide({
      params: groupOf('g-web-photos'),
      body: { decision: 'what_is_it', type: 'life' },
    })
    expect(typed.state).toEqual({ kind: 'ready', note: { kind: 'new' } })
  })

  it('архив с тремя съёмками не принимается одним: «Разделить по папкам» даёт три группы', async () => {
    const api = setup({ demo: 'cases' })
    const batch = await api.inbox.acceptMany({ params: lora, body: { group_ids: ['g-zip-july'] } })
    expect(batch.results[0]?.ok).toBe(false)
    await api.inbox.decide({
      params: groupOf('g-zip-july'),
      body: { decision: 'split_archive', split: true },
    })
    const list = await api.inbox.list({ params: lora, query: { state: 'active' } })
    const parts = list.items.filter((group) => group.source_path.startsWith('Июль.zip'))
    expect(parts.map((group) => [group.title, group.fields.type, group.file_count])).toEqual([
      ['Июль.zip › Сеты 03.07', 'set', 80],
      ['Июль.zip › Лайф 12.07', 'life', 60],
      ['Июль.zip › Сырьё 20.07', 'raw', 74],
    ])
    expect(parts.every((group) => group.state.kind === 'ready')).toBe(true)
    expect(list.items.some((group) => group.id === 'g-zip-july')).toBe(false)
  })

  it('вторую модель межмодельного дубля видит только тот, у кого права на обе', async () => {
    const hintsFor = async (as: 'km' | 'owner') => {
      const group = await setup({ demo: 'cases', role: as }).inbox.get({
        params: groupOf('g-cross-524'),
      })
      return group.hints.map((hint) => hint.kind)
    }
    expect(await hintsFor('km')).toEqual([])
    expect(await hintsFor('owner')).toEqual(['other_model'])
  })

  it('«Подставить монтаж в строку?» решается без второго «Принять»', async () => {
    const api = setup({ demo: 'cases' })
    const group = await api.inbox.decide({
      params: groupOf('g-montage-f1'),
      body: { decision: 'substitute_montage', substitute: true },
    })
    expect(group.state).toMatchObject({ kind: 'accepted', item_id: 'FYP-0800', how: 'upload' })
  })

  it('«Повторить» у нечитаемого архива снова качает его', async () => {
    const api = setup({ demo: 'cases' })
    const group = await api.inbox.retry({ params: groupOf('g-zip-march') })
    expect(group.state).toMatchObject({ kind: 'preparing', stage: 'downloading' })
    expect(group.accept_block).toBe('Ещё качается')
  })
})

describe('разбор старого', () => {
  it('сохранённая карточка меток закрывает «Метку из имени» с сопоставленной меткой', async () => {
    const api = setup()
    const before = await api.legacy.get({ params: lora })
    const labels = before.labels.map((label) => ({
      label: label.label,
      target: label.target ?? { kind: 'post_number' as const },
    }))
    const after = await api.legacy.saveLabels({ params: lora, body: { labels } })
    const labelCases = after.disputes.filter((dispute) => dispute.kind === 'label_from_name')
    expect(labelCases.length).toBe(19)
    expect(labelCases.every((dispute) => dispute.resolved?.option === 'by_labels')).toBe(true)
  })

  it('«Номер занят» с выбором у каждой папки: «неясно» у одной оставляет случай', async () => {
    const api = setup()
    const unclear = await api.legacy.resolve({
      params: { model: 'lora', dispute: 'd-ppv-032' },
      body: {
        option: 'folders',
        folders: { '[PPV-032]_milk': 'keep', '[PPV-032]_halloween': 'unclear' },
      },
    })
    expect(unclear.disputes.find((dispute) => dispute.id === 'd-ppv-032')?.resolved).toBeNull()
  })

  it('«Неясно — оставить в разборе» не снимает случай', async () => {
    const api = setup()
    const review = await api.legacy.resolve({
      params: { model: 'lora', dispute: 'd-ppv-032' },
      body: { option: 'unclear' },
    })
    expect(review.disputes.find((dispute) => dispute.id === 'd-ppv-032')?.resolved).toBeNull()
    const resolved = await api.legacy.resolve({
      params: { model: 'lora', dispute: 'd-ppv-032' },
      body: { option: 'proposal' },
    })
    expect(resolved.disputes.find((dispute) => dispute.id === 'd-ppv-032')?.resolved).not.toBeNull()
  })
})
