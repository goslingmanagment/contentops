import { type ApiClient, createApiClient } from '@contentops/contracts/api/client'
import { ApiError } from '@contentops/contracts/api/errors'
import { createFrozenClock } from '@contentops/contracts/clock'
import { describe, expect, it } from 'vitest'
import { createMockFetch } from './mock-fetch'
import { PROTOTYPE_NOW } from './prototype-clock'

function setup(): ApiClient {
  return createApiClient(
    createMockFetch({
      latency: false,
      clock: createFrozenClock(PROTOTYPE_NOW),
      operation_ms: 0,
    }),
  )
}

const lora = { model: 'lora' }

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error('Запрос прошёл, а должен был упасть')
}

async function item(api: ApiClient, id: string) {
  return api.objects.get({ params: { ...lora, id } })
}

describe('файлы объекта', () => {
  it('порядок фото PPV-073 меняется целиком и требует версию записи', async () => {
    const api = setup()
    const before = await item(api, 'PPV-073')
    const photos = before.files.filter((file) => file.role === 'photo').map((file) => file.key)
    const reversed = [...photos].reverse()
    const refused = await failure(
      api.objectFiles.reorder({ params: { ...lora, id: 'PPV-073' }, body: { keys: reversed } }),
    )
    expect(refused.status).toBe(428)
    const after = await api.objectFiles.reorder({
      params: { ...lora, id: 'PPV-073' },
      body: { keys: reversed },
      ifMatch: before.version,
    })
    const first = after.files.find((file) => file.position === 1 && file.role === 'photo')
    expect(first?.key).toBe(photos.at(-1))
  })

  it('кадр сета отбирается в конец порядка и убирается, число в индексе следует', async () => {
    const api = setup()
    const picked = await api.objectFiles.pick({
      params: { ...lora, id: 'SET-074' },
      body: { keys: ['ed30'], selected: true },
    })
    expect(picked.entry.selected_count).toBe(22)
    expect(picked.files.find((file) => file.key === 'ed30')?.position).toBe(22)
    const dropped = await api.objectFiles.pick({
      params: { ...lora, id: 'SET-074' },
      body: { keys: ['ed30', 'ed01'], selected: false },
    })
    expect(dropped.entry.selected_count).toBe(20)
  })

  it('кадры лайфа без назначения уходят «в чаты»', async () => {
    const api = setup()
    const before = await item(api, 'LIFE-191')
    const unassigned = before.files
      .filter((file) => file.media === 'photo' && file.assignment === null)
      .map((file) => file.key)
    expect(unassigned).toHaveLength(4)
    const after = await api.objectFiles.assign({
      params: { ...lora, id: 'LIFE-191' },
      body: { keys: unassigned, assignment: 'chats' },
    })
    expect(after.entry.life_unassigned).toBe(0)
  })

  it('«Сделать фото» из кадров мастера — 202, фото появляются после операции', async () => {
    const api = setup()
    const before = await item(api, 'PPV-067')
    const frames = before.frames.slice(0, 2).map((frame) => frame.t_s)
    const accepted = await api.objectFiles.makePhotos({
      params: { ...lora, id: 'PPV-067' },
      body: { frames },
    })
    await api.operations.get({ params: { ...lora, operation: accepted.operation_id } })
    const after = await item(api, 'PPV-067')
    expect(after.entry.photo_count).toBe(2)
    expect(after.files.filter((file) => file.role === 'photo')).toHaveLength(2)
  })

  it('«Собрать версии» у FYP-0412 добавляет две версии', async () => {
    const api = setup()
    const accepted = await api.objectFiles.buildFypVersions({
      params: { ...lora, id: 'FYP-0412' },
      body: { count: 2, level: 'trim' },
    })
    await api.operations.get({ params: { ...lora, operation: accepted.operation_id } })
    const after = await item(api, 'FYP-0412')
    expect(after.fyp_versions.map((version) => version.level)).toEqual(['trim', 'trim'])
  })
})

describe('сырьё', () => {
  it('«Сделать мастером PPV» заводит PPV с происхождением «выделен из»', async () => {
    const api = setup()
    const raw = await item(api, 'RAW-0034')
    const video = raw.files.find((file) => file.media === 'video')
    if (!video) throw new Error('У RAW-0034 нет видео')
    const created = await api.objectFiles.makeMaster({
      params: { ...lora, id: 'RAW-0034' },
      body: { file_key: video.key, kind: 'dm', title: 'Кружево утром' },
    })
    const ppv = await item(api, created.item_id)
    expect(ppv.entry.ppv_kind).toBe('dm')
    expect(ppv.provenance[0]).toMatchObject({ relation: 'extracted_from', item_id: 'RAW-0034' })
  })

  it('«Выделить в новую съёмку» и «Слить с…» переносят файлы', async () => {
    const api = setup()
    const extracted = await api.objectFiles.extractShoot({
      params: { ...lora, id: 'RAW-0214' },
      body: { keys: ['raw01', 'raw02'] },
    })
    const part = await item(api, extracted.item_id)
    expect(part.files).toHaveLength(2)
    const merged = await api.objectFiles.merge({
      params: { ...lora, id: extracted.item_id },
      body: { into: 'RAW-0214' },
      ifMatch: part.version,
    })
    const whole = await item(api, merged.item_id)
    expect(whole.files).toHaveLength(22)
    expect(whole.ydisk.old_names.map((name) => name.name)).toContain(extracted.item_id)
  })
})

describe('несколько объектов', () => {
  it('«Теги…» добавляет и убирает тег у каждого выбранного', async () => {
    const api = setup()
    const answer = await api.objectBatch.tags({
      params: lora,
      body: { items: ['PPV-073', 'PPV-075'], add: ['mirror'], remove: ['lace'] },
    })
    expect(answer.results.every((result) => result.ok)).toBe(true)
    const ppv = await item(api, 'PPV-075')
    expect(ppv.entry.tags).toContain('mirror')
    expect(ppv.entry.tags).not.toContain('lace')
  })

  it('«Второй человек в кадре» без согласия не снимает строки OnlyFans (422 с числом)', async () => {
    const api = setup()
    const refused = await failure(
      api.objectBatch.secondPerson({
        params: lora,
        body: { items: ['PPV-075'], second_person: true, cancel_onlyfans_rows: false },
      }),
    )
    expect(refused.status).toBe(422)
    expect(refused.body.details).toMatchObject({ rows: 1 })
    await api.objectBatch.secondPerson({
      params: lora,
      body: { items: ['PPV-075'], second_person: true, cancel_onlyfans_rows: true },
    })
    const after = await item(api, 'PPV-075')
    expect(after.entry.second_person).toBe(true)
  })
})
