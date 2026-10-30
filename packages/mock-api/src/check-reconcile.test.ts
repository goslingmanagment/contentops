import { type ApiClient, createApiClient } from '@contentops/contracts/api/client'
import { ApiError } from '@contentops/contracts/api/errors'
import { createFrozenClock } from '@contentops/contracts/clock'
import { describe, expect, it } from 'vitest'
import { createMockFetch } from './mock-fetch'
import { PROTOTYPE_NOW } from './prototype-clock'

/** «Сверить» (DESIGN §4.15): ответы, которые нужны экрану сверх списка случаев. */

function setup(demo: 'conflict' | 'hub-unset' | null = null): ApiClient {
  return createApiClient(
    createMockFetch({
      demo,
      latency: false,
      clock: createFrozenClock(PROTOTYPE_NOW),
      operation_ms: 0,
    }),
  )
}

const lora = { model: 'lora' }

async function caseOf(api: ApiClient, kind: string) {
  const list = await api.check.list({ params: lora })
  const found = list.items.find((entry) => entry.kind === kind)
  if (!found) throw new Error(`Нет случая ${kind}`)
  return found
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

describe('сверка: ответы для экрана', () => {
  it('«Стена или фуп?» подтверждается только с ответом, и ответ меняет поверхность', async () => {
    const api = setup()
    const surface = await caseOf(api, 'surface')
    const params = { model: 'lora', case: surface.id }
    const missing = await failure(api.check.confirmPair({ params, body: { evidence_id: null } }))
    expect(missing.status).toBe(400)
    const answer = await api.check.confirmPair({
      params,
      body: { evidence_id: null, surface: 'wall' },
    })
    expect(answer.verdict.level).toBe('confirmed_manual')
    const other = await caseOf(api, 'candidate')
    const extra = await failure(
      api.check.confirmPair({
        params: { model: 'lora', case: other.id },
        body: { evidence_id: null, surface: 'fyp' },
      }),
    )
    expect(extra.status).toBe(400)
  })

  it('отмена «Привязать…» снова делает пост постом без плана', async () => {
    const api = setup()
    const post = await caseOf(api, 'unplanned')
    const params = { model: 'lora', case: post.id }
    await api.check.bind({ params, body: { item_id: 'FYP-0790' } })
    const undone = await api.check.undo({ params })
    expect(undone.verdict.detail).toBe('пост без плана')
    const again = await caseOf(api, 'unplanned')
    expect(again.item_id).toBeNull()
    const bound = await api.check.bind({ params, body: { item_id: 'FYP-0791' } })
    expect(bound.verdict.sign).toBe('done')
  })

  it('отмена «Это оно» у двух вариантов возвращает оба варианта', async () => {
    const api = setup()
    const variants = await caseOf(api, 'variants')
    const params = { model: 'lora', case: variants.id }
    await api.check.confirmPair({
      params,
      body: { evidence_id: variants.posts[1]?.evidence_id ?? null },
    })
    await api.check.undo({ params })
    const back = await api.check.get({ params })
    expect(back.kind).toBe('variants')
    expect(back.posts).toHaveLength(2)
  })

  it('«Подтвердить однозначные» отдаёт новое состояние каждой пары', async () => {
    const api = setup()
    const list = await api.check.list({ params: lora })
    const answer = await api.check.confirmUnambiguous({
      params: lora,
      body: { case_ids: [...list.unambiguous_ids, 't-lora-0010'] },
    })
    const ok = answer.results.filter((result) => result.ok)
    expect(ok).toHaveLength(2)
    expect(ok.every((result) => result.verdict?.word === 'подтверждено')).toBe(true)
    expect(answer.results.find((result) => !result.ok)?.verdict).toBeNull()
  })

  it('строки «Hub не смог проверить» совпадают с числом в списке', async () => {
    const api = setup()
    const list = await api.check.list({ params: lora })
    const rows = await api.check.unverified({ params: lora })
    expect(rows.items).toHaveLength(list.unverified.total)
    for (const group of list.unverified.groups) {
      expect(rows.items.filter((row) => row.reason === group.reason)).toHaveLength(group.count)
    }
  })

  it('OnlyFans: пара PPV-074 показывает весь состав поста', async () => {
    const api = setup()
    const list = await api.check.list({ params: lora })
    const vip = list.items.find((entry) => entry.item_id === 'PPV-074')
    expect(vip?.pair_phrase).toBe('Пост 20:03 (+3 мин) · видео 9:41 и 2 фото — совпадает')
    expect(vip?.unambiguous).toBe(false)
  })

  it('число фото поста: у сета 22, у видео 0 — сравнивать есть с чем', async () => {
    const api = setup()
    const variants = await caseOf(api, 'variants')
    expect(variants.posts.map((post) => post.photo_count)).toEqual([22, 22])
    const unplanned = await caseOf(api, 'unplanned')
    expect(unplanned.posts[0]?.photo_count).toBe(0)
  })

  it('?demo=hub-unset: у страницы без Hub нет его находок — ни случаев, ни поста без плана, ни «не смог проверить»', async () => {
    const api = setup('hub-unset')
    const list = await api.check.list({ params: lora })
    expect(list.items).toEqual([])
    expect(list.unambiguous_ids).toEqual([])
    // Hub не настроен — он и не проверяет: строки «Hub не смог проверить» нет.
    expect(list.unverified.total).toBe(0)
    const day = await api.plan.day({ params: lora, query: { date: '2026-09-22' } })
    expect(day.groups.every((group) => group.unplanned_posts === 0)).toBe(true)
    const mirror = day.rows.find((row) => row.manifest?.item_id === 'FYP-0801')
    expect(mirror?.verdict.sign).not.toBe('turn')
    expect(mirror?.verdict.facts.hub).toBe('Hub для Fansly 2 не настроен')
  })

  it('?demo=conflict: пару уже решил другой — 422, и в очереди её больше нет', async () => {
    const api = setup('conflict')
    const pair = await caseOf(api, 'candidate')
    const error = await failure(
      api.check.confirmPair({
        params: { ...lora, case: pair.id },
        body: { evidence_id: pair.posts[0]?.evidence_id ?? null },
      }),
    )
    expect(error.status).toBe(422)
    expect(error.message).toBe('Случай уже решил Никита')
    const list = await api.check.list({ params: lora })
    expect(list.items.some((entry) => entry.id === pair.id)).toBe(false)
  })
})
