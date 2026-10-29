import { isApiError, lowerFirst } from '@contentops/contracts'

/** Как показать отказ действия в полоске (DESIGN §3.8): без путей, имён и текстов заказов. */
export interface FailureDescription {
  message: string
  /** Можно ли предложить «Повторить» с тем же ключом повтора. */
  retryable: boolean
  /** 429: повтор сам через столько миллисекунд. */
  autoRetryMs: number | null
  /**
   * Отказ не от сервера и не от сети: ответ не прошёл схему, ошибка в коде. Повтор даст то же
   * самое, поэтому «Повторить» нет, а сама ошибка пишется в консоль.
   */
  unexpected?: boolean
}

const DEFAULT_RETRY_AFTER_S = 5

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Сеть не ответила: `fetch` отклоняется с `TypeError` и своим текстом в каждом браузере
 * (Chrome, Firefox, Safari, Node). Другой `TypeError` — ошибка в коде, а не связь.
 */
const NETWORK_FAILURE = /failed to fetch|networkerror|load failed|fetch failed/i

export function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && NETWORK_FAILURE.test(error.message)
}

/**
 * `failed` — что не вышло, словами действия: «Не отметилось», «Не скачалось».
 * `null` — показывать нечего (запрос отменён уходом с экрана).
 */
export function describeFailure(error: unknown, failed: string): FailureDescription | null {
  if (isAbort(error)) {
    return null
  }
  if (isNetworkFailure(error)) {
    return { message: `${failed}: нет связи`, retryable: true, autoRetryMs: null }
  }
  if (!isApiError(error)) {
    return { message: `${failed}: сбой`, retryable: false, autoRetryMs: null, unexpected: true }
  }
  switch (error.status) {
    case 429:
      return {
        message: error.message,
        retryable: false,
        autoRetryMs: (error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_S) * 1000,
      }
    case 422:
      return {
        message: `Не выполнено: ${lowerFirst(error.message)}`,
        retryable: false,
        autoRetryMs: null,
      }
    case 412:
    case 428:
      return { message: `${failed}: запись уже изменили`, retryable: false, autoRetryMs: null }
    case 403:
      return { message: `${failed}: нет прав`, retryable: false, autoRetryMs: null }
    case 404:
      return { message: `${failed}: записи уже нет`, retryable: false, autoRetryMs: null }
    case 503:
      return { message: `${failed}: нет связи`, retryable: true, autoRetryMs: null }
    default:
      return {
        message: error.status >= 500 ? `${failed}: сбой на сервере` : failed,
        retryable: error.status >= 500,
        autoRetryMs: null,
      }
  }
}
