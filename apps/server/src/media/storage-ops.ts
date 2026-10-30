import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type Db, dbErrorCode, type Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { type BlobStore, blobKey, mimeOfExt, sha256OfFile, shaBytes, shaHex } from './storage'

/**
 * File operations on bytes (schema §3.3 `storage_operations`, §9.3 «Операции с файлами»):
 * (1) intent under the row lock of the blob, committed; (2) `started` committed before any
 * file action, the idempotent step, `fs_done`; (3) the outcome, `blobs.state` and dependent
 * states in one commit. A crash between (2) and (3) leaves an intent that `reconcile`
 * settles against the disk before the role claims any work.
 */

export type MediaKindDb = 'video' | 'image'

export interface RegisterInput {
  /** Verified bytes: a temp file in `.incoming/`, a staged source, an encoder output. */
  file: string
  sha256: string
  ext: string
  mediaKind: MediaKindDb
  mime?: string
  /** Remove `file` after success (an encoder output); a staged source is copied. */
  move?: boolean
  /** Holder of the operation: `<role>:<host>:<pid>:…`; reconcile matches by role prefix. */
  owner: string
}

export interface RegisteredBlob {
  sha256: string
  key: string
  bytes: number
  /** `false` — the same bytes were already present. */
  created: boolean
}

export class StorageBusyError extends Error {
  constructor(sha: string) {
    super(`another storage operation on ${sha} is in progress`)
    this.name = 'StorageBusyError'
  }
}

interface BlobRow extends Record<string, unknown> {
  state: string
  storage_key: string
  byte_size: string | number
}

async function blobRow(q: Queryable, sha: Buffer, lock: boolean): Promise<BlobRow | undefined> {
  const { rows } = await q.execute<BlobRow>(sql`
    SELECT state, storage_key, byte_size FROM blobs WHERE sha256 = ${sha}
    ${lock ? sql`FOR UPDATE` : sql``}`)
  return rows[0]
}

async function setOperation(
  q: Queryable,
  id: string,
  state: 'started' | 'fs_done' | 'committed' | 'failed' | 'cancelled',
  error?: string,
): Promise<void> {
  await q.execute(sql`
    UPDATE storage_operations
       SET state = ${state},
           started_at = CASE WHEN ${state} = 'started' THEN now() ELSE started_at END,
           finished_at = CASE WHEN ${state} IN ('committed', 'failed', 'cancelled') THEN now() END,
           error = coalesce(${error ?? null}, error)
     WHERE id = ${id}::uuid`)
}

/**
 * Registers bytes as a blob (`storage_operations.put`, schema §3.3): the blob row appears
 * with `state = 'present'` only after the file is in place and fsynced. Bytes already
 * present return at once; a `purged`, `missing` or `corrupt` row comes back to `present`.
 */
export async function registerBlob(
  db: Db,
  store: BlobStore,
  input: RegisterInput,
): Promise<RegisteredBlob> {
  const sha = shaBytes(input.sha256)
  const hex = shaHex(sha)
  const key = blobKey(sha, input.ext)
  const mime = input.mime ?? mimeOfExt(input.ext)

  // (1) intent under the row lock of the blob.
  const intent = await db.transaction(async (tx) => {
    const row = await blobRow(tx, sha, true)
    if (row?.state === 'present' && (await store.exists(row.storage_key))) {
      return { done: row }
    }
    try {
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO storage_operations (kind, blob_sha256, from_key, to_key, owner)
        VALUES ('put', ${sha}, NULL, ${row?.storage_key ?? key}, ${input.owner})
        RETURNING id`)
      return { id: rows[0]?.id as string, existing: row }
    } catch (error) {
      if (dbErrorCode(error) === '23505') throw new StorageBusyError(hex)
      throw error
    }
  })
  if ('done' in intent && intent.done) {
    if (input.move) await rm(input.file, { force: true })
    const done = intent.done
    return { sha256: hex, key: done.storage_key, bytes: Number(done.byte_size), created: false }
  }
  if (!('id' in intent) || !intent.id) throw new Error('storage intent without an id')
  const operationId = intent.id
  const targetKey = intent.existing?.storage_key ?? key

  // (2) started, the file step, fs_done — each committed on its own.
  await setOperation(db, operationId, 'started')
  let bytes: number
  try {
    if (intent.existing && intent.existing.storage_key !== key) {
      // A row keeps its first key forever (`blobs_fixed`); the bytes go back under it.
      const ext = intent.existing.storage_key.split('.').pop() as string
      bytes = (
        await store.put(input.file, { sha256: hex, ext, move: input.move, tempName: operationId })
      ).bytes
    } else {
      bytes = (
        await store.put(input.file, {
          sha256: hex,
          ext: input.ext,
          move: input.move,
          tempName: operationId,
        })
      ).bytes
    }
  } catch (error) {
    await setOperation(db, operationId, 'failed', String((error as Error).message ?? error))
    throw error
  }
  await setOperation(db, operationId, 'fs_done')

  // (3) the outcome and the blob row in one commit.
  await db.transaction(async (tx) => {
    await blobRow(tx, sha, true)
    await upsertPresent(tx, {
      sha,
      bytes,
      mime,
      ext: input.ext,
      mediaKind: input.mediaKind,
      key: targetKey,
    })
    await setOperation(tx, operationId, 'committed')
  })
  return { sha256: hex, key: targetKey, bytes, created: !intent.existing }
}

async function upsertPresent(
  q: Queryable,
  blob: {
    sha: Buffer
    bytes: number
    mime: string
    ext: string
    mediaKind: MediaKindDb
    key: string
  },
): Promise<void> {
  await q.execute(sql`
    INSERT INTO blobs (sha256, byte_size, mime, ext, media_kind, storage_key, state, verified_at)
    VALUES (${blob.sha}, ${blob.bytes}, ${blob.mime}, ${blob.ext}, ${blob.mediaKind}, ${blob.key},
            'present', now())
    ON CONFLICT (sha256) DO UPDATE
       SET state = 'present', purged_at = NULL, verified_at = now()`)
}

/**
 * Locks a blob for a new reference (schema §9.3 «Создание ссылки на байты»): the row lock
 * and `state = 'present'` with no purge in progress; otherwise the reference is refused.
 */
export async function lockBlobForReference(q: Queryable, sha: Buffer | string): Promise<boolean> {
  const { rows } = await q.execute<{ ok: boolean }>(sql`
    SELECT b.state = 'present' AND NOT EXISTS (
             SELECT 1 FROM storage_operations o
              WHERE o.blob_sha256 = b.sha256 AND o.kind = 'purge'
                AND o.state IN ('intent', 'started', 'fs_done')) AS ok
      FROM blobs b WHERE b.sha256 = ${shaBytes(sha)} FOR SHARE`)
  return rows[0]?.ok === true
}

export type PurgeOutcome = 'purged' | 'referenced' | 'not_present' | 'busy'

/**
 * The owner's removal of a blob without references (schema §5 «Удаление байтов»): the
 * reference check runs under the row lock in (1) and again in (3). Derivatives of the blob
 * as a master go with it; the `blobs` row stays with `state = 'purged'`.
 */
export async function purgeBlob(
  db: Db,
  store: BlobStore,
  sha256: string,
  owner: string,
  options: { afterFiles?: () => Promise<void> } = {},
): Promise<PurgeOutcome> {
  const sha = shaBytes(sha256)
  const intent = await db.transaction(async (tx) => {
    const row = await blobRow(tx, sha, true)
    if (row?.state !== 'present') return { outcome: 'not_present' as const }
    const { rows } = await tx.execute<{ referenced: boolean }>(
      sql`SELECT blob_is_referenced(${sha}) AS referenced`,
    )
    if (rows[0]?.referenced) return { outcome: 'referenced' as const }
    try {
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO storage_operations (kind, blob_sha256, from_key, to_key, owner)
        VALUES ('purge', ${sha}, ${row.storage_key}, NULL, ${owner})
        RETURNING id`)
      return { id: inserted.rows[0]?.id as string, key: row.storage_key }
    } catch (error) {
      if (dbErrorCode(error) === '23505') return { outcome: 'busy' as const }
      throw error
    }
  })
  if (!('id' in intent) || !intent.id || !intent.key) return intent.outcome ?? 'busy'

  await setOperation(db, intent.id, 'started')
  const derived = await db.execute<{ id: string }>(sql`
    SELECT id FROM rendition_generations WHERE master_sha256 = ${sha} OR input_sha256 = ${sha}`)
  try {
    await store.delete(intent.key)
    for (const { id } of derived.rows) await store.delete(`derived/gen/${id}`)
  } catch (error) {
    await setOperation(db, intent.id, 'failed', String((error as Error).message ?? error))
    throw error
  }
  await setOperation(db, intent.id, 'fs_done')
  await options.afterFiles?.()

  return db.transaction(async (tx) => {
    await blobRow(tx, sha, true)
    const { rows } = await tx.execute<{ referenced: boolean }>(
      sql`SELECT blob_is_referenced(${sha}) AS referenced`,
    )
    await tx.execute(sql`
      UPDATE rendition_generations SET state = 'evicted', is_active = false
       WHERE master_sha256 = ${sha} OR input_sha256 = ${sha}`)
    await tx.execute(sql`
      UPDATE rendition_artifacts SET state = 'evicted'
       WHERE generation_id IN (SELECT id FROM rendition_generations
                                WHERE master_sha256 = ${sha} OR input_sha256 = ${sha})`)
    if (rows[0]?.referenced) {
      // A reference slipped in after the bytes were gone: say so, never pretend.
      await tx.execute(sql`UPDATE blobs SET state = 'missing' WHERE sha256 = ${sha}`)
      await setOperation(tx, intent.id, 'failed', 'referenced again during the purge')
      return 'referenced' as const
    }
    await tx.execute(
      sql`UPDATE blobs SET state = 'purged', purged_at = now() WHERE sha256 = ${sha}`,
    )
    await setOperation(tx, intent.id, 'committed')
    return 'purged' as const
  })
}

export interface ReconcileReport {
  cancelled: number
  committed: number
  failed: number
}

/**
 * Settles the unfinished operations of a role after a restart, before it claims work: an
 * `intent` never touched a file and is cancelled; `started`/`fs_done` are checked against
 * the disk — a `put` whose file is in place with its hash is committed, otherwise failed;
 * a `purge` whose file is gone is committed (the blob becomes `purged`), otherwise failed.
 */
export async function reconcileStorage(
  db: Db,
  store: BlobStore,
  ownerPrefix: string,
): Promise<ReconcileReport> {
  const report: ReconcileReport = { cancelled: 0, committed: 0, failed: 0 }
  const { rows } = await db.execute<{
    id: string
    kind: 'put' | 'purge'
    state: string
    blob_sha256: Buffer
    from_key: string | null
    to_key: string | null
  }>(sql`
    SELECT id, kind, state, blob_sha256, from_key, to_key FROM storage_operations
     WHERE state IN ('intent', 'started', 'fs_done') AND owner LIKE ${`${ownerPrefix}%`}
     ORDER BY created_at`)
  for (const op of rows) {
    if (op.state === 'intent') {
      await setOperation(db, op.id, 'cancelled')
      report.cancelled++
      continue
    }
    if (op.kind === 'put') {
      const key = op.to_key as string
      const hex = shaHex(op.blob_sha256)
      const onDisk = (await store.exists(key)) ? await sha256OfFile(store.path(key)) : null
      if (onDisk === hex) {
        const bytes = (await store.stat(key))?.bytes ?? 0
        const ext = key.split('.').pop() as string
        await db.transaction(async (tx) => {
          await blobRow(tx, op.blob_sha256, true)
          await upsertPresent(tx, {
            sha: op.blob_sha256,
            bytes,
            mime: mimeOfExt(ext),
            ext,
            mediaKind: mimeOfExt(ext).startsWith('image/') ? 'image' : 'video',
            key,
          })
          await setOperation(tx, op.id, 'committed')
        })
        report.committed++
      } else {
        if (onDisk !== null) await store.delete(key)
        await setOperation(db, op.id, 'failed', 'interrupted: bytes not in place after restart')
        report.failed++
      }
      await removeTemps(store, op.id)
    } else {
      const gone = !(await store.exists(op.from_key as string))
      if (gone) {
        await db.transaction(async (tx) => {
          await blobRow(tx, op.blob_sha256, true)
          await tx.execute(sql`
            UPDATE blobs SET state = 'purged', purged_at = now() WHERE sha256 = ${op.blob_sha256}`)
          await setOperation(tx, op.id, 'committed')
        })
        report.committed++
      } else {
        await setOperation(db, op.id, 'failed', 'interrupted before the file was removed')
        report.failed++
      }
    }
  }
  return report
}

/** Temp files of an interrupted `put` (`.incoming/<operation>.partial`). */
async function removeTemps(store: BlobStore, operationId: string): Promise<void> {
  const names = await readdir(store.incomingDir).catch(() => [] as string[])
  for (const name of names) {
    if (name.startsWith(operationId)) await rm(join(store.incomingDir, name), { force: true })
  }
}
