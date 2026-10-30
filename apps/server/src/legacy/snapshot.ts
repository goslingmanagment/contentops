import type { Queryable } from '@contentops/db'
import type { LegacyListingEntry } from '@contentops/legacy'
import { relativePath } from '@contentops/legacy'
import { sourcePath } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import { FREEZE_DATASET } from '../intake/freeze'

/**
 * The frozen snapshot as the importer reads it (SPEC §6.3): the revisions a `scan:freeze` work
 * pinned — files and archive members — and the folders the pass listed, each with its object.
 * The importer never looks at the cloud: the snapshot is rows of the database.
 */

export interface SnapshotWork {
  id: string
  modelId: string
  workKey: string
  sourceId: string
  sourceLabel: string
  sourceKind: string
  rootPath: string
  createdAt: string
  finishedAt: string
}

/** A listing row with the object (and the pinned revision) its claims belong to. */
export interface SnapshotEntry extends LegacyListingEntry {
  /** Root-relative NFC path, the key of the parsed entry. */
  relative: string
  /** The path at the source as the snapshot saw it (`disk:/1. PPV/…`). */
  raw: string
  objectId: string
  revisionId: string | null
}

/** The given finished snapshot of the model, or its latest one; `null` — none yet. */
export async function snapshotOf(
  q: Queryable,
  modelId: string,
  workId: string | null,
): Promise<SnapshotWork | null> {
  const { rows } = await q.execute<{
    id: string
    work_key: string
    scope: string
    label: string
    kind: string
    root_path: string | null
    created_at: string
    finished_at: string
  }>(sql`
    SELECT w.id, w.work_key, w.scope, s.label, s.kind, s.root_path,
           w.created_at::text AS created_at, w.finished_at::text AS finished_at
      FROM work_operations w
      JOIN sources s ON s.model_id = w.model_id AND s.id::text = w.scope
     WHERE w.model_id = ${modelId}::uuid AND w.kind = 'scan' AND w.dataset = ${FREEZE_DATASET}
       AND w.state = 'succeeded'
       AND (${workId}::uuid IS NULL OR w.id = ${workId}::uuid)
     ORDER BY w.finished_at DESC LIMIT 1`)
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    modelId,
    workKey: row.work_key,
    sourceId: row.scope,
    sourceLabel: row.label,
    sourceKind: row.kind,
    rootPath: row.root_path ?? '',
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }
}

const iso = (value: string | null) => (value === null ? null : new Date(value).toISOString())

/**
 * Every row of the snapshot: the pinned revisions (files and members of the archives it read),
 * the folders of the source seen by the time it finished, the folders inside the archives.
 * Inputs the pass could not read (`unreadable_input`) are marked incomplete.
 */
export async function snapshotListing(
  q: Queryable,
  snapshot: SnapshotWork,
): Promise<SnapshotEntry[]> {
  const relative = (raw: string) => relativePath(sourcePath(raw, snapshot.rootPath).relative)
  const { rows: files } = await q.execute<{
    revision_id: string
    object_id: string
    path: string
    resource_id: string | null
    md5: string | null
    sha256: string | null
    size: string
    created_at: string | null
    modified_at: string | null
    shot_at: string | null
    media_type: string | null
    archive_path: string | null
    entry_no: number | null
  }>(sql`
    SELECT r.id AS revision_id, o.id AS object_id, r.frozen_path AS path, o.resource_id,
           encode(r.md5, 'hex') AS md5, encode(r.remote_sha256, 'hex') AS sha256,
           r.byte_size::text AS size, r.remote_created_at::text AS created_at,
           r.remote_modified_at::text AS modified_at, r.remote_shot_at::text AS shot_at,
           r.media_type, ar.frozen_path AS archive_path, o.archive_entry_no AS entry_no
      FROM source_revisions r
      JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
      LEFT JOIN source_revisions ar ON ar.model_id = o.model_id AND ar.id = o.archive_revision_id
     WHERE r.model_id = ${snapshot.modelId}::uuid AND r.frozen_by_work_id = ${snapshot.id}::uuid`)
  const { rows: dirs } = await q.execute<{
    object_id: string
    path: string
    archive_path: string | null
    entry_no: number | null
  }>(sql`
    SELECT o.id AS object_id, o.current_path AS path, ar.frozen_path AS archive_path,
           o.archive_entry_no AS entry_no
      FROM source_objects o
      LEFT JOIN source_revisions ar ON ar.model_id = o.model_id AND ar.id = o.archive_revision_id
     WHERE o.model_id = ${snapshot.modelId}::uuid AND o.source_id = ${snapshot.sourceId}::uuid
       AND o.is_dir
       AND (o.archive_revision_id IS NULL
            AND o.first_seen_at <= ${snapshot.finishedAt}::timestamptz
            AND (o.gone_since IS NULL OR o.gone_since >= ${snapshot.createdAt}::timestamptz)
            OR ar.frozen_by_work_id = ${snapshot.id}::uuid)`)
  // Folders and archives the pass could not read: their review cases name the object.
  const { rows: unreadable } = await q.execute<{ object_id: string }>(sql`
    SELECT c.source_object_id AS object_id FROM review_cases c
      JOIN source_objects o ON o.model_id = c.model_id AND o.id = c.source_object_id
     WHERE c.model_id = ${snapshot.modelId}::uuid AND c.kind = 'unreadable_input'
       AND o.source_id = ${snapshot.sourceId}::uuid`)
  const incomplete = new Set(unreadable.map((row) => row.object_id))

  const out: SnapshotEntry[] = []
  for (const row of dirs) {
    const path = relative(row.path)
    if (path === '') continue
    out.push({
      path,
      relative: path,
      raw: row.path,
      isDir: true,
      objectId: row.object_id,
      revisionId: null,
      archiveEntry:
        row.archive_path && row.entry_no !== null
          ? { archivePath: relative(row.archive_path), entryNo: row.entry_no }
          : null,
      incomplete: incomplete.has(row.object_id),
    })
  }
  for (const row of files) {
    const path = relative(row.path)
    out.push({
      path,
      relative: path,
      raw: row.path,
      isDir: false,
      objectId: row.object_id,
      revisionId: row.revision_id,
      size: Number(row.size),
      md5: row.md5,
      sha256: row.sha256,
      createdAt: iso(row.created_at),
      modifiedAt: iso(row.modified_at),
      shotAt: iso(row.shot_at),
      resourceId: row.resource_id,
      mediaType: row.media_type,
      archiveEntry:
        row.archive_path && row.entry_no !== null
          ? { archivePath: relative(row.archive_path), entryNo: row.entry_no }
          : null,
      incomplete: incomplete.has(row.object_id),
    })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
