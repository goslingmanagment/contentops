import { hostname } from 'node:os'
import type { OriginalsVmFreed } from '@contentops/contracts/domain/originals'
import {
  type Db,
  logAction,
  type Queryable,
  SYSTEM_ACTOR,
  WorkError,
  type WorkHandler,
  withActorTx,
} from '@contentops/db'
import { sql } from 'drizzle-orm'
import { instant } from '../commands'
import type { BlobStore } from '../media/storage'
import { purgeBlob } from '../media/storage-ops'
import { type ConfiguredModel, configuredModels } from './config'
import { originalsSql, reliableSql } from './rule'

/**
 * Work `originals_free` of role `worker`, slot `originals` (SPEC §9.1, §9.4): what leaves the
 * VM's disk. ContentOps itself removes the bytes on its disk that are not a master once their
 * original is reliable — two clouds hold it, checked byte for byte; this replaces the decision of
 * 30.10.2026 «блоб без ссылок удаляет только команда владельца» for such bytes. Every 30 minutes:
 *
 * 1. **web uploads.** A registered upload is held on our disk (`blob_is_referenced`, migration
 *    0030) until the rule releases it: both its copies — MEGA and the model's Dropbox
 *    `Загрузки ContentOps/…`, written by `originals_copy` — checked, and decided (its master
 *    checked and different from the upload's bytes, or no master: rejected, an alias). An upload
 *    whose bytes are the master is never released. In one transaction, with the upload, its draft
 *    and its copies locked and the rule asked again for this upload: `raw_released_at`,
 *    `raw_archive_ref` (the hash and the checked copies: cloud, remote, path, node), and an
 *    unresolved ready draft of the upload stops naming the bytes as its source
 *    (`source_blob_sha256`), so «Скачать исходник» gives its master (`draft-files.ts`); a draft
 *    still being prepared waits;
 * 2. **blobs of reliable originals.** A present blob nobody references whose bytes are those of
 *    a reliable original of a configured model (a revision of its cloud, a released upload) is
 *    removed by the storage protocol under the lock of its hash (`purgeBlob`): references checked
 *    again under the lock — masters, unresolved drafts, unreleased uploads, inputs and outputs of
 *    unfinished works — and the previews built from these bytes and never bound to a master are
 *    kept while a draft of them still shows them (`kept`). The derivatives of a master are bound
 *    to the master's hash and never go with the source. Blobs whose original is unknown or not
 *    reliable stay: the owner's `purge-blobs` (§9.1).
 *
 * Actor `worker:originals`; each release and each removal is a line of `action_log`, the removal
 * also a `storage_operations` row whose owner starts with `worker:originals:`. Nothing is read
 * from the clouds: the ledger decides. A second run changes nothing.
 */

export const FREE_INTERVAL_MS = 30 * 60_000
export const freeStreamKey = 'originals-free'
export const FREED_BY = 'worker:originals'

export interface FreeReport {
  /** Uploads whose bytes were let go now (`raw_released_at`). */
  released: number
  /** Their drafts that now give the master as the source. */
  drafts_on_master: number
  /** Blobs of reliable originals removed from our disk, and their bytes. */
  removed: number
  removed_bytes: number
  /** Blobs of reliable originals that stay, by why (`failed` — the file step broke: next run). */
  kept: { referenced: number; previews: number; busy: number; gone: number; failed: number }
}

interface Removable extends Record<string, unknown> {
  sha: string
  bytes: string
  model_id: string
  label: string
}

/** Uploads of the model the rule releases now. */
async function releasableUploads(q: Queryable, model: ConfiguredModel): Promise<string[]> {
  const { rows } = await q.execute<{ id: string }>(sql`
    SELECT o.id FROM (${originalsSql(model.id, [], { uploads: 'all' })}) o
     WHERE o.releasable AND NOT o.is_master AND NOT o.released
     ORDER BY o.id`)
  return rows.map((row) => row.id)
}

interface Copy extends Record<string, unknown> {
  place: string
  remote: string | null
  path: string
  object_ref: string | null
  verified_at: string
}

async function releaseUpload(
  db: Db,
  model: ConfiguredModel,
  uploadId: string,
  workId: string | null,
): Promise<{ released: boolean; drafts: number }> {
  const none = { released: false, drafts: 0 }
  return withActorTx(
    db,
    {
      actor: SYSTEM_ACTOR(FREED_BY),
      action: 'originals.release',
      requestId: `originals-free:${workId ?? 'now'}:${uploadId}`,
      workId,
    },
    async (tx) => {
      const { rows: uploads } = await tx.execute<{ name: string; sha: string }>(sql`
        SELECT client_filename AS name, encode(sha256, 'hex') AS sha FROM web_uploads
         WHERE model_id = ${model.id}::uuid AND id = ${uploadId}::uuid AND state = 'registered'
           AND raw_released_at IS NULL AND sha256 IS NOT NULL
         FOR UPDATE`)
      const upload = uploads[0]
      if (!upload) return none
      // The draft and the copies hold still while the rule is asked again.
      const { rows: drafts } = await tx.execute<{ state: string }>(sql`
        SELECT state FROM inbox_drafts
         WHERE model_id = ${model.id}::uuid AND web_upload_id = ${uploadId}::uuid
         FOR UPDATE`)
      if (drafts.some((draft) => draft.state === 'discovered' || draft.state === 'processing')) {
        return none
      }
      const { rows: copies } = await tx.execute<Copy>(sql`
        SELECT place, remote, path, object_ref, verified_at::text AS verified_at
          FROM original_copies
         WHERE model_id = ${model.id}::uuid AND web_upload_id = ${uploadId}::uuid
           AND verified_at IS NOT NULL AND missing_since IS NULL
         ORDER BY place
         FOR SHARE`)
      const { rows: judged } = await tx.execute<{ ok: boolean }>(sql`
        SELECT o.releasable AND NOT o.is_master AND NOT o.released AS ok
          FROM (${originalsSql(model.id, [], { uploads: [uploadId] })}) o`)
      if (judged[0]?.ok !== true || new Set(copies.map((copy) => copy.place)).size < 2) {
        return none
      }
      const archive = JSON.stringify({
        sha256: upload.sha,
        copies: copies.map((copy) => ({
          place: copy.place,
          remote: copy.remote,
          path: copy.path,
          object_ref: copy.object_ref,
          verified_at: copy.verified_at,
        })),
      })
      await tx.execute(sql`
        UPDATE web_uploads SET raw_released_at = now(), raw_archive_ref = ${archive}
         WHERE model_id = ${model.id}::uuid AND id = ${uploadId}::uuid`)
      const { rowCount } = await tx.execute(sql`
        UPDATE inbox_drafts d
           SET source_blob_sha256 = NULL, updated_at = now(), row_version = d.row_version + 1
         WHERE d.model_id = ${model.id}::uuid AND d.web_upload_id = ${uploadId}::uuid
           AND d.state = 'ready' AND d.source_blob_sha256 = decode(${upload.sha}, 'hex')
           AND d.master_verified_at IS NOT NULL AND d.master_sha256 IS NOT NULL
           AND d.master_sha256 <> d.source_blob_sha256
           AND EXISTS (SELECT 1 FROM blobs b
                        WHERE b.sha256 = d.master_sha256 AND b.state = 'present')`)
      const places = copies.map((copy) => (copy.place === 'mega' ? 'MEGA' : 'Dropbox'))
      await logAction(tx, {
        modelId: model.id,
        subjectKind: 'web_upload',
        subjectId: uploadId,
        subjectLabel: upload.name,
        before: { Исходник: 'на диске ВМ' },
        after: {
          Исходник: `в ${places.join(' и ')}, проверен`,
          ...(rowCount ? { Черновик: 'отдаёт мастер' } : {}),
        },
      })
      return { released: true, drafts: rowCount ?? 0 }
    },
  )
}

/** Present blobs nobody references whose bytes are a reliable original's. */
async function removableBlobs(q: Queryable, models: readonly string[]): Promise<Removable[]> {
  const ids = sql.param([...models])
  const { rows } = await q.execute<Removable>(sql`
    WITH known AS (
      SELECT r.model_id, r.source_sha256 AS sha, COALESCE(r.frozen_path, o.current_path) AS label
        FROM blobs b
        JOIN source_revisions r ON r.source_sha256 = b.sha256
        JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
       WHERE b.state = 'present' AND r.model_id = ANY (${ids}::uuid[])
         AND ${reliableSql(sql`r.model_id`, { revision: sql`r.id` })}
      UNION ALL
      SELECT u.model_id, u.sha256, u.client_filename
        FROM blobs b
        JOIN web_uploads u ON u.sha256 = b.sha256
       WHERE b.state = 'present' AND u.model_id = ANY (${ids}::uuid[])
         AND u.state = 'registered' AND u.raw_released_at IS NOT NULL
         AND ${reliableSql(sql`u.model_id`, { upload: sql`u.id` })}
    )
    SELECT DISTINCT ON (b.sha256) encode(b.sha256, 'hex') AS sha, b.byte_size::text AS bytes,
           k.model_id, k.label
      FROM known k JOIN blobs b ON b.sha256 = k.sha AND b.state = 'present'
     WHERE NOT blob_is_referenced(b.sha256)
     ORDER BY b.sha256, k.label`)
  return rows
}

/**
 * Previews built from these bytes before any master and never bound to one, while a draft of
 * the bytes still shows them (not rejected, not an alias): `purgeBlob` would take them with it.
 */
async function previewsNeeded(tx: Queryable, sha: Buffer): Promise<boolean> {
  const { rows } = await tx.execute<{ needed: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM rendition_generations g
       WHERE g.input_sha256 = ${sha} AND g.master_sha256 IS NULL
         AND g.state IN ('building', 'ready')
         AND EXISTS (SELECT 1 FROM inbox_drafts d
                      WHERE d.source_sha256 = ${sha}
                        AND NOT (d.state = 'resolved' AND d.outcome IN ('rejected', 'alias')))
    ) AS needed`)
  return rows[0]?.needed === true
}

/** One pass: what is released and removed; the run itself or `ops.js originals free`. */
export async function freeOriginals(
  db: Db,
  store: BlobStore,
  options: { workId?: string | null; signal?: AbortSignal } = {},
): Promise<FreeReport> {
  const report: FreeReport = {
    released: 0,
    drafts_on_master: 0,
    removed: 0,
    removed_bytes: 0,
    kept: { referenced: 0, previews: 0, busy: 0, gone: 0, failed: 0 },
  }
  const { models } = await configuredModels(db)
  if (models.length === 0) return report
  for (const model of models) {
    for (const id of await releasableUploads(db, model)) {
      options.signal?.throwIfAborted()
      const done = await releaseUpload(db, model, id, options.workId ?? null)
      if (done.released) report.released += 1
      report.drafts_on_master += done.drafts
    }
  }
  const owner = `${FREED_BY}:${hostname()}:${process.pid}`
  for (const blob of await removableBlobs(
    db,
    models.map((model) => model.id),
  )) {
    options.signal?.throwIfAborted()
    let outcome: Awaited<ReturnType<typeof purgeBlob>> | 'failed'
    try {
      outcome = await purgeBlob(db, store, blob.sha, owner, { keep: previewsNeeded })
    } catch {
      // The operation is `failed` in `storage_operations`; the blob is tried again next run.
      outcome = 'failed'
    }
    switch (outcome) {
      case 'purged':
        report.removed += 1
        report.removed_bytes += Number(blob.bytes)
        await withActorTx(
          db,
          {
            actor: SYSTEM_ACTOR(FREED_BY),
            action: 'originals.remove',
            requestId: `originals-free:${options.workId ?? 'now'}:${blob.sha}`,
            workId: options.workId ?? null,
          },
          (tx) =>
            logAction(tx, {
              modelId: blob.model_id,
              subjectKind: 'blob',
              subjectLabel: blob.label.slice(blob.label.lastIndexOf('/') + 1) || blob.label,
              after: {
                Байты: 'удалены с диска ВМ',
                Размер: `${(Number(blob.bytes) / 1e6).toFixed(1)} МБ`,
              },
            }),
        )
        break
      case 'referenced':
        report.kept.referenced += 1
        break
      case 'kept':
        report.kept.previews += 1
        break
      case 'busy':
        report.kept.busy += 1
        break
      case 'not_present':
        report.kept.gone += 1
        break
      case 'failed':
        report.kept.failed += 1
        break
    }
  }
  return report
}

export function originalsFreeHandler(options: { store: BlobStore | null }): WorkHandler {
  return async ({ work, db, signal }) => {
    if (!options.store) {
      throw new WorkError('permanent', 'not_configured', 'no blob store in this role')
    }
    return { report: await freeOriginals(db, options.store, { workId: work.id ?? null, signal }) }
  }
}

/**
 * What the VM has removed from its data disk so far (`admin.originalsVmFreed`, SPEC §12.2): the
 * committed removals of the storage protocol — by the release of the originals and by the owner's
 * `purge-blobs` — with the bytes of each. The nightly compaction of the PC compares it with what
 * it saw at its last compaction of `data.vhdx`.
 */
export async function vmFreed(q: Queryable): Promise<OriginalsVmFreed> {
  const { rows } = await q.execute<{
    blobs: number
    bytes: string
    originals: string
    last: string | null
  }>(sql`
    SELECT count(*)::int AS blobs, COALESCE(sum(b.byte_size), 0)::text AS bytes,
           COALESCE(sum(b.byte_size) FILTER (WHERE o.owner LIKE ${`${FREED_BY}:%`}), 0)::text
             AS originals,
           max(o.finished_at)::text AS last
      FROM storage_operations o JOIN blobs b ON b.sha256 = o.blob_sha256
     WHERE o.kind = 'purge' AND o.state = 'committed'`)
  const row = rows[0]
  return {
    removed_blobs: row?.blobs ?? 0,
    removed_bytes: Number(row?.bytes ?? 0),
    originals_bytes: Number(row?.originals ?? 0),
    last_removed_at: row?.last ? instant(row.last) : null,
  }
}
