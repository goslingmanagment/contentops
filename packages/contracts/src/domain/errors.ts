import { z } from 'zod'
import { GenderSchema } from './common'

/**
 * The fixed list of error codes (SPEC §11.2). Domain-rule codes go with 422;
 * the message never carries fan names, order texts or paths.
 */
export const ERROR_CODES = [
  'invalid_request',
  'unauthenticated',
  'forbidden',
  'not_found',
  'idempotency_conflict',
  'version_mismatch',
  'precondition_required',
  'rate_limited',
  'internal',
  'unavailable',
  'accept_blocked',
  'order_closed',
  'order_not_complete',
  'row_marked',
  'row_not_marked',
  'row_cancelled',
  'second_person_onlyfans',
  'batch_rejected',
  'undo_expired',
  'case_resolved',
  'handoff_not_ready',
  'number_not_issued',
] as const

export const ErrorCodeSchema = z.enum(ERROR_CODES)
export type ErrorCode = z.infer<typeof ErrorCodeSchema>

export const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  idempotency_conflict: 409,
  version_mismatch: 412,
  precondition_required: 428,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
  accept_blocked: 422,
  order_closed: 422,
  order_not_complete: 422,
  row_marked: 422,
  row_not_marked: 422,
  row_cancelled: 422,
  second_person_onlyfans: 422,
  batch_rejected: 422,
  undo_expired: 422,
  case_resolved: 422,
  handoff_not_ready: 422,
  number_not_issued: 422,
}

/** One format for every error. */
export const ApiErrorBodySchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  request_id: z.string(),
})
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>

/** `details` of 412: who changed the record, to show «Диана изменила название 1 мин назад». */
export const ConflictDetailsSchema = z.object({
  changed_by: z.string(),
  /** Род для глагола: «Диана изменила», «Никита изменил»; нет — нейтрально. */
  changed_by_gender: GenderSchema.nullable().optional(),
  changed_at: z.string(),
  field: z.string().nullable(),
  current_version: z.int().positive(),
  current_value: z.unknown(),
})
export type ConflictDetails = z.infer<typeof ConflictDetailsSchema>
