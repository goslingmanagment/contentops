import { mkdir, rm } from 'node:fs/promises'
import type { Tx, WorkContext, WorkHandler } from '@contentops/db'
import { createMaster, type MasterAcceptance, type MasterResult } from '@contentops/media'
import { sql } from 'drizzle-orm'
import { locateInput, type MediaInput, saveVideoProbe } from '../inputs'
import type { MediaEnv } from '../pipeline'
import { bindGenerations } from '../renditions'
import { mimeOfExt, shaBytes } from '../storage'
import { registerBlob } from '../storage-ops'
import { asWorkError, inputSha, progressReporter } from './common'

/**
 * `encode_master` (SPEC §9.2, schema §9.2 `master_checks`): the decision, the SVT-AV1 encode
 * when it applies, the full verification and the verdict. The verified master is registered
 * as a blob by the storage protocol; the check row, the draft's master fields and the binding
 * of the first renditions go in the finishing transaction. Accept rules (owner 30.10.2026):
 * an encoded master with `ok`; the source as master after its own decode for `copy`,
 * `skipped_*`, `bigger_than_source` and a failed encode; a broken source that opens only as
 * «Принять как есть»; an unreadable one waits for a replacement.
 */

/** What the draft gets from a verdict. */
export function draftOutcome(acceptance: MasterAcceptance): {
  verified: boolean
  blocked: 'master_failed' | null
} {
  switch (acceptance) {
    case 'master_encoded':
    case 'master_is_source':
      return { verified: true, blocked: null }
    default:
      return { verified: false, blocked: 'master_failed' }
  }
}

async function registerMaster(
  env: MediaEnv,
  input: MediaInput,
  result: MasterResult,
): Promise<Buffer | null> {
  if (result.masterPath && result.masterSha256) {
    await registerBlob(env.db, env.store, {
      file: result.masterPath,
      sha256: result.masterSha256,
      ext: 'mp4',
      mediaKind: 'video',
      mime: 'video/mp4',
      move: true,
      owner: env.owner,
    })
    return shaBytes(result.masterSha256)
  }
  // The source is the master, or kept for «Принять как есть»; unreadable bytes are not kept.
  if (result.acceptance === 'wait_replacement') return null
  if (input.from !== 'blob') {
    await registerBlob(env.db, env.store, {
      file: input.path,
      sha256: input.sha256,
      ext: input.ext,
      mediaKind: 'video',
      mime: mimeOfExt(input.ext),
      owner: env.owner,
    })
  }
  return shaBytes(input.sha256)
}

async function writeCheck(
  tx: Tx,
  ctx: WorkContext,
  sourceSha: Buffer,
  master: Buffer | null,
  result: MasterResult,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO master_checks (
      source_sha256, master_sha256, recipe_digest, work_id, attempt, decision, verdict, enc_ms,
      verify_ms, src_frames, dst_frames, crf, report
    ) VALUES (
      ${sourceSha}, ${master}, ${result.recipeDigest}, ${ctx.work.id}::uuid, ${ctx.work.attemptNo},
      ${result.decision}, ${result.verdict}, ${result.encMs}, ${result.verifyMs}, ${result.srcFrames},
      ${result.dstFrames}, ${result.crf},
      ${JSON.stringify({ acceptance: result.acceptance, master_is_source: result.masterIsSource, ...result.report })}::jsonb
    )
    ON CONFLICT (source_sha256, recipe_digest, work_id, attempt) DO NOTHING`)
}

async function updateDraft(
  tx: Tx,
  ctx: WorkContext,
  master: Buffer | null,
  result: MasterResult,
): Promise<void> {
  if (!ctx.work.draftId || !ctx.work.modelId) return
  const outcome = draftOutcome(result.acceptance)
  await tx.execute(sql`
    UPDATE inbox_drafts
       SET master_sha256 = ${master},
           master_is_source = ${result.masterIsSource},
           master_verified_at = CASE WHEN ${outcome.verified} THEN now() END,
           blocked_reason = CASE
             WHEN ${outcome.blocked}::text IS NOT NULL THEN ${outcome.blocked}
             WHEN blocked_reason = 'master_failed' THEN NULL
             ELSE blocked_reason END,
           error = ${outcome.verified ? null : `master: ${result.verdict}`},
           updated_at = now(), row_version = row_version + 1
     WHERE model_id = ${ctx.work.modelId}::uuid AND id = ${ctx.work.draftId}::uuid
       AND state <> 'resolved'`)
}

interface PreviousMaster {
  checkId: string
  master: Buffer
  masterIsSource: boolean
  acceptance: MasterAcceptance
}

/** A verified master of the same source and recipe whose bytes are still present. */
async function previousMaster(env: MediaEnv, sourceSha: Buffer): Promise<PreviousMaster | null> {
  const { rows } = await env.db.execute<{
    id: string
    master_sha256: Buffer
    acceptance: MasterAcceptance
    master_is_source: boolean
  }>(sql`
    SELECT c.id, c.master_sha256, c.report ->> 'acceptance' AS acceptance,
           coalesce((c.report ->> 'master_is_source')::boolean, false) AS master_is_source
      FROM master_checks c
      JOIN blobs b ON b.sha256 = c.master_sha256 AND b.state = 'present'
     WHERE c.source_sha256 = ${sourceSha} AND c.recipe_digest = ${env.recipes.master.digest}
       AND c.report ->> 'acceptance' IN ('master_encoded', 'master_is_source')
     ORDER BY c.created_at DESC LIMIT 1`)
  const row = rows[0]
  if (!row) return null
  return {
    checkId: row.id,
    master: row.master_sha256,
    masterIsSource: row.master_is_source,
    acceptance: row.acceptance,
  }
}

async function reuseForDraft(tx: Tx, ctx: WorkContext, done: PreviousMaster): Promise<void> {
  if (!ctx.work.draftId || !ctx.work.modelId) return
  await tx.execute(sql`
    UPDATE inbox_drafts
       SET master_sha256 = ${done.master}, master_is_source = ${done.masterIsSource},
           master_verified_at = coalesce(master_verified_at, now()),
           blocked_reason = CASE WHEN blocked_reason = 'master_failed' THEN NULL ELSE blocked_reason END,
           error = NULL, updated_at = now(), row_version = row_version + 1
     WHERE model_id = ${ctx.work.modelId}::uuid AND id = ${ctx.work.draftId}::uuid
       AND state <> 'resolved'`)
}

export function encodeMasterHandler(env: MediaEnv): WorkHandler {
  return async (ctx) => {
    const sourceSha = inputSha(ctx)
    const done = await previousMaster(env, sourceSha)
    if (done) {
      // Same bytes and recipe were already encoded and verified: no second encode.
      return {
        outputSha256: done.master,
        report: { reused_check: done.checkId, acceptance: done.acceptance },
        commit: async (tx) => {
          await reuseForDraft(tx, ctx, done)
          await bindGenerations(tx, sourceSha, done.master)
        },
      }
    }
    const input = await locateInput(env, sourceSha)
    await mkdir(env.store.incomingDir, { recursive: true })
    try {
      const progress = progressReporter(ctx, 'сжимается')
      const result = await createMaster({
        source: input.path,
        outDir: env.store.incomingDir,
        sourceSha256: input.sha256,
        lp: env.lp,
        signal: ctx.signal,
        ...(env.niceness === undefined ? {} : { niceness: env.niceness }),
        versions: env.versions,
        onProgress: (p) =>
          progress(p.phase === 'encode' ? (p.fraction ?? 0) * 0.8 : 0.8 + (p.fraction ?? 0) * 0.2),
      })
      let master: Buffer | null
      try {
        master = await registerMaster(env, input, result)
      } finally {
        if (result.masterPath) await rm(result.masterPath, { force: true })
      }
      const verified = draftOutcome(result.acceptance).verified
      return {
        outputSha256: master,
        report: {
          decision: result.decision,
          verdict: result.verdict,
          acceptance: result.acceptance,
          master_is_source: result.masterIsSource,
          enc_ms: result.encMs,
          verify_ms: result.verifyMs,
          ratio: result.report.ratio,
        },
        commit: async (tx) => {
          if (result.probe)
            await saveVideoProbe(tx, sourceSha, env.recipes.probeVideo.digest, result.probe)
          await writeCheck(tx, ctx, sourceSha, master, result)
          await updateDraft(tx, ctx, master, result)
          if (master && verified) await bindGenerations(tx, sourceSha, master)
        },
      }
    } catch (error) {
      throw asWorkError(error)
    }
  }
}
