import { createApiClient, createFrozenClock, type ItemDetail } from '@contentops/contracts'
import { createMockFetch, PROTOTYPE_NOW } from '@contentops/mock-api'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  initialBlocked,
  isWholeVideo,
  sheetCheckOf,
  sheetFramesOf,
  sheetVersionOf,
} from './frame-sheet-model'

let custom: ItemDetail
let sexting: ItemDetail

beforeAll(async () => {
  const api = createApiClient(
    createMockFetch({ latency: false, clock: createFrozenClock(PROTOTYPE_NOW) }),
  )
  custom = await api.objects.get({ params: { model: 'lora', id: 'CUS-195' } })
  sexting = await api.objects.get({ params: { model: 'lora', id: 'SXT-014' } })
})

const check = (version: number, blocked: string[] = []) => ({
  version,
  blocked,
  verdict: 'hold' as const,
  by: 'Диана',
  at: PROTOTYPE_NOW,
})

describe('лист кадров (DESIGN §4.20)', () => {
  it('у кастома — кадры мастера с таймкодом, это один ролик', () => {
    const frames = sheetFramesOf(custom)
    expect(frames).toHaveLength(custom.frames.length)
    expect(frames[0]?.key).toBe(`t:${custom.frames[0]?.t_s}`)
    expect(frames[0]?.caption).toMatch(/^\d\d:\d\d$/)
    expect(isWholeVideo(custom)).toBe(true)
  })

  it('у секстинга — его фото и клипы, их можно не отправлять поштучно', () => {
    const frames = sheetFramesOf(sexting)
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every((frame) => !frame.key.startsWith('t:'))).toBe(true)
    expect(isWholeVideo(sexting)).toBe(false)
  })

  it('проверка прежней версии мастера не считается, отметки не переносятся', () => {
    const version = sheetVersionOf(custom)
    const current = { ...custom, frame_check: check(version, ['t:11']) }
    expect(sheetCheckOf(current).kind).toBe('current')
    expect([...initialBlocked(current)]).toEqual(['t:11'])
    const stale = { ...custom, frame_check: check(version + 1, ['t:11']) }
    expect(sheetCheckOf(stale).kind).toBe('stale')
    expect(initialBlocked(stale).size).toBe(0)
    expect(sheetCheckOf(custom).kind).toBe('none')
  })
})
