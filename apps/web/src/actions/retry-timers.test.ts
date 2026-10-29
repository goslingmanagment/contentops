import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RetryTimers } from './retry-timers'

describe('автоповтор после 429', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('отказ другого действия не отменяет прошлый повтор', () => {
    const timers = new RetryTimers()
    const mark = vi.fn()
    const place = vi.fn()
    timers.schedule('mark-key', 20_000, mark)
    timers.schedule('place-key', 5_000, place)
    vi.advanceTimersByTime(20_000)
    expect(place).toHaveBeenCalledTimes(1)
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('новый отказ того же намерения переносит его повтор, а не удваивает', () => {
    const timers = new RetryTimers()
    const mark = vi.fn()
    timers.schedule('mark-key', 5_000, mark)
    vi.advanceTimersByTime(3_000)
    timers.schedule('mark-key', 5_000, mark)
    vi.advanceTimersByTime(4_000)
    expect(mark).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('повторы без ключа не сливаются; уход со страницы снимает все', () => {
    const timers = new RetryTimers()
    const first = vi.fn()
    const second = vi.fn()
    timers.schedule(undefined, 1_000, first)
    timers.schedule(undefined, 1_000, second)
    vi.advanceTimersByTime(1_000)
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 1])

    const late = vi.fn()
    timers.schedule('late', 1_000, late)
    timers.clearAll()
    vi.advanceTimersByTime(1_000)
    expect(late).not.toHaveBeenCalled()
  })
})
