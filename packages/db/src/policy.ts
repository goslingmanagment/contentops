import { sql } from 'drizzle-orm'
import type { Queryable } from './client.ts'
import type { ContentType } from './values.ts'

/** The area a setting applies to; the levels run from global down to this scope. */
export interface PolicyScope {
  modelId?: string | null
  accountId?: string | null
  itemType?: ContentType | null
}

/**
 * Kill switch rule (SPEC §8, schema §9.2): on only when some level from global down to the
 * scope says `true` and none says `false`; no row or SQL NULL — not set, i.e. off.
 */
export async function isSwitchOn(
  q: Queryable,
  key: string,
  scope: PolicyScope = {},
): Promise<boolean> {
  const { rows } = await q.execute<{ on: boolean }>(sql`
    SELECT coalesce(bool_or(value = 'true'::jsonb), false)
           AND NOT coalesce(bool_or(value = 'false'::jsonb), false) AS on
      FROM policy_settings
     WHERE key = ${key}
       AND (model_id IS NULL OR model_id = ${scope.modelId ?? null}::uuid)
       AND (account_id IS NULL OR account_id = ${scope.accountId ?? null}::uuid)
       AND (item_type IS NULL OR item_type = ${scope.itemType ?? null})`)
  return rows[0]?.on === true
}

/**
 * Turning a switch back on releases the works it paused (schema §9.2): the reason goes
 * away and they are due at once. Works still off elsewhere are paused again on claim.
 */
export async function resumeSwitch(q: Queryable, key: string): Promise<number> {
  const result = await q.execute(sql`
    UPDATE work_operations
       SET paused_reason = NULL, next_attempt_at = now()
     WHERE paused_reason = ${`switch_off:${key}`}
       AND state IN ('pending', 'retry_wait')`)
  return result.rowCount ?? 0
}
