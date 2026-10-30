import { createApiClient } from '@contentops/contracts/api/client'
import { createFrozenClock } from '@contentops/contracts/clock'
import { describe, expect, it } from 'vitest'
import { createMockFetch } from './mock-fetch'
import type { PrototypeRole } from './options'
import { PROTOTYPE_NOW } from './prototype-clock'

function setup(role: PrototypeRole) {
  const mock = createMockFetch({
    latency: false,
    clock: createFrozenClock(PROTOTYPE_NOW),
    operation_ms: 0,
    role,
  })
  return createApiClient(mock)
}

const lora = { model: 'lora' }

describe('заказы глазами «Только чтение» (DESIGN §2.3)', () => {
  it('правка видна знаком, без текста, ссылок на карточку и сообщение', async () => {
    const orders = await setup('reader').orders.list({ params: lora })
    const revision = orders.items.find((order) => order.state === 'revision')
    expect(revision?.status).toEqual({ sign: 'turn', word: 'правка', detail: null })
    expect(
      revision?.revisions.every((item) => item.text === null && item.message_url === null),
    ).toBe(true)
    expect(orders.items.every((order) => order.card.url === '' && order.card.text === null)).toBe(
      true,
    )
    expect(orders.items.every((order) => order.buyer === null && order.messages.length === 0)).toBe(
      true,
    )
  })

  it('прочим состояниям подробности остаются: срок и просрочка — не тексты заказа', async () => {
    const orders = await setup('reader').orders.list({ params: lora })
    const overdue = orders.items.find((order) => order.state === 'overdue')
    expect(overdue?.status.detail).toBe('3 дня')
  })

  it('контент-менеджер видит всё', async () => {
    const orders = await setup('km').orders.list({ params: lora })
    const revision = orders.items.find((order) => order.state === 'revision')
    expect(revision?.status.detail).toBe('«без музыки, только звук комнаты»')
    expect(revision?.card.url).toMatch(/^https:\/\/t\.me\//)
  })
})
