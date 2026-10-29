import { ApiError, type ErrorCode } from '@contentops/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { describeFailure } from './failure-message'

function apiError(
  status: number,
  code: ErrorCode,
  message: string,
  retryAfter: number | null = null,
) {
  return new ApiError(status, { code, message, request_id: 'req_1' }, retryAfter)
}

describe('отказ действия словами §3.8', () => {
  it('правило домена — «Не выполнено: …» без «Повторить»', () => {
    expect(
      describeFailure(apiError(422, 'order_closed', 'Заказ уже закрыт'), 'Не отметилось'),
    ).toEqual({
      message: 'Не выполнено: заказ уже закрыт',
      retryable: false,
      autoRetryMs: null,
    })
  })

  it('429 повторяется сам через время из ответа, иначе через 5 с', () => {
    expect(
      describeFailure(
        apiError(429, 'rate_limited', 'Слишком часто — повторим через 20 с', 20),
        'Не отметилось',
      ),
    ).toMatchObject({ retryable: false, autoRetryMs: 20_000 })
    expect(
      describeFailure(apiError(429, 'rate_limited', 'Слишком часто', null), 'x')?.autoRetryMs,
    ).toBe(5_000)
  })

  it('конфликт, права и пропавшая запись — без повтора', () => {
    expect(describeFailure(apiError(412, 'version_mismatch', 'x'), 'Не сохранилось')?.message).toBe(
      'Не сохранилось: запись уже изменили',
    )
    expect(describeFailure(apiError(403, 'forbidden', 'x'), 'Не сохранилось')?.message).toBe(
      'Не сохранилось: нет прав',
    )
    expect(describeFailure(apiError(404, 'not_found', 'x'), 'Не сохранилось')).toMatchObject({
      message: 'Не сохранилось: записи уже нет',
      retryable: false,
    })
  })

  it('сбой сервера и недоступность — с «Повторить»', () => {
    expect(describeFailure(apiError(500, 'internal', 'x'), 'Не отметилось')).toMatchObject({
      message: 'Не отметилось: сбой на сервере',
      retryable: true,
    })
    expect(describeFailure(apiError(503, 'unavailable', 'x'), 'Не отметилось')).toMatchObject({
      message: 'Не отметилось: нет связи',
      retryable: true,
    })
  })

  it('«нет связи» — только когда fetch не дошёл до сервера', () => {
    expect(describeFailure(new TypeError('Failed to fetch'), 'Не отметилось')).toMatchObject({
      message: 'Не отметилось: нет связи',
      retryable: true,
    })
    expect(describeFailure(new TypeError('Load failed'), 'x')?.retryable).toBe(true)
  })

  it('несовпадение со схемой и ошибка в коде — «сбой» без «Повторить»', () => {
    const schema = new z.ZodError([])
    expect(describeFailure(schema, 'Не отметилось')).toEqual({
      message: 'Не отметилось: сбой',
      retryable: false,
      autoRetryMs: null,
      unexpected: true,
    })
    const bug = new TypeError("Cannot read properties of undefined (reading 'id')")
    expect(describeFailure(bug, 'Не отметилось')).toMatchObject({
      message: 'Не отметилось: сбой',
      retryable: false,
    })
  })

  it('отменённый уходом запрос не показывается', () => {
    expect(describeFailure(new DOMException('Запрос отменён', 'AbortError'), 'x')).toBeNull()
  })
})
