import { describe, expect, it } from 'vitest'
import { createFrozenClock, PROTOTYPE_NOW } from '../../clock'
import { createApiClient } from '../client'
import { createMockFetch } from './mock-fetch'

function setup() {
  const mock = createMockFetch({
    latency: false,
    clock: createFrozenClock(PROTOTYPE_NOW),
    operation_ms: 0,
  })
  return createApiClient(mock)
}

const lora = { model: 'lora' }

describe('промо: мозаика канала', () => {
  it('у канала с одной-двумя подборками клетки добраны кадрами его файлов (§1.2)', async () => {
    const api = setup()
    const channels = await api.promo.channels({ params: lora })
    for (const channel of channels.items) {
      const cells = channel.orientation === 'landscape' ? 4 : 3
      expect(channel.covers.length, channel.id).toBeGreaterThanOrEqual(cells)
      expect(new Set(channel.covers.map((cover) => cover.key)).size, channel.id).toBe(
        channel.covers.length,
      )
    }
    const sfs = channels.items.find((channel) => channel.id === 'sfs')
    expect(sfs?.collection_count).toBe(1)
  })
})

describe('промо: материалы без подборки', () => {
  it('в «Гиф-сайтах» лежит пак без подборки, девять из него уже передавали', async () => {
    const api = setup()
    const channel = await api.promo.channel({ params: { model: 'lora', channel: 'gif' } })
    expect(channel.unfiled).toHaveLength(24)
    const handed = channel.unfiled.filter((member) => member.handed_to.length > 0)
    expect(handed).toHaveLength(9)
    expect(handed[0]?.handed_to[0]).toEqual({
      contractor_id: 'c-coraline',
      contractor: 'Coraline Red',
      collection_id: 'PRM-011',
      on: '2026-09-02',
    })
  })

  it('новая подборка из пака забирает материалы из «Без подборки» и видит повтор', async () => {
    const api = setup()
    const before = await api.promo.channel({ params: { model: 'lora', channel: 'gif' } })
    const members = before.unfiled.map(({ item_id, file_key }) => ({ item_id, file_key }))
    const created = await api.promo.add({
      params: lora,
      body: { channel: 'gif', collection: 'new', title: null, members },
    })
    expect(created.members).toHaveLength(24)
    const after = await api.promo.channel({ params: { model: 'lora', channel: 'gif' } })
    expect(after.unfiled).toHaveLength(0)
    const overlap = await api.promo.handoffCheck({
      params: { model: 'lora', collection: created.id },
      query: { contractor: 'c-coraline' },
    })
    expect(overlap.text).toBe('9 из 24 уже передавали Coraline Red (PRM-011, 02.09)')
  })

  it('подрядчики отдаются с запомненным форматом', async () => {
    const api = setup()
    const contractors = await api.promo.contractors({ params: lora })
    expect(contractors.items.map((contractor) => contractor.name)).toEqual([
      'GaranTTeam Social',
      'Coraline Red',
      'True Helper',
    ])
    expect(contractors.items[0]?.format).toBe('compact')
  })
})
