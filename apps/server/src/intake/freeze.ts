import { randomUUID } from 'node:crypto'
import {
  type Db,
  enqueueWork,
  SYSTEM_ACTOR,
  type WorkContext,
  WorkError,
  type WorkRow,
  type WorkSuccess,
  withActorTx,
} from '@contentops/db'
import { type CloudSource, isSourceError, type SourceEntry } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import { type ApplyStats, addStats, applyEntries, type ObservedFile } from './discover'
import { localDay, mediaKindOf } from './grouping'
import { cloudSources, type SourceRow } from './source-client'
import { readZipToc, type ZipMember, ZipTocError } from './zip-toc'

/**
 * The snapshot `scan:freeze:<date>` (SPEC §6.3, schema §3.4): the first full pass over a
 * source on the first day of stage 3, started only by the operator's command. Every file
 * becomes an object, its path and a revision (an observed one is reused, a changed one is the
 * next); every ZIP gets its table of contents as member objects with their own revisions, no
 * byte unpacked. Only a pass that went through pins: in the transaction that finishes the work
 * each revision it saw gets `frozen_by_work_id` and the path it was seen at, once. An
 * interrupted pass pins nothing and the work tries again. The snapshot writes no groups and no
 * drafts: drafts of the old corpus come from the import.
 *
 * Per-directory completeness is in the report: a folder whose listing breaks the API's
 * contract or an archive that cannot be read opens `unreadable_input` and is incomplete input
 * that does not hold the snapshot back; a folder that changed or vanished while listed makes
 * the pass partial, and the work goes again.
 */

export const FREEZE_DATASET = 'freeze'
const KEY_PREFIX = 'scan:freeze:'
/** Entries per transaction of the pass. */
const BATCH = 200

export const freezeKey = (date: string) => `${KEY_PREFIX}${date}`

/** Archives the pass meets; only ZIP has a table of contents it reads. */
const ARCHIVE_EXTS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'zst'])

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function isArchive(entry: SourceEntry): boolean {
  return ARCHIVE_EXTS.has(extOf(entry.name)) || entry.mediaType === 'compressed'
}

interface Incomplete {
  path: string
  reason: string
}

export interface FreezeReport extends Omit<ApplyStats, 'drafts' | 'dirs'> {
  mode: 'freeze'
  date: string
  started_at: string
  /** Every folder was listed completely and every archive read. */
  complete: boolean
  /** Folders listed; complete ones are all but `incomplete_dirs`. */
  dirs: number
  dirs_complete: number
  /** Folders whose listing could not be read: incomplete input with a review case. */
  incomplete_dirs: Incomplete[]
  archives: number
  archives_read: number
  /** Archives without a table of contents: incomplete input with a review case. */
  unreadable_archives: Incomplete[]
  /** Files inside the archives read: their own denominator in the reconciliation. */
  members: number
  member_dirs: number
  /** Revisions this snapshot pinned (files and members). */
  pinned: number
  /** Revisions seen that an earlier snapshot had pinned already. */
  pinned_before: number
}

/** The pass. Network calls stay outside transactions; batches are serialised per source. */
export async function freezeSource(
  ctx: WorkContext,
  source: SourceRow,
  client: CloudSource,
): Promise<WorkSuccess> {
  const { db, work, signal, checkpoint } = ctx
  const { rows } = await db.execute<{ at: string }>(sql`SELECT now()::text AS at`)
  const report: FreezeReport = {
    mode: 'freeze',
    date: work.workKey.slice(KEY_PREFIX.length),
    started_at: (rows[0] as { at: string }).at,
    complete: false,
    files: 0,
    dirs: 0,
    revisions: 0,
    moved: 0,
    dirs_complete: 0,
    incomplete_dirs: [],
    archives: 0,
    archives_read: 0,
    unreadable_archives: [],
    members: 0,
    member_dirs: 0,
    pinned: 0,
    pinned_before: 0,
  }
  /** Revision → the path it was seen at in this pass. */
  const seen = new Map<string, string>()
  /** Archive revisions of the pass, once each even if seen at two paths. */
  const archives = new Map<string, ObservedFile>()
  const stats: ApplyStats = { files: 0, dirs: 0, revisions: 0, drafts: 0, moved: 0 }
  const progress = (note: string) =>
    checkpoint({ progress: { num: seen.size, note: `снимок: ${note}` } })

  let batch: SourceEntry[] = []
  const flush = async () => {
    if (batch.length === 0) return
    const applied = await applyEntries(db, {
      source,
      client,
      workId: work.id,
      entries: batch,
      folders: new Map(),
      drafts: false,
      onFile: (file) => {
        seen.set(file.revisionId, file.entry.path.raw)
        if (isArchive(file.entry)) archives.set(file.revisionId, file)
      },
    })
    addStats(stats, applied)
    batch = []
    await progress(`${stats.files} файлов`)
  }
  const incomplete: (Incomplete & { id: string | null; relative: string })[] = []
  let ended = false
  for await (const event of client.traverse(undefined, { signal })) {
    if (event.type === 'entry') {
      batch.push(event.entry)
      if (batch.length >= BATCH) await flush()
    } else if (event.type === 'dir') {
      report.dirs += 1
      if (event.complete) report.dirs_complete += 1
      else {
        incomplete.push({
          path: event.path.raw,
          id: event.id,
          relative: event.path.relative,
          reason: event.reason ?? 'incomplete',
        })
      }
    } else ended = true
  }
  await flush()
  // A folder that changed or vanished while listed, or a listing that broke off as a whole
  // (Dropbox lists everything in one go), is not a snapshot: the work goes again.
  const partial = incomplete.filter((dir) => dir.relative === '' || dir.reason !== 'bad_response')
  if (!ended || partial.length > 0) {
    throw new WorkError(
      'transient',
      'listing_incomplete',
      `проход неполон: ${partial.length} каталогов (${partial[0]?.reason ?? 'обрыв'})`,
    )
  }
  for (const dir of incomplete) {
    await openUnreadable(db, source, work.id, {
      key: `dir:${dir.id ?? dir.path}`,
      resourceId: dir.id,
      path: dir.path,
      relative: dir.relative,
      reason: dir.reason,
      title: 'Каталог не читается',
    })
    report.incomplete_dirs.push({ path: dir.path, reason: dir.reason })
  }

  for (const archive of archives.values()) {
    report.archives += 1
    const outcome = await tableOfContents(ctx, source, client, archive)
    if ('reason' in outcome) {
      report.unreadable_archives.push({ path: archive.entry.path.raw, reason: outcome.reason })
    } else {
      report.archives_read += 1
      for (const member of outcome.members) {
        if (member.revisionId) {
          report.members += 1
          seen.set(member.revisionId, member.path)
        } else report.member_dirs += 1
      }
    }
    await progress(`оглавления архивов ${report.archives} из ${archives.size}`)
  }

  report.files = stats.files
  report.revisions = stats.revisions
  report.moved = stats.moved
  report.complete = report.incomplete_dirs.length === 0 && report.unreadable_archives.length === 0
  const ids = [...seen.keys()]
  const paths = [...seen.values()]
  return {
    report,
    // The pin is written with the success of the work, by the holder of its lease only.
    commit: async (tx) => {
      const pinned = await tx.execute<{ id: string }>(sql`
        UPDATE source_revisions r
           SET frozen_by_work_id = ${work.id}::uuid, frozen_path = x.path
          FROM unnest(${sql.param(ids)}::uuid[], ${sql.param(paths)}::text[]) AS x(id, path)
         WHERE r.model_id = ${source.modelId}::uuid AND r.id = x.id
           AND r.frozen_by_work_id IS NULL
        RETURNING r.id`)
      report.pinned = pinned.rows.length
      report.pinned_before = ids.length - pinned.rows.length
    },
  }
}

interface MemberRow {
  revisionId: string | null
  path: string
}

type TocOutcome = { members: MemberRow[] } | { reason: string }

/**
 * The table of contents of one archive revision: read once, kept as rows. A later pass finds
 * the rows (or the open case) and reads nothing.
 */
async function tableOfContents(
  ctx: WorkContext,
  source: SourceRow,
  client: CloudSource,
  archive: ObservedFile,
): Promise<TocOutcome> {
  const { db, signal } = ctx
  const recorded = await membersOf(db, source, archive.revisionId)
  if (recorded.length > 0) return { members: recorded }
  const { rows } = await db.execute<{ reason: string | null }>(sql`
    SELECT details ->> 'reason' AS reason FROM review_cases
     WHERE model_id = ${source.modelId}::uuid AND kind = 'unreadable_input'
       AND dedup_key = ${`archive:${archive.revisionId}`}`)
  if (rows[0]) return { reason: rows[0].reason ?? 'unreadable' }

  const { entry } = archive
  const unreadable = async (reason: string): Promise<TocOutcome> => {
    await openUnreadable(db, source, ctx.work.id, {
      key: `archive:${archive.revisionId}`,
      objectId: archive.objectId,
      path: entry.path.raw,
      relative: entry.path.relative,
      reason,
      title: 'Архив не читается',
      revisionId: archive.revisionId,
    })
    return { reason }
  }
  if (extOf(entry.name) !== 'zip') return unreadable(`format:${extOf(entry.name) || 'unknown'}`)
  let members: ZipMember[]
  try {
    members = await readZipToc(
      entry.size ?? 0,
      (start, length) => readRange(client, entry, start, length, signal),
      source.modelTimezone,
    )
  } catch (error) {
    if (error instanceof ZipTocError) return unreadable(error.reason)
    // Auth, rate limit and outage stop the pass; a vanished or refused file is unreadable.
    if (isSourceError(error) && !error.retryable && error.kind !== 'auth_rejected') {
      return unreadable(error.kind)
    }
    throw error
  }
  await recordMembers(db, source, ctx.work.id, archive, members)
  return { members: await membersOf(db, source, archive.revisionId) }
}

/** `length` bytes from `start` through the source's download with a Range start. */
async function readRange(
  client: CloudSource,
  entry: SourceEntry,
  start: number,
  length: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const body = await client.download(entry, { offset: start, signal })
  // Other bytes than the listing saw: the table of contents would not be this revision's.
  if (body.totalSize !== null && body.totalSize !== entry.size) {
    throw new ZipTocError('changed_while_reading')
  }
  const out = Buffer.alloc(length)
  let filled = 0
  let position = body.offset
  for await (const chunk of body.body) {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    // A host that ignored the Range sends the file from 0: skip up to `start`.
    const from = Math.max(0, start - position)
    if (from < bytes.length) {
      const n = Math.min(bytes.length - from, length - filled)
      bytes.copy(out, filled, from, from + n)
      filled += n
    }
    position += bytes.length
    // Leaving the loop cancels the rest of the body.
    if (filled >= length) break
  }
  return out.subarray(0, filled)
}

async function membersOf(db: Db, source: SourceRow, archiveRevisionId: string) {
  const { rows } = await db.execute<{ revision_id: string | null; path: string }>(sql`
    SELECT current_revision_id AS revision_id, current_path AS path FROM source_objects
     WHERE model_id = ${source.modelId}::uuid AND archive_revision_id = ${archiveRevisionId}::uuid
     ORDER BY archive_entry_no`)
  return rows.map((row): MemberRow => ({ revisionId: row.revision_id, path: row.path }))
}

/** Members as objects of the archive's source, each file with its first revision. */
async function recordMembers(
  db: Db,
  source: SourceRow,
  workId: string,
  archive: ObservedFile,
  members: readonly ZipMember[],
): Promise<void> {
  if (members.length === 0) return
  const rows = members.map((member) => {
    const name = member.name.slice(member.name.lastIndexOf('/') + 1)
    const ext = extOf(name)
    return {
      no: member.no,
      path: `${archive.entry.path.raw}/${member.name}`,
      name,
      is_dir: member.isDir,
      size: member.size,
      crc: member.crc32.toString(16).padStart(8, '0'),
      modified: member.modifiedAt,
      media: member.isDir
        ? null
        : (mediaKindOf(name, null) ?? (ARCHIVE_EXTS.has(ext) ? 'compressed' : null)),
    }
  })
  const input = JSON.stringify(rows)
  const context = {
    actor: SYSTEM_ACTOR('scan'),
    action: 'source.freeze',
    requestId: `scan:${workId}:toc:${archive.revisionId}`,
    workId,
  }
  await withActorTx(db, context, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`scan:${source.id}`}, 0))`)
    const inserted = await tx.execute(sql`
      INSERT INTO source_objects (
        model_id, source_id, current_path, current_name, is_dir, archive_revision_id,
        archive_entry_no
      )
      SELECT ${source.modelId}::uuid, ${source.id}::uuid, x.path, x.name, x.is_dir,
             ${archive.revisionId}::uuid, x.no
        FROM jsonb_to_recordset(${input}::jsonb) AS x(no integer, path text, name text, is_dir boolean)
      ON CONFLICT (model_id, archive_revision_id, archive_entry_no) DO NOTHING
      RETURNING id`)
    // Another pass recorded this table of contents first.
    if (inserted.rows.length === 0) return
    await tx.execute(sql`
      INSERT INTO source_paths (model_id, source_object_id, path_raw, name)
      SELECT model_id, id, current_path, current_name FROM source_objects
       WHERE model_id = ${source.modelId}::uuid AND archive_revision_id = ${archive.revisionId}::uuid
      ON CONFLICT DO NOTHING`)
    await tx.execute(sql`
      INSERT INTO source_revisions (
        model_id, source_object_id, sequence_no, byte_size, crc32, remote_modified_at,
        media_type, scan_work_id
      )
      SELECT o.model_id, o.id, 1, x.size, decode(x.crc, 'hex'), x.modified, x.media,
             ${workId}::uuid
        FROM source_objects o
        JOIN jsonb_to_recordset(${input}::jsonb)
             AS x(no integer, size bigint, crc text, modified timestamptz, media text)
          ON x.no = o.archive_entry_no
       WHERE o.model_id = ${source.modelId}::uuid
         AND o.archive_revision_id = ${archive.revisionId}::uuid AND NOT o.is_dir`)
    await tx.execute(sql`
      UPDATE source_objects o SET current_revision_id = r.id
        FROM source_revisions r
       WHERE r.model_id = o.model_id AND r.source_object_id = o.id
         AND o.model_id = ${source.modelId}::uuid
         AND o.archive_revision_id = ${archive.revisionId}::uuid`)
  })
}

/** `unreadable_input` (schema §3.4): once per folder or archive revision. */
async function openUnreadable(
  db: Db,
  source: SourceRow,
  workId: string,
  input: {
    key: string
    title: string
    path: string
    relative: string
    reason: string
    objectId?: string
    resourceId?: string | null
    revisionId?: string
  },
): Promise<void> {
  const details = {
    title: input.title,
    root: input.relative.split('/')[0] ?? '',
    fragment: input.path.slice(input.path.lastIndexOf('/') + 1),
    path: input.path,
    reason: input.reason,
    source: source.label,
    work_id: workId,
    ...(input.revisionId ? { revision_id: input.revisionId } : {}),
  }
  const context = {
    actor: SYSTEM_ACTOR('scan'),
    action: 'source.freeze',
    requestId: `scan:${workId}:case:${input.key}`,
    workId,
  }
  await withActorTx(db, context, async (tx) => {
    await tx.execute(sql`
      INSERT INTO review_cases (model_id, kind, dedup_key, source_object_id, details)
      VALUES (
        ${source.modelId}::uuid, 'unreadable_input', ${input.key},
        coalesce(${input.objectId ?? null}::uuid,
                 (SELECT id FROM source_objects
                   WHERE model_id = ${source.modelId}::uuid AND source_id = ${source.id}::uuid
                     AND resource_id = ${input.resourceId ?? null})),
        ${JSON.stringify(details)}::jsonb
      )
      ON CONFLICT (model_id, kind, dedup_key) DO NOTHING`)
  })
}

/**
 * Puts the snapshot of a source for a date (the model's today by default). One snapshot per
 * model and date: a repeat finds the same work; another source on a taken date is refused.
 */
export async function enqueueFreeze(
  db: Db,
  input: { model: string; source: string; date?: string },
): Promise<{ work: WorkRow; created: boolean; source: SourceRow; date: string }> {
  const { rows } = await db.execute<{ id: string; timezone: string }>(sql`
    SELECT id, timezone FROM models WHERE code = ${input.model} AND archived_at IS NULL`)
  const model = rows[0]
  if (!model) throw new Error(`нет модели ${input.model}`)
  const source = (await cloudSources(db, model.id)).find((row) => row.label === input.source)
  if (!source) throw new Error(`у модели ${input.model} нет облачного источника «${input.source}»`)
  const date = input.date ?? localDay(new Date().toISOString(), model.timezone)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    throw new Error(`дата ${date}: нужна ГГГГ-ММ-ДД`)
  }
  const context = {
    actor: SYSTEM_ACTOR('ops'),
    action: 'source.freeze',
    requestId: randomUUID(),
  }
  const { work, created } = await withActorTx(db, context, (tx) =>
    enqueueWork(tx, {
      modelId: model.id,
      kind: 'scan',
      workKey: freezeKey(date),
      dataset: FREEZE_DATASET,
      scope: source.id,
      priority: 5,
    }),
  )
  if (work.scope !== source.id) {
    throw new Error(`снимок ${freezeKey(date)} уже есть у другого источника модели`)
  }
  return { work, created, source, date }
}

export interface FreezeHeader {
  kind: 'snapshot'
  work_id: string
  work_key: string
  model: string
  source: string
  source_kind: string
  finished_at: string
  report: FreezeReport
}

/**
 * The register of one finished snapshot, a line per pinned revision (SPEC §6.3: the bulk
 * export is only on command): a file with its id, path, sums, size, times and type; a member
 * of an archive with the archive's revision, its entry number, size and CRC-32.
 */
export async function* freezeRegister(
  db: Db,
  input: { model: string; date?: string },
): AsyncGenerator<Record<string, unknown>> {
  const { rows } = await db.execute<{
    id: string
    model_id: string
    work_key: string
    finished_at: string
    report: FreezeReport
    label: string
    kind: string
  }>(sql`
    SELECT w.id, w.model_id, w.work_key, w.finished_at::text, w.report, s.label, s.kind
      FROM work_operations w
      JOIN models m ON m.id = w.model_id
      JOIN sources s ON s.model_id = w.model_id AND s.id::text = w.scope
     WHERE m.code = ${input.model} AND w.kind = 'scan' AND w.dataset = ${FREEZE_DATASET}
       AND w.state = 'succeeded'
       AND (${input.date ?? null}::text IS NULL OR w.work_key = ${freezeKey(input.date ?? '')})
     ORDER BY w.finished_at DESC LIMIT 1`)
  const work = rows[0]
  if (!work)
    throw new Error(
      `у модели ${input.model} нет готового снимка${input.date ? ` на ${input.date}` : ''}`,
    )
  yield {
    kind: 'snapshot',
    work_id: work.id,
    work_key: work.work_key,
    model: input.model,
    source: work.label,
    source_kind: work.kind,
    finished_at: work.finished_at,
    report: work.report,
  } satisfies FreezeHeader
  let after = '00000000-0000-0000-0000-000000000000'
  for (;;) {
    const page = await db.execute<{
      id: string
      sequence_no: number
      resource_id: string | null
      archive_revision_id: string | null
      archive_resource_id: string | null
      archive_entry_no: number | null
      path: string
      md5: string | null
      sha256: string | null
      content_hash: string | null
      rev: string | null
      size: string
      crc32: string | null
      created_at: string | null
      modified_at: string | null
      shot_at: string | null
      media_type: string | null
    }>(sql`
      SELECT r.id, r.sequence_no, o.resource_id, o.archive_revision_id,
             ao.resource_id AS archive_resource_id, o.archive_entry_no, r.frozen_path AS path,
             encode(r.md5, 'hex') AS md5, encode(r.remote_sha256, 'hex') AS sha256,
             encode(r.content_hash, 'hex') AS content_hash, r.remote_rev AS rev,
             r.byte_size::text AS size, encode(r.crc32, 'hex') AS crc32,
             r.remote_created_at AS created_at, r.remote_modified_at AS modified_at,
             r.remote_shot_at AS shot_at, r.media_type
        FROM source_revisions r
        JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
        LEFT JOIN source_revisions ar
               ON ar.model_id = o.model_id AND ar.id = o.archive_revision_id
        LEFT JOIN source_objects ao ON ao.model_id = ar.model_id AND ao.id = ar.source_object_id
       WHERE r.model_id = ${work.model_id}::uuid AND r.frozen_by_work_id = ${work.id}::uuid
         AND r.id > ${after}::uuid
       ORDER BY r.id LIMIT 1000`)
    if (page.rows.length === 0) return
    for (const row of page.rows) {
      const times = {
        modified_at: iso(row.modified_at),
        media_type: row.media_type,
      }
      yield row.archive_revision_id
        ? {
            kind: 'member',
            revision_id: row.id,
            archive_revision_id: row.archive_revision_id,
            archive_resource_id: row.archive_resource_id,
            entry_no: row.archive_entry_no,
            path: row.path,
            size: Number(row.size),
            crc32: row.crc32,
            ...times,
          }
        : {
            kind: 'file',
            revision_id: row.id,
            sequence_no: row.sequence_no,
            resource_id: row.resource_id,
            path: row.path,
            md5: row.md5,
            sha256: row.sha256,
            content_hash: row.content_hash,
            rev: row.rev,
            size: Number(row.size),
            created_at: iso(row.created_at),
            shot_at: iso(row.shot_at),
            ...times,
          }
      after = row.id
    }
  }
}

function iso(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}
