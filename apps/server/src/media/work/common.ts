import type { Queryable, WorkContext } from '@contentops/db'
import { WorkError } from '@contentops/db'
import { MediaAbortError, ToolError, UnreadableMediaError } from '@contentops/media'
import { sql } from 'drizzle-orm'

/** `checkpoint` at most every few seconds while a tool reports progress. */
export function progressReporter(ctx: WorkContext, note: string, everyMs = 5_000) {
  let last = 0
  let pending: Promise<void> = Promise.resolve()
  return (fraction: number | null) => {
    const now = Date.now()
    if (now - last < everyMs) return
    last = now
    const num = fraction === null ? 0 : Math.round(Math.min(1, Math.max(0, fraction)) * 1000)
    pending = pending
      .then(() => ctx.checkpoint({ progress: { num, den: 1000, note } }))
      .catch(() => undefined)
  }
}

/** The input hash of a media work; a row without it is a programming error. */
export function inputSha(ctx: WorkContext): Buffer {
  const sha = ctx.work.inputSha256
  if (!sha) throw new WorkError('permanent', 'no_input', `${ctx.work.kind} without input_sha256`)
  return sha
}

/**
 * Library errors as work failures: a file the tools cannot read will not get better on a
 * retry; a tool crash may (memory, a killed process).
 */
export function asWorkError(error: unknown): unknown {
  if (error instanceof WorkError || error instanceof MediaAbortError) return error
  if (error instanceof UnreadableMediaError) {
    return new WorkError('permanent', 'unreadable', error.message, { cause: error })
  }
  if (error instanceof ToolError) {
    return new WorkError('transient', 'tool_failed', error.message, { cause: error })
  }
  return error
}

/** The model of a work, for rows that need it (it is fixed on the row). */
export function modelOf(ctx: WorkContext): string {
  const model = ctx.work.modelId
  if (!model) throw new WorkError('permanent', 'no_model', `${ctx.work.kind} without a model`)
  return model
}

/** Verified master of a source, when intake or a version already has one. */
export async function masterOfSource(q: Queryable, sourceSha: Buffer): Promise<Buffer | null> {
  const { rows } = await q.execute<{ master: Buffer }>(sql`
    SELECT master_sha256 AS master FROM inbox_drafts
     WHERE source_sha256 = ${sourceSha} AND master_verified_at IS NOT NULL
    UNION ALL
    SELECT master_sha256 FROM asset_versions WHERE source_sha256 = ${sourceSha}
    LIMIT 1`)
  return rows[0]?.master ?? null
}
