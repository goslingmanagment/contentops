import type { Queryable } from '@contentops/db'
import type { MarkupType, ProviderName } from '@contentops/vision'
import { sql } from 'drizzle-orm'

/**
 * When a provider gets nothing more until the owner looks into it (SPEC §8.3): its key or account
 * was refused (401, 403, 402, a quota) — for every route; or the breaker: of the last 30 objects
 * of a type it answered, 20 % or more were refused. Both are counted from the runs after the
 * owner's last «Включить» (`annotation.resumed.<provider>`); measurement runs do not move the
 * breaker, a refused key stops the provider whatever run met it.
 */

export const BREAKER_OBJECTS = 30
export const BREAKER_SHARE = 0.2

export interface ProviderStop {
  /** `key` — the key or the account was refused; `breaker` — too many refusals of a type. */
  kind: 'key' | 'breaker'
  reason: string
  since: string
}

export async function providerStop(
  q: Queryable,
  provider: ProviderName,
  type: MarkupType,
  resumedAt: string | null,
): Promise<ProviderStop | null> {
  const { rows: refused } = await q.execute<{ since: string | null }>(sql`
    SELECT min(finished_at)::text AS since FROM annotation_runs
     WHERE provider = ${provider} AND error_code = 'auth_rejected'
       AND finished_at > coalesce(${resumedAt}::timestamptz, '-infinity'::timestamptz)`)
  const since = refused[0]?.since
  if (since) return { kind: 'key', reason: 'ключ или аккаунт не приняты', since }
  const { rows } = await q.execute<{ n: number; refused: number; since: string | null }>(sql`
    WITH per_item AS (
      SELECT DISTINCT ON (r.model_id, r.item_id) r.state, r.finished_at
        FROM annotation_runs r
        JOIN content_items i ON i.model_id = r.model_id AND i.id = r.item_id
       WHERE r.provider = ${provider} AND NOT r.probe AND i.type = ${type}
         AND r.state IN ('succeeded', 'partial', 'refused')
         AND r.finished_at > coalesce(${resumedAt}::timestamptz, '-infinity'::timestamptz)
       ORDER BY r.model_id, r.item_id, r.finished_at DESC
    ), last AS (
      SELECT * FROM per_item ORDER BY finished_at DESC LIMIT ${BREAKER_OBJECTS}
    )
    SELECT count(*)::int AS n, count(*) FILTER (WHERE state = 'refused')::int AS refused,
           max(finished_at)::text AS since
      FROM last`)
  const last = rows[0]
  if (!last || last.n < BREAKER_OBJECTS || last.refused / last.n < BREAKER_SHARE) return null
  return {
    kind: 'breaker',
    reason: `много отказов (${Math.round((last.refused / last.n) * 100)} % на ${last.n} объектах ${type})`,
    since: last.since ?? new Date().toISOString(),
  }
}
