import type { ApiErrorBody, ErrorCode } from '../domain/errors'

/** An answer with an error status, in the single error format of SPEC §11.2. */
export class ApiError extends Error {
  readonly status: number
  readonly body: ApiErrorBody
  /** Seconds from `Retry-After`, for 429. */
  readonly retryAfterSeconds: number | null

  constructor(status: number, body: ApiErrorBody, retryAfterSeconds: number | null = null) {
    super(body.message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
    this.retryAfterSeconds = retryAfterSeconds
  }

  get code(): ErrorCode {
    return this.body.code
  }

  get requestId(): string {
    return this.body.request_id
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}
