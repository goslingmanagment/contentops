import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { ApiProblem } from '../errors'
import type { DbItemType } from './ids'

/**
 * The next public number of a type in a model (SPEC §4.1, schema §4.2): the counter row is
 * locked by the update, so two commands never get the same number, and a rolled-back command
 * gives its number back. A type with legacy numbers issues nothing until the legacy pass of
 * stage 3 has reserved them (`legacy_reserved_at`, schema §9.3).
 */
export async function issueNumber(
  q: Queryable,
  modelId: string,
  type: DbItemType,
  options: { legacyCheck?: boolean } = {},
): Promise<number> {
  const { rows } = await q.execute<{ number: number; reserved: boolean }>(sql`
    UPDATE id_counters SET next_number = next_number + 1, updated_at = now()
     WHERE model_id = ${modelId}::uuid AND type = ${type}
       ${options.legacyCheck === false ? sql`` : sql`AND legacy_reserved_at IS NOT NULL`}
    RETURNING next_number - 1 AS number, legacy_reserved_at IS NOT NULL AS reserved`)
  const row = rows[0]
  if (!row) {
    throw new ApiProblem(
      'number_not_issued',
      `Номера ${type} ещё не сверены со старыми (этап 3): новый номер не выдаётся`,
      { type },
    )
  }
  return row.number
}

/** A number given explicitly (fixtures, legacy): the counter moves past it. */
export async function claimNumber(
  q: Queryable,
  modelId: string,
  type: DbItemType,
  number: number,
): Promise<void> {
  await q.execute(sql`
    UPDATE id_counters SET next_number = greatest(next_number, ${number + 1}), updated_at = now()
     WHERE model_id = ${modelId}::uuid AND type = ${type}`)
}
