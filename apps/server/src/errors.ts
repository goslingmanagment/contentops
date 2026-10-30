import {
  type ApiErrorBody,
  type ErrorCode,
  HTTP_STATUS_BY_CODE,
} from '@contentops/contracts/domain/errors'
import type { FastifyError } from 'fastify'

/**
 * A refusal a handler throws: the code from the fixed list (SPEC §11.2) decides the status.
 * The message never carries fan names, order texts or paths.
 */
export class ApiProblem extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details: Record<string, unknown> | undefined
  /** Seconds for `Retry-After`, with 429. */
  readonly retryAfterSeconds: number | null

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    retryAfterSeconds: number | null = null,
  ) {
    super(message)
    this.name = 'ApiProblem'
    this.code = code
    this.status = HTTP_STATUS_BY_CODE[code]
    this.details = details
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export interface ErrorReply {
  status: number
  body: ApiErrorBody
  retryAfterSeconds: number | null
}

const VALIDATION_MESSAGE: Record<string, string> = {
  body: 'Неверное тело запроса',
  querystring: 'Неверные параметры запроса',
  params: 'Неверный адрес',
  headers: 'Неверные заголовки запроса',
}

/** Issues as `path: message`, the same shape the mock server gave. */
export function issueLines(issues: readonly { path: string; message: string }[]): string[] {
  return issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
}

export function invalidRequest(
  where: keyof typeof VALIDATION_MESSAGE,
  issues: readonly { path: string; message: string }[],
): ApiProblem {
  return new ApiProblem('invalid_request', VALIDATION_MESSAGE[where] ?? 'Неверный запрос', {
    in: where,
    issues: issueLines(issues),
  })
}

/** Statuses Fastify itself answers with, mapped onto the fixed codes. */
const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: 'invalid_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  429: 'rate_limited',
  503: 'unavailable',
}

const FRAMEWORK_MESSAGE: Record<number, string> = {
  400: 'Неверный запрос',
  404: 'Нет такого адреса',
  413: 'Слишком большой запрос',
  415: 'Неподдерживаемый тип тела запроса',
}

function isFastifyError(error: unknown): error is FastifyError {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
}

/** Every failure becomes `{code, message, details?, request_id}`; 5xx never show the cause. */
export function toErrorReply(error: unknown, requestId: string): ErrorReply {
  if (error instanceof ApiProblem) {
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
        request_id: requestId,
      },
      retryAfterSeconds: error.retryAfterSeconds,
    }
  }
  if (isFastifyError(error) && error.validation) {
    const where = error.validationContext ?? 'body'
    const issues = error.validation.map((issue) => ({
      path: issue.instancePath.replace(/^\//, '').replaceAll('/', '.'),
      message: issue.message ?? issue.keyword,
    }))
    return toErrorReply(invalidRequest(where, issues), requestId)
  }
  const status = isFastifyError(error) ? (error.statusCode ?? 500) : 500
  if (status >= 400 && status < 500) {
    return {
      status,
      body: {
        code: CODE_BY_STATUS[status] ?? 'invalid_request',
        message: FRAMEWORK_MESSAGE[status] ?? 'Неверный запрос',
        details: { reason: (error as FastifyError).code },
        request_id: requestId,
      },
      retryAfterSeconds: null,
    }
  }
  return {
    status: 500,
    body: { code: 'internal', message: 'Внутренняя ошибка сервера', request_id: requestId },
    retryAfterSeconds: null,
  }
}
