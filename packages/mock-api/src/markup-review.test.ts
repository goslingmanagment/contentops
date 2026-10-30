import { type ApiClient, createApiClient } from '@contentops/contracts/api/client'
import { createFrozenClock } from '@contentops/contracts/clock'
import { describe, expect, it } from 'vitest'
import { createMockFetch } from './mock-fetch'
import type { MockOptions } from './options'
import { PROTOTYPE_NOW } from './prototype-clock'

function setup(options: MockOptions = {}): ApiClient {
  return createApiClient(
    createMockFetch({ latency: false, clock: createFrozenClock(PROTOTYPE_NOW), ...options }),
  )
}

const lora = { model: 'lora' }

describe('«Разметка на проверку» (`?demo=ai-on`)', () => {
  it('ИИ работает, у неподтверждённых объектов черновики ИИ, подтверждённое не тронуто', async () => {
    const api = setup({ demo: 'ai-on' })
    const integrations = await api.admin.integrations({})
    expect(integrations.items.find((item) => item.kind === 'ai')?.state).toBe('working')

    const review = await api.markup.review({ params: lora })
    expect(review.items.length).toBeGreaterThan(500)
    const statuses = new Set(review.items.flatMap((item) => item.fields.map((f) => f.status)))
    expect(statuses.has('draft_ai')).toBe(true)
    expect(statuses.has('draft_import')).toBe(false)
    expect(review.items.some((item) => item.item_id === 'PPV-073')).toBe(false)
  })

  it('описание ИИ — фраза словами КМ, а не повтор тегов', async () => {
    const api = setup({ demo: 'ai-on' })
    const review = await api.markup.review({ params: lora })
    const ppv076 = review.items.find((item) => item.item_id === 'PPV-076')
    const description = ppv076?.fields.find((field) => field.field.key === 'description')?.field
    expect(description).toEqual({
      key: 'description',
      value: 'Медленный тизинг в нейлоне и на каблуках.',
    })
  })

  it('подтверждение несёт увиденные версии: объект уходит из папки', async () => {
    const api = setup({ demo: 'ai-on' })
    const [first] = (await api.markup.review({ params: lora })).items
    if (!first) throw new Error('Папка пуста')
    const seen = first.fields
      .filter((field) => field.status !== 'empty')
      .map((field) => ({ key: field.field.key, version: field.version }))
    await api.objects.confirmMarkup({
      params: { ...lora, id: first.item_id },
      body: { fields: seen },
    })
    const after = await api.markup.review({ params: lora })
    expect(after.items.some((item) => item.item_id === first.item_id)).toBe(false)
  })

  it('без ИИ черновики из импорта, ИИ не настроен', async () => {
    const api = setup()
    const integrations = await api.admin.integrations({})
    expect(integrations.items.find((item) => item.kind === 'ai')?.state).toBe('unset')
    const review = await api.markup.review({ params: lora })
    const statuses = new Set(review.items.flatMap((item) => item.fields.map((f) => f.status)))
    expect(statuses.has('draft_ai')).toBe(false)
  })
})
