import { type ApiClient, createApiClient } from '@contentops/contracts/api/client'
import { ApiError } from '@contentops/contracts/api/errors'
import { createFrozenClock } from '@contentops/contracts/clock'
import { describe, expect, it } from 'vitest'
import { createMockFetch } from './mock-fetch'
import { PROTOTYPE_NOW } from './prototype-clock'

/** Web upload on the mock server (DESIGN §3.7): «Другое» into «Приехало», a target — at once. */

function setup(): ApiClient {
  const mock = createMockFetch({
    latency: false,
    clock: createFrozenClock(PROTOTYPE_NOW),
    operation_ms: 0,
  })
  return createApiClient(mock)
}

const lora = { model: 'lora' }

describe('загрузка с сайта', () => {
  it('«Другое» без типа приходит в Приехало группой «Загружено вами» с ◆ «Что это?»', async () => {
    const api = setup()
    const before = await api.inbox.list({ params: lora, query: { state: 'active' } })
    const result = await api.inbox.upload({
      params: lora,
      body: {
        kind: 'other',
        target: null,
        files: [
          { file_name: 'a.jpg', size_bytes: 2_000_000, media: 'photo' },
          { file_name: 'b.jpg', size_bytes: 2_000_000, media: 'photo' },
        ],
      },
    })
    expect(result).toMatchObject({ placed: 'inbox', item_id: null, decision: 'what_is_it' })
    const after = await api.inbox.list({ params: lora, query: { state: 'active' } })
    const group = after.items.find((candidate) => candidate.id === result.group_id)
    expect(group?.title).toBe('Загружено вами · 2 фото')
    expect(group?.state).toEqual({ kind: 'decision', decision: 'what_is_it' })
    expect(after.count).toBe(before.count + 1)
  })

  it('«Другое» с типом готово к «Принять»', async () => {
    const api = setup()
    const result = await api.inbox.upload({
      params: lora,
      body: {
        kind: 'other',
        target: null,
        type: 'life',
        files: [{ file_name: 'c.mov', size_bytes: 9_000_000, media: 'video' }],
      },
    })
    expect(result.decision).toBeNull()
    const group = await api.inbox.get({ params: { model: 'lora', group: result.group_id } })
    expect(group.state).toEqual({ kind: 'ready', note: { kind: 'new' } })
    expect(group.fields.title).toBe('')
  })

  it('тизер с целью привязывается к объекту и пишется в Решённое «при загрузке»', async () => {
    const api = setup()
    const index = await api.objects.catalogIndex({ params: lora })
    const bare = index.items.find((entry) => entry.type === 'ppv' && !entry.has_teaser)
    if (!bare) throw new Error('В фикстуре нет PPV без тизера')
    const result = await api.inbox.upload({
      params: lora,
      body: {
        kind: 'teaser',
        target: { kind: 'item', item_id: bare.id },
        files: [{ file_name: 'teaser.mp4', size_bytes: 30_000_000, media: 'video' }],
      },
    })
    expect(result).toMatchObject({ placed: 'attached', item_id: bare.id })
    const detail = await api.objects.get({ params: { model: 'lora', id: bare.id } })
    expect(detail.files.some((file) => file.role === 'teaser')).toBe(true)
    const reindexed = await api.objects.catalogIndex({ params: lora })
    expect(reindexed.items.find((entry) => entry.id === bare.id)?.has_teaser).toBe(true)
    const decided = await api.inbox.list({ params: lora, query: { state: 'accepted' } })
    expect(decided.items[0]?.state).toMatchObject({
      kind: 'accepted',
      how: 'upload',
      item_id: bare.id,
    })
  })

  it('монтаж для строки «под монтаж» становится новым фупом строки', async () => {
    const api = setup()
    const day = await api.plan.day({ params: lora, query: { date: '2026-09-22' } })
    const waiting = day.rows.find((row) => row.awaiting_montage !== null)
    if (!waiting) throw new Error('В фикстуре нет строки под монтаж')
    const result = await api.inbox.upload({
      params: lora,
      body: {
        kind: 'fyp_montage',
        target: { kind: 'plan_row', row_id: waiting.id },
        files: [{ file_name: 'montage.mp4', size_bytes: 40_000_000, media: 'video' }],
      },
    })
    expect(result.item_id).toMatch(/^FYP-/)
    const row = await api.plan.row({ params: { model: 'lora', row: waiting.id } })
    expect(row.manifest?.item_id).toBe(result.item_id)
    expect(row.awaiting_montage).toBeNull()
  })

  it('вид с целью без цели — отказ схемы', async () => {
    const api = setup()
    await expect(
      api.inbox.upload({
        params: lora,
        body: {
          kind: 'teaser',
          target: null,
          files: [{ file_name: 'x.mp4', size_bytes: 1, media: 'video' }],
        },
      }),
    ).rejects.toBeInstanceOf(Error)
  })

  it('тизер из фото — отказ правила', async () => {
    const api = setup()
    const error = await api.inbox
      .upload({
        params: lora,
        body: {
          kind: 'teaser',
          target: { kind: 'item', item_id: 'PPV-073' },
          files: [{ file_name: 'x.jpg', size_bytes: 1, media: 'photo' }],
        },
      })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(422)
  })
})
