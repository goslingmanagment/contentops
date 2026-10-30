import { sql } from 'drizzle-orm'
import type { Queryable, Tx } from './client.ts'
import { type ContentType, queueSwitchKey, type WorkQueue, workQueues } from './values.ts'

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

/**
 * Queues the owner holds with «Пауза» (`queue.<queue>` = `false`, global rows only). A queue
 * runs without a row: media processing is core, not an integration (SPEC §8).
 */
export async function pausedQueues(q: Queryable): Promise<Set<WorkQueue>> {
  const keys = workQueues.map(queueSwitchKey)
  const { rows } = await q.execute<{ key: string }>(sql`
    SELECT key FROM policy_settings
     WHERE key = ANY (${sql.param(keys)}::text[])
       AND model_id IS NULL AND item_type IS NULL AND value = 'false'::jsonb`)
  return new Set(
    workQueues.filter((queue) => rows.some((row) => row.key === queueSwitchKey(queue))),
  )
}

/**
 * «Пауза» / «Продолжить» of a queue: one global `policy_settings` row (the journal trigger
 * writes author, before and after). Resuming makes the held works due at once. Inside the
 * caller's transaction with the journal context; a repeat changes nothing.
 */
export async function setQueuePaused(
  tx: Tx,
  queue: WorkQueue,
  paused: boolean,
  by: string | null,
): Promise<void> {
  const key = queueSwitchKey(queue)
  const value = JSON.stringify(!paused)
  await tx.execute(sql`
    INSERT INTO policy_settings (key, value, updated_by)
    VALUES (${key}, ${value}::jsonb, ${by}::uuid)
    ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE
       SET value = excluded.value, updated_by = excluded.updated_by, updated_at = now(),
           row_version = policy_settings.row_version + 1
     WHERE policy_settings.value IS DISTINCT FROM excluded.value`)
  if (!paused) await resumeSwitch(tx, key)
}
