import { createApiClient } from '@contentops/contracts/api/client'
import { isApiError } from '@contentops/contracts/api/errors'
import { createFrozenClock } from '@contentops/contracts/clock'
import { describe, expect, it } from 'vitest'
import { createMockFetch } from './mock-fetch'
import { PROTOTYPE_NOW } from './prototype-clock'

function setup() {
  const mock = createMockFetch({
    latency: false,
    clock: createFrozenClock(PROTOTYPE_NOW),
    operation_ms: 0,
  })
  return createApiClient(mock)
}

const prm015 = { model: 'lora', collection: 'PRM-015' }

describe('промо: досылка той же подборки (DESIGN §4.17)', () => {
  it('прошлая передача этой же подборки тому же подрядчику видна в проверке', async () => {
    const api = setup()
    const overlap = await api.promo.handoffCheck({
      params: prm015,
      query: { contractor: 'c-garanteam' },
    })
    expect(overlap.text).toBe('60 из 60 уже передавали GaranTTeam Social (PRM-015, 18.09)')
  })

  it('другому подрядчику повтора нет', async () => {
    const api = setup()
    const overlap = await api.promo.handoffCheck({
      params: prm015,
      query: { contractor: 'c-truehelper' },
    })
    expect(overlap.already).toBe(0)
    expect(overlap.text).toBeNull()
  })

  it('«Убрать их» без нового — отказ, дубли не уходят', async () => {
    const api = setup()
    const attempt = api.promo.prepareHandoff({
      params: prm015,
      body: {
        contractor_id: 'c-garanteam',
        strip_metadata: true,
        exclude_already_handed: true,
        members: null,
      },
    })
    await expect(attempt).rejects.toSatisfy(isApiError)
  })

  it('досылка несёт только добавленное после прошлой передачи', async () => {
    const api = setup()
    await api.promo.add({
      params: { model: 'lora' },
      body: {
        channel: 'instagram',
        collection: 'PRM-015',
        title: null,
        members: [{ item_id: 'PPV-073', file_key: 'teaser' }],
      },
    })
    const overlap = await api.promo.handoffCheck({
      params: prm015,
      query: { contractor: 'c-garanteam' },
    })
    expect(overlap.text).toBe('60 из 61 уже передавали GaranTTeam Social (PRM-015, 18.09)')
    const started = await api.promo.prepareHandoff({
      params: prm015,
      body: {
        contractor_id: 'c-garanteam',
        strip_metadata: true,
        exclude_already_handed: true,
        members: null,
      },
    })
    const collection = await api.promo.collection({ params: prm015 })
    const handoff = collection.handoffs.find((candidate) => candidate.id === started.handoff_id)
    expect(handoff?.video_count).toBe(1)
  })

  it('выбор в подборке уходит отдельной передачей только из выбранного', async () => {
    const api = setup()
    const before = await api.promo.collection({ params: { model: 'lora', collection: 'PRM-016' } })
    const picked = before.members
      .slice(0, 3)
      .map(({ item_id, file_key }) => ({ item_id, file_key }))
    const started = await api.promo.prepareHandoff({
      params: { model: 'lora', collection: 'PRM-016' },
      body: {
        contractor_id: 'c-truehelper',
        strip_metadata: true,
        exclude_already_handed: true,
        members: picked,
      },
    })
    const after = await api.promo.collection({ params: { model: 'lora', collection: 'PRM-016' } })
    const handoff = after.handoffs.find((candidate) => candidate.id === started.handoff_id)
    expect((handoff?.video_count ?? 0) + (handoff?.photo_count ?? 0)).toBe(3)
  })

  it('у видео в подборке есть длительность, у фото — нет', async () => {
    const api = setup()
    const collection = await api.promo.collection({
      params: { model: 'lora', collection: 'PRM-010' },
    })
    const video = collection.members.find((member) => member.media === 'video')
    const photo = collection.members.find((member) => member.media === 'photo')
    expect(video?.duration_s).toBeGreaterThan(0)
    expect(photo?.duration_s).toBeNull()
  })
})
