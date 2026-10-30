import type { Queryable } from '@contentops/db'
import { dbErrorCode } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { ApiProblem } from '../errors'

/** Model ids by codes; an unknown code is the caller's mistake, not a missing object. */
export async function modelsByCodes(
  q: Queryable,
  codes: readonly string[],
): Promise<{ id: string; code: string; name: string }[]> {
  if (codes.length === 0) return []
  const { rows } = await q.execute<{ id: string; code: string; name: string }>(sql`
    SELECT id, code, title AS name FROM models
     WHERE code = ANY(${sql.param([...new Set(codes)])}::text[]) AND archived_at IS NULL
     ORDER BY id`)
  const missing = codes.filter((code) => !rows.some((row) => row.code === code))
  if (missing.length > 0) {
    throw new ApiProblem('invalid_request', 'Такой модели нет', { models: missing })
  }
  return rows
}

/** «Лора, Lily» in model order; nothing — «нет». */
export async function modelNames(q: Queryable, codes: readonly string[]): Promise<string> {
  const models = await modelsByCodes(q, codes)
  return models.map((model) => model.name).join(', ') || 'нет'
}

/**
 * A unique or check violation of a command is a 400 with the field, not a 500: «Такой логин
 * уже есть». Anything else goes on.
 */
export async function withFieldErrors<T>(
  run: () => Promise<T>,
  fields: Record<string, { field: string; message: string }>,
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const code = dbErrorCode(error)
    if (code === '23505' || code === '23514') {
      const constraint = constraintOf(error)
      const known = constraint ? fields[constraint] : undefined
      if (known) {
        throw new ApiProblem('invalid_request', known.message, { field: known.field })
      }
    }
    throw error
  }
}

function constraintOf(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const constraint = (current as { constraint?: unknown }).constraint
    if (typeof constraint === 'string') return constraint
  }
  return undefined
}
