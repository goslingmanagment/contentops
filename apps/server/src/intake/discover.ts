import { type Db, SYSTEM_ACTOR, type Tx, withActorTx } from '@contentops/db'
import {
  type CloudSource,
  components,
  isSourceError,
  nfc,
  type SourceEntry,
} from '@contentops/sources'
import { sql } from 'drizzle-orm'
import {
  clusterStart,
  fitsCluster,
  looseGroupOf,
  mediaKindOf,
  placementOf,
  titleFromFileName,
  typeFromRoot,
} from './grouping'
import type { SourceRow } from './source-client'

/**
 * Discovery (SPEC §6.1, schema §3.4): what the source shows becomes `source_objects`,
 * `source_paths`, `source_revisions`, intake groups and drafts — at once, before any byte
 * is downloaded. Every step is idempotent: a repeat of the same listing changes nothing but
 * `last_seen_at`. A rename or move is a new path of the same object (and an alias of an
 * accepted file), not a new draft; changed bytes under the same id are a new revision and
 * a new draft.
 */

/** Drafts from the source go before the old corpus (SPEC §12.0: new and small first). */
const SCAN_PRIORITY = 10

/** A folder the grouping needs, with its id at the source. */
export interface FolderRef {
  raw: string
  resourceId: string
  name: string
  /** The listing entry when the folder came from the source in this pass (or a `stat`). */
  entry: SourceEntry | null
}

export interface ApplyStats {
  files: number
  dirs: number
  revisions: number
  drafts: number
  moved: number
}

const emptyStats = (): ApplyStats => ({ files: 0, dirs: 0, revisions: 0, drafts: 0, moved: 0 })

export function addStats(into: ApplyStats, more: ApplyStats): ApplyStats {
  for (const key of Object.keys(into) as (keyof ApplyStats)[]) into[key] += more[key]
  return into
}

/** Lookup key of a path: Dropbox matches paths case-insensitively, like `path_lower`. */
function pathKey(source: SourceRow, raw: string): string {
  const value = nfc(raw)
  return source.kind === 'dropbox' ? value.toLowerCase() : value
}

/** The raw path of the first `keep` components of `raw`, in the source's notation. */
function prefixPath(raw: string, keep: number): string {
  const parts = components(raw).slice(0, keep)
  if (raw.startsWith('disk:')) return `disk:/${parts.join('/')}`
  return parts.length === 0 ? '' : `/${parts.join('/')}`
}

/** Components of a file under the model's folder, its name last. */
function relativeOf(entry: SourceEntry): string[] {
  return entry.path.relative === '' ? [] : entry.path.relative.split('/')
}

/** Folders the group of a file is held by: the group subfolder, or the root it lies in. */
function folderPathsOf(client: CloudSource, entry: SourceEntry): string[] {
  const rootDepth = components(client.root).length
  const relative = relativeOf(entry)
  const placement = placementOf(relative)
  const depths = placement.kind === 'folder' ? [1, 2] : placement.folderDepth === 1 ? [1] : []
  return depths.map((depth) => prefixPath(entry.path.raw, rootDepth + depth))
}

/**
 * Finds the ids of the folders a batch needs: from the dirs of this pass, from the database,
 * then from the source (`stat`, read-only). Network calls stay outside the transaction.
 */
export async function resolveFolders(
  db: Db,
  client: CloudSource,
  source: SourceRow,
  entries: readonly SourceEntry[],
  known: Map<string, FolderRef>,
  signal?: AbortSignal,
): Promise<Map<string, FolderRef>> {
  for (const entry of entries) {
    if (entry.isDir && entry.id) {
      known.set(pathKey(source, entry.path.raw), {
        raw: entry.path.raw,
        resourceId: entry.id,
        name: entry.name,
        entry,
      })
    }
  }
  const wanted = new Set<string>()
  for (const entry of entries) {
    if (entry.isDir) continue
    for (const raw of folderPathsOf(client, entry)) {
      if (!known.has(pathKey(source, raw))) wanted.add(raw)
    }
  }
  for (const raw of wanted) {
    const key = pathKey(source, raw)
    if (known.has(key)) continue
    const { rows } = await db.execute<{ resource_id: string; current_name: string }>(sql`
      SELECT resource_id, current_name FROM source_objects
       WHERE model_id = ${source.modelId}::uuid AND source_id = ${source.id}::uuid AND is_dir
         AND gone_since IS NULL AND resource_id IS NOT NULL
         AND (CASE WHEN ${source.kind === 'dropbox'} THEN lower(normalize(current_path, NFC))
                   ELSE normalize(current_path, NFC) END) = ${key}
       ORDER BY last_seen_at DESC LIMIT 1`)
    const [row] = rows
    if (row) {
      known.set(key, { raw, resourceId: row.resource_id, name: row.current_name, entry: null })
      continue
    }
    try {
      const entry = await client.stat({ path: raw }, signal ? { signal } : {})
      if (entry.id) {
        known.set(key, { raw: entry.path.raw, resourceId: entry.id, name: entry.name, entry })
      }
    } catch (error) {
      // A folder that vanished between the listing and now: its files wait for the next pass.
      if (!isSourceError(error, 'not_found')) throw error
    }
  }
  return known
}

export interface ApplyInput {
  source: SourceRow
  client: CloudSource
  workId: string
  entries: readonly SourceEntry[]
  folders: Map<string, FolderRef>
}

/** One transaction per batch, serialised per source with the scans of other streams. */
export async function applyEntries(db: Db, input: ApplyInput): Promise<ApplyStats> {
  const { source } = input
  const context = {
    actor: SYSTEM_ACTOR('scan'),
    action: 'source.scan',
    requestId: `scan:${input.workId}`,
    workId: input.workId,
  }
  return withActorTx(db, context, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`scan:${source.id}`}, 0))`)
    const stats = emptyStats()
    // Folders first: the group of a file holds its folder object.
    const folders = new Map<string, FolderRef>(input.folders)
    for (const folder of folders.values()) {
      if (folder.entry) await upsertObject(tx, source, folder.entry)
    }
    for (const entry of input.entries) {
      if (!entry.id) continue
      if (entry.isDir) {
        stats.dirs += 1
        if (!folders.has(pathKey(source, entry.path.raw))) await upsertObject(tx, source, entry)
        continue
      }
      stats.files += 1
      const object = await upsertObject(tx, source, entry)
      if (object.moved) stats.moved += 1
      const revision = await observeRevision(tx, source, object.id, entry, input.workId)
      if (revision.created) stats.revisions += 1
      const media = mediaKindOf(entry.name, entry.mediaType)
      if (!media) continue
      const groupId = await groupOf(tx, input, entry, media === 'video')
      if (await ensureDraft(tx, source, groupId, revision, entry)) stats.drafts += 1
    }
    return stats
  })
}

interface ObjectResult {
  id: string
  moved: boolean
}

async function upsertObject(tx: Tx, source: SourceRow, entry: SourceEntry): Promise<ObjectResult> {
  const { rows } = await tx.execute<{ id: string; current_path: string; gone: boolean }>(sql`
    SELECT id, current_path, gone_since IS NOT NULL AS gone FROM source_objects
     WHERE model_id = ${source.modelId}::uuid AND source_id = ${source.id}::uuid
       AND resource_id = ${entry.id}
     FOR UPDATE`)
  const [found] = rows
  let id: string
  let moved = false
  if (!found) {
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO source_objects (model_id, source_id, resource_id, current_path, current_name, is_dir)
      VALUES (${source.modelId}::uuid, ${source.id}::uuid, ${entry.id}, ${entry.path.raw},
              ${entry.name}, ${entry.isDir})
      RETURNING id`)
    id = (inserted.rows[0] as { id: string }).id
  } else {
    id = found.id
    moved = found.current_path !== entry.path.raw
    if (moved || found.gone) {
      await tx.execute(sql`
        UPDATE source_objects
           SET current_path = ${entry.path.raw}, current_name = ${entry.name}, gone_since = NULL,
               last_seen_at = now()
         WHERE model_id = ${source.modelId}::uuid AND id = ${id}::uuid`)
    } else {
      await tx.execute(sql`
        UPDATE source_objects SET last_seen_at = now()
         WHERE model_id = ${source.modelId}::uuid AND id = ${id}::uuid`)
    }
    if (found.gone) {
      // Found again: the block «исходник недоступен» of its drafts lifts by itself (SPEC §6.1).
      await tx.execute(sql`
        UPDATE inbox_drafts d
           SET blocked_reason = NULL, updated_at = now(), row_version = d.row_version + 1
          FROM source_revisions r
         WHERE r.model_id = d.model_id AND r.id = d.source_revision_id
           AND d.model_id = ${source.modelId}::uuid AND r.source_object_id = ${id}::uuid
           AND d.blocked_reason = 'source_unavailable' AND d.state <> 'resolved'`)
    }
  }
  await tx.execute(sql`
    INSERT INTO source_paths (model_id, source_object_id, path_raw, name)
    VALUES (${source.modelId}::uuid, ${id}::uuid, ${entry.path.raw}, ${entry.name})
    ON CONFLICT (model_id, source_object_id, path_nfc) DO UPDATE SET last_seen_at = now()`)
  if (moved && !entry.isDir) {
    // An accepted file keeps every path it had: the new one is an alias of its asset.
    await tx.execute(sql`
      INSERT INTO aliases (model_id, kind, value_raw, asset_id, source_object_id)
      SELECT DISTINCT v.model_id, 'legacy_path', ${entry.path.raw}, v.asset_id, ${id}::uuid
        FROM source_revisions r
        JOIN asset_versions v ON v.model_id = r.model_id AND v.source_revision_id = r.id
       WHERE r.model_id = ${source.modelId}::uuid AND r.source_object_id = ${id}::uuid
      ON CONFLICT DO NOTHING`)
  }
  return { id, moved }
}

export interface RevisionResult {
  id: string
  created: boolean
  previousId: string | null
}

const hex = (value: string | null) => (value ? Buffer.from(value, 'hex') : null)

async function observeRevision(
  tx: Tx,
  source: SourceRow,
  objectId: string,
  entry: SourceEntry,
  workId: string,
): Promise<RevisionResult> {
  const { rows } = await tx.execute<{
    id: string
    sequence_no: number
    byte_size: string
    md5: string | null
    remote_sha256: string | null
    content_hash: string | null
  }>(sql`
    SELECT r.id, r.sequence_no, r.byte_size, encode(r.md5, 'hex') AS md5,
           encode(r.remote_sha256, 'hex') AS remote_sha256,
           encode(r.content_hash, 'hex') AS content_hash
      FROM source_objects o
      JOIN source_revisions r ON r.model_id = o.model_id AND r.id = o.current_revision_id
     WHERE o.model_id = ${source.modelId}::uuid AND o.id = ${objectId}::uuid`)
  const [current] = rows
  const size = entry.size ?? 0
  if (current && Number(current.byte_size) === size) {
    const same =
      source.kind === 'yandex_disk'
        ? current.md5 === (entry.md5?.toLowerCase() ?? null) &&
          (current.remote_sha256 === null ||
            entry.sha256 === null ||
            current.remote_sha256 === entry.sha256.toLowerCase())
        : current.content_hash === (entry.contentHash?.toLowerCase() ?? null)
    if (same) return { id: current.id, created: false, previousId: null }
  }
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO source_revisions (
      model_id, source_object_id, sequence_no, md5, remote_sha256, content_hash, remote_rev,
      byte_size, remote_created_at, remote_modified_at, scan_work_id, previous_id
    ) VALUES (
      ${source.modelId}::uuid, ${objectId}::uuid, ${(current?.sequence_no ?? 0) + 1},
      ${hex(entry.md5)}::bytea, ${hex(entry.sha256)}::bytea, ${hex(entry.contentHash)}::bytea,
      ${entry.rev}, ${size}, ${entry.createdAt}::timestamptz, ${entry.modifiedAt}::timestamptz,
      ${workId}::uuid, ${current?.id ?? null}::uuid
    )
    RETURNING id`)
  const id = (inserted.rows[0] as { id: string }).id
  await tx.execute(sql`
    UPDATE source_objects SET current_revision_id = ${id}::uuid
     WHERE model_id = ${source.modelId}::uuid AND id = ${objectId}::uuid`)
  return { id, created: true, previousId: current?.id ?? null }
}

interface GroupProposal {
  key: string
  grouping: 'folder' | 'exif_day' | 'upload_cluster' | 'single'
  folderResourceId: string | null
  title: string | null
  type: string | null
  evidence: Record<string, unknown>
}

async function groupOf(
  tx: Tx,
  input: ApplyInput,
  entry: SourceEntry,
  isVideo: boolean,
): Promise<string> {
  const { source, client } = input
  const relative = relativeOf(entry)
  const rootName = relative.length >= 2 ? (relative[0] ?? null) : null
  const type = typeFromRoot(rootName)
  const rootDepth = components(client.root).length
  const placement = placementOf(relative)
  const folderAt = (depth: number) =>
    input.folders.get(pathKey(source, prefixPath(entry.path.raw, rootDepth + depth)))
  const evidence = { root: rootName, path: entry.path.raw }

  let proposal: GroupProposal
  if (placement.kind === 'folder') {
    const folder = folderAt(2)
    if (!folder) throw new Error(`folder of ${entry.path.raw} is not resolved`)
    proposal = {
      key: `folder:${folder.resourceId}`,
      grouping: 'folder',
      folderResourceId: folder.resourceId,
      title: folder.name,
      type,
      evidence: { ...evidence, path: folder.raw },
    }
  } else {
    const folder = placement.folderDepth === 1 ? folderAt(1) : undefined
    const folderId = folder?.resourceId ?? 'root'
    const loose = looseGroupOf(
      { fileId: entry.id ?? '', isVideo, shotAt: entry.shotAt, rootName },
      folderId,
      source.modelTimezone,
    )
    const base = { folderResourceId: folder?.resourceId ?? null, type, evidence }
    if (loose.grouping === 'single') {
      proposal = {
        ...base,
        key: loose.key,
        grouping: 'single',
        title: titleFromFileName(entry.name, type),
      }
    } else if (loose.grouping === 'exif_day') {
      proposal = {
        ...base,
        key: loose.key,
        grouping: 'exif_day',
        title: null,
        evidence: { ...evidence, day: loose.day },
      }
    } else {
      const at = Date.parse(entry.createdAt ?? entry.modifiedAt ?? new Date().toISOString())
      const { rows } = await tx.execute<{ group_key: string }>(sql`
        SELECT group_key FROM inbox_groups
         WHERE model_id = ${source.modelId}::uuid AND source_id = ${source.id}::uuid
           AND grouping = 'upload_cluster' AND starts_with(group_key, ${loose.prefix})`)
      const open = rows
        .map((row) => ({ key: row.group_key, start: clusterStart(row.group_key, loose.prefix) }))
        .find((cluster) => cluster.start !== null && fitsCluster(cluster.start, at))
      proposal = {
        ...base,
        key: open?.key ?? `${loose.prefix}${new Date(at).toISOString()}`,
        grouping: 'upload_cluster',
        title: null,
      }
    }
  }
  return ensureGroup(tx, source, proposal)
}

async function ensureGroup(tx: Tx, source: SourceRow, proposal: GroupProposal): Promise<string> {
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO inbox_groups (
      model_id, source_id, group_key, grouping, folder_object_id, evidence, proposed_type,
      proposed_title
    )
    SELECT ${source.modelId}::uuid, ${source.id}::uuid, ${proposal.key}, ${proposal.grouping},
           (SELECT id FROM source_objects
             WHERE model_id = ${source.modelId}::uuid AND source_id = ${source.id}::uuid
               AND resource_id = ${proposal.folderResourceId}),
           ${JSON.stringify(proposal.evidence)}::jsonb, ${proposal.type}, ${proposal.title}
    ON CONFLICT (model_id, source_id, group_key) DO NOTHING
    RETURNING id`)
  const [created] = inserted.rows
  if (created) return created.id
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM inbox_groups
     WHERE model_id = ${source.modelId}::uuid AND source_id = ${source.id}::uuid
       AND group_key = ${proposal.key}`)
  const [found] = rows
  if (!found) throw new Error(`group ${proposal.key} vanished`)
  return found.id
}

/** The draft of a revision; a file moved before acceptance follows its new group. */
async function ensureDraft(
  tx: Tx,
  source: SourceRow,
  groupId: string,
  revision: RevisionResult,
  entry: SourceEntry,
): Promise<boolean> {
  const { rows } = await tx.execute<{ id: string; group_id: string; state: string }>(sql`
    SELECT id, group_id, state FROM inbox_drafts
     WHERE model_id = ${source.modelId}::uuid AND source_revision_id = ${revision.id}::uuid
     FOR UPDATE`)
  const [existing] = rows
  if (existing) {
    if (existing.state !== 'resolved' && existing.group_id !== groupId) {
      await tx.execute(sql`
        UPDATE inbox_drafts
           SET group_id = ${groupId}::uuid, path = ${entry.path.raw}, updated_at = now(),
               row_version = row_version + 1
         WHERE model_id = ${source.modelId}::uuid AND id = ${existing.id}::uuid`)
    }
    return false
  }
  // New bytes of an accepted file: the draft proposes a new version of the same file.
  await tx.execute(sql`
    INSERT INTO inbox_drafts (
      model_id, group_id, source_revision_id, origin, priority, md5, byte_size, path,
      target_item_id, target_asset_id
    )
    SELECT ${source.modelId}::uuid, ${groupId}::uuid, ${revision.id}::uuid, 'disk_scan',
           ${SCAN_PRIORITY}, ${hex(entry.md5)}::bytea, ${entry.size ?? 0}, ${entry.path.raw},
           prior.applied_item_id, prior.asset_id
      FROM (SELECT NULL) AS one
      LEFT JOIN LATERAL (
        SELECT d.applied_item_id, v.asset_id
          FROM source_revisions r
          JOIN inbox_drafts d ON d.model_id = r.model_id AND d.source_revision_id = r.id
          LEFT JOIN asset_versions v ON v.model_id = d.model_id AND v.id = d.applied_version_id
         WHERE r.model_id = ${source.modelId}::uuid
           AND r.source_object_id = (SELECT source_object_id FROM source_revisions
                                      WHERE model_id = ${source.modelId}::uuid
                                        AND id = ${revision.id}::uuid)
           AND d.outcome IN ('new_item', 'append')
         ORDER BY r.sequence_no DESC LIMIT 1
      ) prior ON true`)
  return true
}

/**
 * Losses (SPEC §6.1): only after a complete full traversal, and only for objects that the
 * previous complete traversal did not see either (`last_seen_at` before its start). Drafts
 * without downloaded bytes are blocked «исходник недоступен»; a later sighting lifts it.
 */
export async function markLosses(
  db: Db,
  source: SourceRow,
  workId: string,
  previousCompleteStart: string,
): Promise<number> {
  const context = {
    actor: SYSTEM_ACTOR('scan'),
    action: 'source.loss',
    requestId: `scan:${workId}:loss`,
    workId,
  }
  return withActorTx(db, context, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`scan:${source.id}`}, 0))`)
    const { rows } = await tx.execute<{ id: string }>(sql`
      UPDATE source_objects SET gone_since = now()
       WHERE model_id = ${source.modelId}::uuid AND source_id = ${source.id}::uuid
         AND gone_since IS NULL AND resource_id IS NOT NULL
         AND last_seen_at < ${previousCompleteStart}::timestamptz
      RETURNING id`)
    if (rows.length === 0) return 0
    await tx.execute(sql`
      UPDATE inbox_drafts d
         SET blocked_reason = 'source_unavailable', updated_at = now(),
             row_version = d.row_version + 1
        FROM source_revisions r
       WHERE r.model_id = d.model_id AND r.id = d.source_revision_id
         AND d.model_id = ${source.modelId}::uuid
         AND r.source_object_id = ANY (${sql.param(rows.map((row) => row.id))}::uuid[])
         AND d.state <> 'resolved' AND d.source_blob_sha256 IS NULL
         AND d.blocked_reason IS NULL`)
    return rows.length
  })
}
