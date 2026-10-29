import type { ErrorCode } from '../../domain/errors'
import { HTTP_STATUS_BY_CODE } from '../../domain/errors'

/** A refusal of the mock server; turned into the single error format by the dispatcher. */
export class DomainError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details: Record<string, unknown> | undefined
  readonly retryAfterSeconds: number | null

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    retryAfterSeconds: number | null = null,
  ) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.status = HTTP_STATUS_BY_CODE[code]
    this.details = details
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export function notFound(message: string): DomainError {
  return new DomainError('not_found', message)
}

export function forbidden(message = 'Нет доступа к этой модели'): DomainError {
  return new DomainError('forbidden', message)
}

export function rule(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): DomainError {
  return new DomainError(code, message, details)
}
