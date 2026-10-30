import { createApiClient } from '@contentops/contracts/api/client'
import { isApiError } from '@contentops/contracts/api/errors'
import { createFrozenClock } from '@contentops/contracts/clock'
import { describe, expect, it } from 'vitest'
import { createMockFetch } from './mock-fetch'
import { PROTOTYPE_NOW } from './prototype-clock'

const cus195 = { model: 'lora', id: 'CUS-195' }

function setup() {
  return createApiClient(
    createMockFetch({ latency: false, clock: createFrozenClock(PROTOTYPE_NOW) }),
  )
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return isApiError(error) ? { status: error.status, code: error.body.code } : error
  }
  throw new Error('запрос прошёл')
}

describe('лист кадров перед отправкой (DESIGN §4.20)', () => {
  it('до проверки итога нет; после — отметки и итог для версии мастера', async () => {
    const api = setup()
    const before = await api.objects.get({ params: cus195 })
    expect(before.frame_check).toBeNull()
    const [frame] = before.frames
    if (!frame) throw new Error('у CUS-195 нет кадров мастера')
    const after = await api.objects.saveFrameCheck({
      params: cus195,
      body: { version: 1, blocked: [`t:${frame.t_s}`], verdict: 'hold' },
      ifMatch: before.version,
    })
    expect(after.frame_check).toMatchObject({
      version: 1,
      blocked: [`t:${frame.t_s}`],
      verdict: 'hold',
      by: 'Диана',
    })
    expect(after.version).toBeGreaterThan(before.version)
    const journal = await api.journal.list({
      params: { model: 'lora' },
      query: { item: 'CUS-195' },
    })
    expect(journal.items[0]?.phrase).toBe('Диана проверила кадры CUS-195 для v1: не отправлять')
  })

  it('чужой кадр, несуществующая версия и старая версия записи — отказ', async () => {
    const api = setup()
    const detail = await api.objects.get({ params: cus195 })
    const save = (body: { version: number; blocked: string[] }, ifMatch = detail.version) =>
      api.objects.saveFrameCheck({
        params: cus195,
        body: { ...body, verdict: 'send' },
        ifMatch,
      })
    expect(await refusal(save({ version: 1, blocked: ['t:99999'] }))).toEqual({
      status: 400,
      code: 'invalid_request',
    })
    expect(await refusal(save({ version: 3, blocked: [] }))).toEqual({
      status: 400,
      code: 'invalid_request',
    })
    await save({ version: 1, blocked: [] })
    expect(await refusal(save({ version: 1, blocked: [] }))).toMatchObject({ status: 412 })
  })
})
