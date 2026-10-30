import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type Db,
  enqueueWork,
  logAction,
  type Tx,
  WorkDeferred,
  WorkError,
  type WorkHandler,
} from '@contentops/db'
import {
  downloadVerified,
  isSourceError,
  type RetryPolicy,
  type SourceEntry,
  sourcePath,
} from '@contentops/sources'
import { sql } from 'drizzle-orm'
import { copyFromLocal, type LegacyCopyConfig } from '../legacy/copy'
import type { BlobStore } from '../media/storage'
import { extOfName, shaBytes } from '../media/storage'
import { readHostSpace, type SpaceOptions } from '../space'
import { recordChangedRevision } from './discover'
import { mediaKindOf } from './grouping'
import { scanFailure } from './scan'
import { type SourceFactory, sourceById } from './source-client'

/**
 * `fetch` (SPEC §6.1, §12.2, schema §3.4): the bytes of one source revision, resumable, into
 * `TMP_ROOT/staging/<sha256>.<ext>` where the media works find them (`locateInput`). The
 * checked hash goes to the revision and the draft; then an exact duplicate resolves itself as
 * an alias (schema §5), anything else gets its derivatives and master queued. Parallelism is
 * the `fetch` slot (`FETCH_JOBS`); the prefetch stays under `FETCH_AHEAD_GB`; intake stops
 * below the free space of the pilot (`SPACE_STOP_GB` of C:).
 */

const GB = 1_000_000_000
const WAIT_SPACE_MS = 10 * 60_000
const WAIT_AHEAD_MS = 60_000

export interface FetchDeps {
  factory: SourceFactory
  store: BlobStore
  /** `FETCH_AHEAD_GB`: bytes staged and not yet turned into a master. */
  fetchAheadGb: number
  space?: SpaceOptions
  /** Pauses between resumes inside one attempt (tests pass one that does not sleep). */
  retry?: RetryPolicy
  /**
   * The local Я.Диск copy (`LEGACY_SOURCE_ROOT` + the Windows list): the old corpus is read
   * from it where the list says the bytes are there (SPEC §6.3); the rest through the API.
   */
  legacyCopy?: LegacyCopyConfig
}

interface RevisionRow extends Record<string, unknown> {
  revision_id: string
  object_id: string
  source_id: string
  resource_id: string
  current_path: string
  current_name: string
  current_revision_id: string | null
  byte_size: string
  md5: string | null
  remote_sha256: string | null
  content_hash: string | null
  remote_rev: string | null
  source_sha256: string | null
  draft_id: string | null
  draft_state: string | null
  draft_origin: string | null
}

async function revisionOf(db: Db, modelId: string, revisionId: string): Promise<RevisionRow> {
  const { rows } = await db.execute<RevisionRow>(sql`
    SELECT r.id AS revision_id, o.id AS object_id, o.source_id, o.resource_id, o.current_path,
           o.current_name, o.current_revision_id, r.byte_size, encode(r.md5, 'hex') AS md5,
           encode(r.remote_sha256, 'hex') AS remote_sha256,
           encode(r.content_hash, 'hex') AS content_hash, r.remote_rev,
           encode(r.source_sha256, 'hex') AS source_sha256, d.id AS draft_id, d.state AS draft_state,
           d.origin AS draft_origin
      FROM source_revisions r
      JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
      LEFT JOIN inbox_drafts d ON d.model_id = r.model_id AND d.source_revision_id = r.id
     WHERE r.model_id = ${modelId}::uuid AND r.id = ${revisionId}::uuid`)
  const [row] = rows
  if (!row) throw new WorkError('permanent', 'revision_missing', 'ревизии нет')
  return row
}

/** The observed revision as the source client wants it: its id, path, size and sums. */
function entryOf(row: RevisionRow, kind: 'yandex_disk' | 'dropbox', root: string): SourceEntry {
  return {
    source: kind,
    id: row.resource_id,
    isDir: false,
    name: row.current_name,
    path: sourcePath(row.current_path, root),
    parentPath: null,
    size: Number(row.byte_size),
    md5: row.md5,
    sha256: row.remote_sha256,
    contentHash: row.content_hash,
    rev: row.remote_rev,
    createdAt: null,
    modifiedAt: null,
    shotAt: null,
    mediaType: null,
    mimeType: null,
    previewUrl: null,
  }
}

/** Free space of the pilot below the stop line: intake waits (SPEC §12.2). */
async function spaceLow(space: SpaceOptions | undefined): Promise<boolean> {
  if (!space?.file) return false
  const report = await readHostSpace(space.file)
  const first = report?.disks[0]
  if (!report || !first) return false
  if (Date.now() - Date.parse(report.measured_at) > 15 * 60_000) return false
  return first.free_bytes <= space.stopGb * GB
}

/** Bytes fetched but not yet turned into a verified master: the prefetch budget. */
async function stagedAhead(db: Db): Promise<number> {
  const { rows } = await db.execute<{ bytes: string | null }>(sql`
    SELECT sum(byte_size) AS bytes FROM inbox_drafts
     WHERE state <> 'resolved' AND source_sha256 IS NOT NULL AND master_verified_at IS NULL`)
  return Number(rows[0]?.bytes ?? 0)
}

export function fetchHandler(deps: FetchDeps): WorkHandler {
  return async ({ work, db, signal, checkpoint }) => {
    if (!work.modelId || !work.sourceRevisionId) {
      throw new WorkError('permanent', 'no_target', 'fetch без ревизии')
    }
    const modelId = work.modelId
    const row = await revisionOf(db, modelId, work.sourceRevisionId)
    if (!row.draft_id || row.draft_state === 'resolved') return { report: { skipped: 'resolved' } }
    const draftId = row.draft_id
    if (row.source_sha256 && (await deps.store.staged(row.source_sha256))) {
      return {
        report: { skipped: 'already_fetched' },
        commit: (tx) => afterFetch(tx, modelId, draftId, row.source_sha256 as string, work.id),
      }
    }
    // Back-pressure, not a failure: the fetch waits without spending an attempt. Counted as
    // attempts, a big import gave up on every file still waiting while the encoder caught up.
    if (await spaceLow(deps.space)) {
      throw new WorkDeferred(WAIT_SPACE_MS, 'забор остановлен: мало места')
    }
    if ((await stagedAhead(db)) > deps.fetchAheadGb * GB) {
      throw new WorkDeferred(WAIT_AHEAD_MS, 'предзабор полон')
    }
    const source = await sourceById(db, row.source_id)
    const client = source ? deps.factory(source) : null
    if (!source || !client) {
      throw new WorkError('permanent', 'not_configured', 'источник не настроен')
    }
    const entry = entryOf(row, source.kind, client.root)
    const dir = join(deps.store.roots.tmpRoot, 'fetch')
    const ext = extOfName(row.current_name) || 'bin'
    if (deps.legacyCopy && row.draft_origin === 'legacy_import' && source.kind === 'yandex_disk') {
      const copied = await copyFromLocal(deps.legacyCopy, {
        apiPath: row.current_path,
        size: Number(row.byte_size),
        md5: row.md5,
        sha256: row.remote_sha256,
        target: join(dir, `${row.revision_id}.copy${extOf(row.current_name)}`),
        signal,
      })
      if (copied.status === 'copied') {
        await mkdir(deps.store.stagingDir, { recursive: true })
        await rename(copied.path, join(deps.store.stagingDir, `${copied.sha256}.${ext}`))
        const sha = copied.sha256
        return {
          outputRef: `staging/${sha}.${ext}`,
          report: { sha256: sha, bytes: copied.size, route: 'local_copy' },
          commit: async (tx) => {
            await tx.execute(sql`
              UPDATE source_revisions
                 SET source_sha256 = ${shaBytes(sha)}, verified_at = now(),
                     verified_route = 'local_copy'
               WHERE model_id = ${modelId}::uuid AND id = ${row.revision_id}::uuid
                 AND source_sha256 IS NULL`)
            await afterFetch(tx, modelId, draftId, sha, work.id)
          },
        }
      }
      await checkpoint({ progress: { num: 0, note: `копия: ${copied.reason}, качается` } })
    }
    let result: Awaited<ReturnType<typeof downloadVerified>>
    try {
      result = await downloadVerified(client, entry, {
        targetDir: dir,
        // The partial is named by the revision: a retry resumes it, another revision never.
        fileName: `${row.revision_id}${extOf(row.current_name)}`,
        signal,
        ...(deps.retry ? { retry: deps.retry } : {}),
        onProgress: (bytes, total) => {
          checkpoint({ progress: { num: bytes, den: total, note: 'качается' } }).catch(() => {})
        },
      })
    } catch (error) {
      // Gone from the source before its bytes came: «исходник недоступен» until a scan sees
      // it again (SPEC §6.1), not a broken source.
      if (isSourceError(error, 'not_found')) {
        return {
          report: { vanished: true },
          commit: async (tx) => {
            await tx.execute(sql`
              UPDATE inbox_drafts
                 SET blocked_reason = 'source_unavailable', updated_at = now(),
                     row_version = row_version + 1
               WHERE model_id = ${modelId}::uuid AND id = ${draftId}::uuid
                 AND state <> 'resolved' AND source_sha256 IS NULL`)
          },
        }
      }
      throw scanFailure(error)
    }
    if (result.status === 'changed') {
      // The bytes are not those of this revision: the next one is recorded now (SPEC §6.1).
      const current = result.current
      return {
        report: { changed: result.reason },
        commit: async (tx) => {
          await tx.execute(sql`
            UPDATE inbox_drafts
               SET blocked_reason = 'source_unavailable', error = ${result.reason},
                   updated_at = now(), row_version = row_version + 1
             WHERE model_id = ${modelId}::uuid AND id = ${draftId}::uuid AND state <> 'resolved'`)
          if (current?.id) {
            const { rows: groups } = await tx.execute<{ group_id: string }>(sql`
              SELECT group_id FROM inbox_drafts
               WHERE model_id = ${modelId}::uuid AND id = ${draftId}::uuid`)
            const groupId = groups[0]?.group_id
            if (groupId) {
              await recordChangedRevision(tx, source, work.id, row.object_id, groupId, current)
            }
          }
        },
      }
    }
    await mkdir(deps.store.stagingDir, { recursive: true })
    await rename(result.path, join(deps.store.stagingDir, `${result.sha256}.${ext}`))
    const sha = result.sha256
    return {
      outputRef: `staging/${sha}.${ext}`,
      report: { sha256: sha, bytes: result.size, resumed_from: result.resumedFrom },
      commit: async (tx) => {
        await tx.execute(sql`
          UPDATE source_revisions
             SET source_sha256 = ${shaBytes(sha)}, verified_at = now(), verified_route = 'download'
           WHERE model_id = ${modelId}::uuid AND id = ${row.revision_id}::uuid
             AND source_sha256 IS NULL`)
        await afterFetch(tx, modelId, draftId, sha, work.id)
      },
    }
  }
}

function extOf(name: string): string {
  const ext = extOfName(name)
  return ext ? `.${ext}` : ''
}

export interface DuplicateRow extends Record<string, unknown> {
  version_id: string
  asset_id: string
  item_id: string
  type: string
}

/**
 * After the bytes are checked: the hash on the draft; an exact duplicate of an accepted
 * version of the model becomes an alias by itself (except custom ↔ PPV, SPEC §6.1 p. 1);
 * the same bytes at another model block the draft for a person; otherwise the derivatives
 * and, for a video, the master are queued for this draft.
 */
export async function afterFetch(
  tx: Tx,
  modelId: string,
  draftId: string,
  sha: string,
  workId: string | null,
): Promise<void> {
  const bytes = shaBytes(sha)
  const { rows: drafts } = await tx.execute<{
    state: string
    path: string | null
    type: string | null
    source_object_id: string | null
  }>(sql`
    SELECT d.state, d.path, g.proposed_type AS type, r.source_object_id
      FROM inbox_drafts d
      JOIN inbox_groups g ON g.model_id = d.model_id AND g.id = d.group_id
      LEFT JOIN source_revisions r ON r.model_id = d.model_id AND r.id = d.source_revision_id
     WHERE d.model_id = ${modelId}::uuid AND d.id = ${draftId}::uuid FOR UPDATE OF d`)
  const draft = drafts[0]
  if (!draft || draft.state === 'resolved') return
  await tx.execute(sql`
    UPDATE inbox_drafts
       SET source_sha256 = ${bytes}, state = CASE WHEN state = 'discovered' THEN 'processing' ELSE state END,
           blocked_reason = CASE WHEN blocked_reason = 'source_unavailable' THEN NULL ELSE blocked_reason END,
           error = NULL, updated_at = now(), row_version = row_version + 1
     WHERE model_id = ${modelId}::uuid AND id = ${draftId}::uuid`)

  const dup = await acceptedHolder(tx, modelId, bytes)
  if (dup && (await applyDuplicate(tx, modelId, { id: draftId, ...draft }, dup)) === 'alias') return
  const { rows: others } = await tx.execute<{ model_id: string }>(sql`
    SELECT DISTINCT v.model_id FROM asset_versions v
     WHERE v.model_id <> ${modelId}::uuid AND (v.source_sha256 = ${bytes} OR v.master_sha256 = ${bytes})`)
  if (others.length > 0) {
    await tx.execute(sql`
      UPDATE inbox_drafts SET blocked_reason = 'cross_model_dup'
       WHERE model_id = ${modelId}::uuid AND id = ${draftId}::uuid AND blocked_reason IS NULL`)
    await tx.execute(sql`
      INSERT INTO review_cases (model_id, kind, dedup_key, draft_id, blob_sha256, counterpart_model_id, details)
      VALUES (${modelId}::uuid, 'cross_model_duplicate', ${sha}, ${draftId}::uuid, ${bytes},
              ${others[0]?.model_id}::uuid, ${JSON.stringify({ path: draft.path })}::jsonb)
      ON CONFLICT (model_id, kind, dedup_key) DO NOTHING`)
  }
  await queueMedia(tx, modelId, draftId, sha, mediaKindOf(draft.path ?? '', null), workId)
}

/** An accepted version of the model with these bytes, by hex SHA-256 (the import asks it). */
export async function acceptedDuplicate(
  tx: Tx,
  modelId: string,
  sha: string,
): Promise<DuplicateRow | null> {
  return (await acceptedHolder(tx, modelId, shaBytes(sha))) ?? null
}

/** The oldest accepted version of the model holding these bytes (SPEC §6.2), if any. */
async function acceptedHolder(
  tx: Tx,
  modelId: string,
  bytes: Buffer,
): Promise<DuplicateRow | undefined> {
  const { rows } = await tx.execute<DuplicateRow>(sql`
    SELECT v.id AS version_id, v.asset_id, i.id AS item_id, i.type
      FROM asset_versions v
      JOIN item_memberships m ON m.model_id = v.model_id AND m.asset_id = v.asset_id
                             AND m.kind = 'owned' AND m.removed_at IS NULL
      JOIN content_items i ON i.model_id = m.model_id AND i.id = m.item_id AND i.deleted_at IS NULL
     WHERE v.model_id = ${modelId}::uuid AND (v.source_sha256 = ${bytes} OR v.master_sha256 = ${bytes})
     ORDER BY v.created_at LIMIT 1`)
  return rows[0]
}

/**
 * The bytes of an open draft are those of an accepted version: «дубль-алиас» by itself,
 * except custom ↔ PPV, where the draft goes on to a new object over the same bytes and the
 * link stays a candidate (SPEC §6.1 p. 1).
 */
async function applyDuplicate(
  tx: Tx,
  modelId: string,
  draft: { id: string; type: string | null; source_object_id: string | null },
  dup: DuplicateRow,
): Promise<'alias' | 'candidate'> {
  const pair = new Set([draft.type, dup.type])
  if (draft.type !== dup.type && pair.has('CUS') && pair.has('PPV')) {
    await tx.execute(sql`
      INSERT INTO inbox_draft_candidates (model_id, draft_id, kind, item_id, version_id, signals)
      VALUES (${modelId}::uuid, ${draft.id}::uuid, 'exact_duplicate', ${dup.item_id}::uuid,
              ${dup.version_id}::uuid, '{"sha256": true, "custom_ppv": true}'::jsonb)
      ON CONFLICT DO NOTHING`)
    return 'candidate'
  }
  await resolveAlias(tx, modelId, draft.id, dup, draft.source_object_id)
  return 'alias'
}

/**
 * At an accept: open drafts of other groups with the bytes of the accepted files become their
 * aliases now (SPEC §6.2: the exact duplicate is found among every draft, accepted or not).
 * Drafts made over an accepted version (`derived`: PPV from a custom, master from raw) are
 * meant to share its bytes and are left alone; a draft locked by a concurrent accept is
 * skipped rather than waited for.
 */
export async function aliasOpenDuplicates(
  tx: Tx,
  modelId: string,
  groupId: string,
  hexes: readonly string[],
): Promise<number> {
  if (hexes.length === 0) return 0
  const { rows } = await tx.execute<{
    id: string
    type: string | null
    source_object_id: string | null
    sha: string
  }>(sql`
    SELECT d.id, g.proposed_type AS type, r.source_object_id, encode(d.source_sha256, 'hex') AS sha
      FROM inbox_drafts d
      JOIN inbox_groups g ON g.model_id = d.model_id AND g.id = d.group_id
      LEFT JOIN source_revisions r ON r.model_id = d.model_id AND r.id = d.source_revision_id
     WHERE d.model_id = ${modelId}::uuid AND d.group_id <> ${groupId}::uuid
       AND d.state <> 'resolved' AND d.origin <> 'derived'
       AND d.source_sha256 IN (SELECT decode(h, 'hex') FROM unnest(${sql.param([...hexes])}::text[]) h)
     ORDER BY d.id
     FOR UPDATE OF d SKIP LOCKED`)
  let aliased = 0
  for (const row of rows) {
    const dup = await acceptedHolder(tx, modelId, shaBytes(row.sha))
    if (dup && (await applyDuplicate(tx, modelId, row, dup)) === 'alias') aliased += 1
  }
  return aliased
}

/** The derivatives of the source and, for a video, the master (schema §3.4 `work_key`). */
export async function queueMedia(
  tx: Tx,
  modelId: string,
  draftId: string,
  sha: string,
  media: 'video' | 'image' | null,
  _workId: string | null,
  attempt = '',
): Promise<void> {
  const bytes = shaBytes(sha)
  const tail = attempt ? `:${attempt}` : ''
  const common = { modelId, inputSha256: bytes, draftId, priority: 10 }
  if (media === 'video') {
    await enqueueWork(tx, {
      ...common,
      kind: 'derive_video',
      workKey: `derive:${sha}:${draftId}${tail}`,
    })
    await enqueueWork(tx, {
      ...common,
      kind: 'encode_master',
      workKey: `master:${sha}:${draftId}${tail}`,
    })
  } else if (media === 'image') {
    await enqueueWork(tx, {
      ...common,
      kind: 'derive_image',
      workKey: `derive:${sha}:${draftId}${tail}`,
    })
  }
}

/** «Дубль-алиас» (schema §5, SPEC §6.1 p. 1): resolved by itself, the paths become aliases. */
export async function resolveAlias(
  tx: Tx,
  modelId: string,
  draftId: string,
  dup: DuplicateRow,
  sourceObjectId: string | null,
  /** A twin inside an accepted group: decided by the person who accepts, one journal row. */
  twin?: { decidedBy: string },
): Promise<void> {
  await tx.execute(sql`
    UPDATE inbox_drafts
       SET state = 'resolved', outcome = 'alias', duplicate_of_version_id = ${dup.version_id}::uuid,
           applied_item_id = ${dup.item_id}::uuid, applied_version_id = ${dup.version_id}::uuid,
           decided_at = now(), decided_by = ${twin?.decidedBy ?? null}::uuid, blocked_reason = NULL,
           updated_at = now(), row_version = row_version + 1
     WHERE model_id = ${modelId}::uuid AND id = ${draftId}::uuid`)
  await tx.execute(sql`
    INSERT INTO inbox_draft_candidates (model_id, draft_id, kind, item_id, version_id, signals, chosen, chosen_at)
    VALUES (${modelId}::uuid, ${draftId}::uuid, 'exact_duplicate', ${dup.item_id}::uuid,
            ${dup.version_id}::uuid, '{"sha256": true}'::jsonb, true, now())
    ON CONFLICT DO NOTHING`)
  if (sourceObjectId) {
    await tx.execute(sql`
      INSERT INTO aliases (model_id, kind, value_raw, asset_id, source_object_id)
      SELECT p.model_id, 'legacy_path', p.path_raw, ${dup.asset_id}::uuid, p.source_object_id
        FROM source_paths p
       WHERE p.model_id = ${modelId}::uuid AND p.source_object_id = ${sourceObjectId}::uuid
      ON CONFLICT DO NOTHING`)
  }
  if (twin) return
  const { rows } = await tx.execute<{ label: string }>(sql`
    SELECT public_item_id(type, number) AS label FROM content_items
     WHERE model_id = ${modelId}::uuid AND id = ${dup.item_id}::uuid`)
  await logAction(tx, {
    modelId,
    action: 'draft.alias',
    subjectKind: 'inbox_drafts',
    subjectId: draftId,
    subjectLabel: rows[0]?.label ?? 'дубль',
    itemId: dup.item_id,
    after: { outcome: 'alias', item: rows[0]?.label },
  })
}
