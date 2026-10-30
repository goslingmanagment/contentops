import { type ApiClient, createApiClient } from '@contentops/contracts/api/client'
import { ApiError } from '@contentops/contracts/api/errors'
import { createFrozenClock } from '@contentops/contracts/clock'
import { describe, expect, it } from 'vitest'
import { createMockFetch } from './mock-fetch'
import { PROTOTYPE_NOW } from './prototype-clock'

function setup(): ApiClient {
  return createApiClient(
    createMockFetch({ latency: false, clock: createFrozenClock(PROTOTYPE_NOW), operation_ms: 0 }),
  )
}

const lora = { model: 'lora' }
const montage = { file_name: 'belly_dance_no_music.mp4', size_bytes: 612_000_000 }

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error('Запрос прошёл, а должен был упасть')
}

describe('«Сделать PPV» из кастома', () => {
  it('свой монтаж без файла не принимается', async () => {
    const api = setup()
    const error = await failure(
      api.objects.makePpv({
        params: { ...lora, id: 'CUS-195' },
        body: { kind: 'dm', title: 'Танец живота', source: 'upload', montage: null },
      }),
    )
    expect(error.status).toBe(400)
    const custom = await api.objects.get({ params: { ...lora, id: 'CUS-195' } })
    expect(custom.entry.ppv_made_as).toBeNull()
  })

  it('мастер как есть, когда имя фана в ролике не исключено, — отказ', async () => {
    const api = setup()
    const error = await failure(
      api.objects.makePpv({
        params: { ...lora, id: 'CUS-195' },
        body: { kind: 'dm', title: 'Танец живота', source: 'as_is', montage: null },
      }),
    )
    expect(error.status).toBe(400)
    expect(error.message).toContain('свой монтаж')
  })

  it('свой монтаж: номера нет, пока проверка не прошла; потом PPV принят с этим мастером', async () => {
    const api = setup()
    const upload = await api.objects.makePpv({
      params: { ...lora, id: 'CUS-195' },
      body: { kind: 'dm', title: 'Танец живота', source: 'upload', montage },
    })
    if (!('operation_id' in upload)) throw new Error('Ждали загрузку с целью, а не номер')
    const waiting = await api.objects.get({ params: { ...lora, id: 'CUS-195' } })
    expect(waiting.entry.ppv_made_as).toBeNull()
    expect(waiting.ppv_montage).toEqual({ operation_id: upload.operation_id })
    expect(waiting.ready_for_ppv).toBe(false)
    const again = await failure(
      api.objects.makePpv({
        params: { ...lora, id: 'CUS-195' },
        body: { kind: 'dm', title: 'Танец живота', source: 'upload', montage },
      }),
    )
    expect(again.status).toBe(422)

    const done = await api.operations.get({ params: { ...lora, operation: upload.operation_id } })
    expect(done.state).toBe('done')
    const id = done.result?.item_id ?? ''
    expect(id).toMatch(/^PPV-/)
    const ppv = await api.objects.get({ params: { ...lora, id } })
    const master = ppv.files.find((file) => file.role === 'master')
    expect(master?.file_name).toBe(montage.file_name)
    expect(master?.state).toEqual({ kind: 'ready' })
    expect(ppv.entry.duration_s).toBe(221)
    expect(ppv.provenance.map((link) => link.item_id)).toContain('CUS-195')
    const custom = await api.objects.get({ params: { ...lora, id: 'CUS-195' } })
    expect(custom.entry.ppv_made_as).toBe(id)
    expect(custom.ppv_montage).toBeNull()
  })

  it('без имени фана мастер берётся как есть, загрузки нет', async () => {
    const api = setup()
    const result = await api.objects.makePpv({
      params: { ...lora, id: 'CUS-197' },
      body: { kind: 'bundle', title: 'Босс', source: 'as_is', montage: null },
    })
    if ('operation_id' in result) throw new Error('Мастер как есть — номер сразу, без загрузки')
    expect(result.item_id).toMatch(/^PPV-/)
    expect(result.next_step).toBe('Добавить тизер')
  })
})
