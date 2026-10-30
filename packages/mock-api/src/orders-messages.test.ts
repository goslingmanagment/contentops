import { createApiClient } from '@contentops/contracts/api/client'
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

const lora = { model: 'lora' }

describe('значимые сообщения заказа (DESIGN §4.16, п. 6)', () => {
  it('у заказа с правкой после карточки — сдача и сообщение с правкой', async () => {
    const orders = await setup().orders.list({ params: lora })
    const revision = orders.items.find((order) => order.state === 'revision')
    expect(revision?.messages.map((message) => message.kind)).toEqual([
      'card',
      'delivery',
      'revision',
    ])
  })

  it('правка со ссылкой на сообщение попадает в значимые, без ссылки — нет', async () => {
    const api = setup()
    const orders = await api.orders.list({ params: lora })
    const open = orders.items.find((order) => order.state === 'waiting')
    const params = { model: 'lora', order: open?.id ?? '' }
    const before = open?.messages.length ?? 0
    const silent = await api.orders.addRevision({
      params,
      body: { text: 'добавить чулки', message_url: null },
    })
    expect(silent.messages).toHaveLength(before)
    const linked = await api.orders.addRevision({
      params,
      body: { text: 'без музыки', message_url: 'https://t.me/c/2627984998/9990' },
    })
    expect(linked.messages.at(-1)).toMatchObject({ kind: 'revision', excerpt: 'без музыки' })
  })
})
