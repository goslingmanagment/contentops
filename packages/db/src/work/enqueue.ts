import { sql } from 'drizzle-orm'
import type { Queryable } from '../client.ts'
import type { WorkKind } from '../values.ts'
import { toWorkRow, type WorkRow } from './row.ts'

export interface EnqueueInput {
  /** `null` only for system-wide kinds (`verify_blobs`, `backup`). */
  modelId: string | null
  kind: WorkKind
  /** Natural key: `fetch:<revision>`, `master:<source_sha>:<recipe>`; a repeat finds the row. */
  workKey: string
  /** Higher runs first. */
  priority?: number
  accountId?: string | null
  dataset?: string | null
  scope?: string | null
  windowFrom?: string | null
  windowTo?: string | null
  pipelineVersion?: string | null
  recipeDigest?: string | null
  inputSha256?: Buffer | null
  /** Stream of a periodic work: at most one unfinished row per stream. */
  streamKey?: string | null
}

export interface EnqueueResult {
  work: WorkRow
  /** `false` — the same work already existed (or its stream is busy). */
  created: boolean
}

/**
 * Puts a work into `work_operations` inside the caller's transaction, next to the domain
 * write it belongs to (schema §3.4). UNIQUE `(model_id, kind, work_key)` NULLS NOT
 * DISTINCT makes a repeat return the existing row; a busy stream returns its unfinished row.
 */
export async function enqueueWork(q: Queryable, input: EnqueueInput): Promise<EnqueueResult> {
  const inserted = await q.execute(sql`
    INSERT INTO work_operations (
      model_id, kind, work_key, priority, account_id, dataset, scope, window_from, window_to,
      pipeline_version, recipe_digest, input_sha256, stream_key
    ) VALUES (
      ${input.modelId}::uuid, ${input.kind}, ${input.workKey}, ${input.priority ?? 0},
      ${input.accountId ?? null}::uuid, ${input.dataset ?? null}, ${input.scope ?? null},
      ${input.windowFrom ?? null}::timestamptz, ${input.windowTo ?? null}::timestamptz,
      ${input.pipelineVersion ?? null}, ${input.recipeDigest ?? null},
      ${input.inputSha256 ?? null}::bytea, ${input.streamKey ?? null}
    )
    ON CONFLICT DO NOTHING
    RETURNING *`)
  const [created] = inserted.rows
  if (created) return { work: toWorkRow(created), created: true }

  const existing = await q.execute(sql`
    SELECT * FROM work_operations
     WHERE model_id IS NOT DISTINCT FROM ${input.modelId}::uuid
       AND kind = ${input.kind} AND work_key = ${input.workKey}`)
  const [same] = existing.rows
  if (same) return { work: toWorkRow(same), created: false }

  if (input.streamKey) {
    const stream = await q.execute(sql`
      SELECT * FROM work_operations
       WHERE model_id IS NOT DISTINCT FROM ${input.modelId}::uuid
         AND kind = ${input.kind} AND stream_key = ${input.streamKey}
         AND state IN ('pending', 'running', 'retry_wait')`)
    const [busy] = stream.rows
    if (busy) return { work: toWorkRow(busy), created: false }
  }
  throw new Error(`enqueueWork: ${input.kind} ${input.workKey} conflicted but no row is visible`)
}
