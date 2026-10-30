import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, copyFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32, createInflateRaw } from 'node:zlib'
import { type Db, type Tx, WorkError, type WorkHandler, type WorkSuccess } from '@contentops/db'
import { downloadVerified, isSourceError, type RetryPolicy, sourcePath } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import { afterFetch } from '../intake/fetch'
import { mediaKindOf } from '../intake/grouping'
import { scanFailure } from '../intake/scan'
import { type SourceFactory, sourceById } from '../intake/source-client'
import { readZipToc, type ZipMember, ZipTocError } from '../intake/zip-toc'
import type { BlobStore } from '../media/storage'
import { extOfName, shaBytes } from '../media/storage'
import { copyFromLocal, type LegacyCopyConfig } from './copy'

/**
 * `unpack_archive` (SPEC §6.3 «Архивы распаковываются рекурсивно, каждый один раз на
 * проверенные байты, в `/srv/tmp`»): the archive's bytes — from the local copy or the API, the
 * frozen revision checked — are unpacked once per SHA-256 into `TMP_ROOT/unpack/<sha256>/`;
 * every member is checked by its CRC-32 and size, staged under its own SHA-256 and goes on
 * through intake (`afterFetch`): an exact duplicate becomes an alias, the rest gets its master.
 * The container never becomes a blob; its members are bound to its revision. Two equal
 * archives share one unpacked result. A ZIP inside is unpacked the same way, its members
 * recorded under the member's revision.
 */

export interface UnpackDeps {
  factory: SourceFactory
  store: BlobStore
  legacyCopy?: LegacyCopyConfig
  retry?: RetryPolicy
}

/** One unpacked member, with what is inside when it is an archive itself. */
interface IndexEntry {
  no: number
  name: string
  size: number
  sha256: string | null
  error: string | null
  members?: IndexEntry[]
}

const MAX_DEPTH = 4
const ARCHIVE = /\.zip$/i

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

/** Reads a local file by ranges, for the table of contents. */
async function tocOf(path: string, size: number, timezone: string): Promise<ZipMember[]> {
  const handle = await open(path, 'r')
  try {
    return await readZipToc(
      size,
      async (start, length) => {
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, start)
        return buffer.subarray(0, bytesRead)
      },
      timezone,
    )
  } finally {
    await handle.close()
  }
}

/** One member into `target`: stored or deflated, its size and CRC-32 checked; its SHA-256. */
async function extractMember(archive: string, member: ZipMember, target: string): Promise<string> {
  if (member.encrypted) throw new ZipTocError('encrypted')
  if (member.method !== 0 && member.method !== 8) throw new ZipTocError(`method_${member.method}`)
  const handle = await open(archive, 'r')
  let dataStart: number
  try {
    const header = Buffer.alloc(30)
    await handle.read(header, 0, 30, member.localOffset)
    if (header.readUInt32LE(0) !== 0x04034b50) throw new ZipTocError('bad_local_header')
    dataStart = member.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
  } finally {
    await handle.close()
  }
  const sha = createHash('sha256')
  let crc = 0
  let size = 0
  const check = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      sha.update(chunk)
      crc = crc32(chunk, crc)
      size += chunk.length
      done(null, chunk)
    },
  })
  const read = createReadStream(archive, {
    start: dataStart,
    end: dataStart + member.compressedSize - 1,
  })
  if (member.compressedSize === 0) {
    await writeFile(target, Buffer.alloc(0))
  } else if (member.method === 8) {
    await pipeline(read, createInflateRaw(), check, createWriteStream(target))
  } else {
    await pipeline(read, check, createWriteStream(target))
  }
  if (size !== member.size) throw new ZipTocError('size_mismatch')
  if (crc >>> 0 !== member.crc32 >>> 0) throw new ZipTocError('crc_mismatch')
  return sha.digest('hex')
}

/** Unpacks into `dir` (a fresh directory), recursively; the index of what came out. */
async function unpackInto(
  archive: string,
  size: number,
  dir: string,
  timezone: string,
  depth: number,
): Promise<IndexEntry[]> {
  await mkdir(dir, { recursive: true })
  const members = await tocOf(archive, size, timezone)
  const out: IndexEntry[] = []
  for (const member of members) {
    if (member.isDir) continue
    const target = join(dir, String(member.no))
    const entry: IndexEntry = {
      no: member.no,
      name: member.name,
      size: member.size,
      sha256: null,
      error: null,
    }
    try {
      entry.sha256 = await extractMember(archive, member, target)
    } catch (error) {
      if (!(error instanceof ZipTocError)) throw error
      entry.error = error.reason
      await rm(target, { force: true })
    }
    if (entry.sha256 && ARCHIVE.test(member.name) && depth < MAX_DEPTH) {
      try {
        entry.members = await unpackInto(target, member.size, `${target}.d`, timezone, depth + 1)
      } catch (error) {
        if (!(error instanceof ZipTocError)) throw error
        entry.members = []
        entry.error = `nested:${error.reason}`
      }
    }
    out.push(entry)
  }
  return out
}

interface ArchiveRow extends Record<string, unknown> {
  revision_id: string
  object_id: string
  source_id: string
  resource_id: string | null
  current_path: string
  current_name: string
  byte_size: string
  md5: string | null
  remote_sha256: string | null
  source_sha256: string | null
  timezone: string
}

async function archiveOf(db: Db, modelId: string, revisionId: string): Promise<ArchiveRow> {
  const { rows } = await db.execute<ArchiveRow>(sql`
    SELECT r.id AS revision_id, o.id AS object_id, o.source_id, o.resource_id, o.current_path,
           o.current_name, r.byte_size, encode(r.md5, 'hex') AS md5,
           encode(r.remote_sha256, 'hex') AS remote_sha256,
           encode(r.source_sha256, 'hex') AS source_sha256, m.timezone
      FROM source_revisions r
      JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
      JOIN models m ON m.id = r.model_id
     WHERE r.model_id = ${modelId}::uuid AND r.id = ${revisionId}::uuid`)
  const row = rows[0]
  if (!row) throw new WorkError('permanent', 'revision_missing', 'ревизии архива нет')
  return row
}

/** Blocks the open drafts of the archive's members: no bytes for them (SPEC §6.3). */
async function blockMembers(tx: Tx, modelId: string, revisionId: string, error: string) {
  await tx.execute(sql`
    UPDATE inbox_drafts d
       SET blocked_reason = 'source_unavailable', error = ${error}, updated_at = now(),
           row_version = d.row_version + 1
      FROM source_revisions r
      JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
     WHERE r.model_id = d.model_id AND r.id = d.source_revision_id
       AND d.model_id = ${modelId}::uuid AND o.archive_revision_id = ${revisionId}::uuid
       AND d.state <> 'resolved' AND d.source_sha256 IS NULL`)
}

export function unpackArchiveHandler(deps: UnpackDeps): WorkHandler {
  return async ({ work, db, signal }): Promise<WorkSuccess> => {
    if (!work.modelId || !work.sourceRevisionId) {
      throw new WorkError('permanent', 'no_target', 'распаковка без ревизии архива')
    }
    const modelId = work.modelId
    const row = await archiveOf(db, modelId, work.sourceRevisionId)
    const unpackRoot = join(deps.store.roots.tmpRoot, 'unpack')
    let sha = row.source_sha256
    let route: 'download' | 'local_copy' = 'download'
    // Two equal archives share one result: unpacked already under this SHA-256.
    if (!sha || !(await exists(join(unpackRoot, sha, 'index.json')))) {
      const fetched = await fetchArchive(deps, db, row, signal)
      if ('blocked' in fetched) {
        return {
          report: { blocked: fetched.blocked },
          commit: (tx) => blockMembers(tx, modelId, row.revision_id, fetched.blocked),
        }
      }
      sha = fetched.sha256
      route = fetched.route
      const dir = join(unpackRoot, sha)
      if (!(await exists(join(dir, 'index.json')))) {
        const part = `${dir}.part-${work.id}`
        await rm(part, { recursive: true, force: true })
        let index: IndexEntry[]
        try {
          index = await unpackInto(fetched.path, Number(row.byte_size), part, row.timezone, 0)
        } catch (error) {
          await rm(part, { recursive: true, force: true })
          await rm(fetched.path, { force: true })
          if (!(error instanceof ZipTocError)) throw error
          return {
            report: { unreadable: error.reason },
            commit: (tx) => blockMembers(tx, modelId, row.revision_id, `archive:${error.reason}`),
          }
        }
        await writeFile(join(part, 'index.json'), JSON.stringify(index))
        await rm(dir, { recursive: true, force: true })
        await rename(part, dir)
      }
      // The container is no blob: its bytes go once they are unpacked.
      await rm(fetched.path, { force: true })
    }
    const dir = join(unpackRoot, sha)
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as IndexEntry[]
    await stageAll(deps.store, dir, index)
    const archiveSha = sha
    return {
      report: { sha256: sha, members: index.length, route },
      commit: async (tx) => {
        await tx.execute(sql`
          UPDATE source_revisions
             SET source_sha256 = ${shaBytes(archiveSha)}, verified_at = now(), verified_route = ${route}
           WHERE model_id = ${modelId}::uuid AND id = ${row.revision_id}::uuid
             AND source_sha256 IS NULL`)
        await bindMembers(tx, modelId, row, row.revision_id, index, route, work.id)
      },
    }
  }
}

type Fetched =
  | { path: string; sha256: string; route: 'download' | 'local_copy' }
  | { blocked: string }

/** The archive's bytes: the local copy when the list allows it, else the frozen revision by API. */
async function fetchArchive(
  deps: UnpackDeps,
  db: Db,
  row: ArchiveRow,
  signal: AbortSignal,
): Promise<Fetched> {
  const dir = join(deps.store.roots.tmpRoot, 'fetch')
  await mkdir(dir, { recursive: true })
  if (deps.legacyCopy) {
    const copied = await copyFromLocal(deps.legacyCopy, {
      apiPath: row.current_path,
      size: Number(row.byte_size),
      md5: row.md5,
      sha256: row.remote_sha256,
      target: join(dir, `${row.revision_id}.copy.zip`),
      signal,
    })
    if (copied.status === 'copied') {
      return { path: copied.path, sha256: copied.sha256, route: 'local_copy' }
    }
  }
  const source = await sourceById(db, row.source_id)
  const client = source ? deps.factory(source) : null
  if (!source || !client || !row.resource_id) {
    throw new WorkError('permanent', 'not_configured', 'источник архива не настроен')
  }
  try {
    const result = await downloadVerified(
      client,
      {
        source: source.kind,
        id: row.resource_id,
        isDir: false,
        name: row.current_name,
        path: sourcePath(row.current_path, client.root),
        parentPath: null,
        size: Number(row.byte_size),
        md5: row.md5,
        sha256: row.remote_sha256,
        contentHash: null,
        rev: null,
        createdAt: null,
        modifiedAt: null,
        shotAt: null,
        mediaType: null,
        mimeType: null,
        previewUrl: null,
      },
      {
        targetDir: dir,
        fileName: `${row.revision_id}.zip`,
        signal,
        ...(deps.retry ? { retry: deps.retry } : {}),
      },
    )
    if (result.status === 'changed') return { blocked: `changed:${result.reason}` }
    return { path: result.path, sha256: result.sha256, route: 'download' }
  } catch (error) {
    if (isSourceError(error, 'not_found')) return { blocked: 'gone' }
    throw scanFailure(error)
  }
}

/** Every member's bytes under its SHA-256 in `staging/`, where the media works find them. */
async function stageAll(store: BlobStore, dir: string, index: readonly IndexEntry[]) {
  await mkdir(store.stagingDir, { recursive: true })
  const walk = async (base: string, entries: readonly IndexEntry[]) => {
    for (const entry of entries) {
      if (entry.sha256 && !ARCHIVE.test(entry.name)) {
        const ext = extOfName(entry.name) || 'bin'
        const target = join(store.stagingDir, `${entry.sha256}.${ext}`)
        if (!(await store.staged(entry.sha256))) {
          await copyFile(join(base, String(entry.no)), `${target}.tmp`)
          await rename(`${target}.tmp`, target)
        }
      }
      if (entry.members) await walk(join(base, `${entry.no}.d`), entry.members)
    }
  }
  await walk(dir, index)
}

/**
 * The members of an archive revision get their checked bytes; their drafts go on through
 * intake. Members of a ZIP inside are recorded as objects under the member's revision and get
 * drafts in the same group.
 */
async function bindMembers(
  tx: Tx,
  modelId: string,
  archive: ArchiveRow,
  revisionId: string,
  index: readonly IndexEntry[],
  route: 'download' | 'local_copy',
  workId: string,
): Promise<void> {
  const { rows: members } = await tx.execute<{
    object_id: string
    revision_id: string | null
    entry_no: number
    path: string
    draft_id: string | null
    group_id: string | null
  }>(sql`
    SELECT o.id AS object_id, o.current_revision_id AS revision_id, o.archive_entry_no AS entry_no,
           o.current_path AS path, d.id AS draft_id, d.group_id
      FROM source_objects o
      LEFT JOIN inbox_drafts d ON d.model_id = o.model_id AND d.source_revision_id = o.current_revision_id
     WHERE o.model_id = ${modelId}::uuid AND o.archive_revision_id = ${revisionId}::uuid
       AND NOT o.is_dir`)
  const groupId = members.find((m) => m.group_id)?.group_id ?? null
  const byNo = new Map(members.map((m) => [m.entry_no, m]))
  for (const entry of index) {
    let member = byNo.get(entry.no)
    if (!member && revisionId !== archive.revision_id) {
      member = await recordNested(tx, modelId, archive, revisionId, entry, groupId)
    }
    if (!member?.revision_id) continue
    if (entry.sha256) {
      await tx.execute(sql`
        UPDATE source_revisions
           SET source_sha256 = ${shaBytes(entry.sha256)}, verified_at = now(), verified_route = ${route}
         WHERE model_id = ${modelId}::uuid AND id = ${member.revision_id}::uuid
           AND source_sha256 IS NULL`)
    }
    if (member.draft_id) {
      if (entry.sha256) {
        await afterFetch(tx, modelId, member.draft_id, entry.sha256, workId)
      } else {
        await tx.execute(sql`
          UPDATE inbox_drafts
             SET blocked_reason = 'source_unavailable', error = ${`archive:${entry.error}`},
                 updated_at = now(), row_version = row_version + 1
           WHERE model_id = ${modelId}::uuid AND id = ${member.draft_id}::uuid
             AND state <> 'resolved'`)
      }
    }
    if (entry.members && member.revision_id) {
      await bindMembers(tx, modelId, archive, member.revision_id, entry.members, route, workId)
    }
  }
}

/** A member of a ZIP inside the archive: its object, its revision and, for media, a draft. */
async function recordNested(
  tx: Tx,
  modelId: string,
  archive: ArchiveRow,
  parentRevisionId: string,
  entry: IndexEntry,
  groupId: string | null,
) {
  const { rows: parent } = await tx.execute<{ path: string }>(sql`
    SELECT o.current_path AS path FROM source_revisions r
      JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
     WHERE r.model_id = ${modelId}::uuid AND r.id = ${parentRevisionId}::uuid`)
  const path = `${parent[0]?.path ?? archive.current_path}/${entry.name}`
  const name = entry.name.slice(entry.name.lastIndexOf('/') + 1)
  await tx.execute(sql`
    INSERT INTO source_objects (model_id, source_id, current_path, current_name, archive_revision_id,
                                archive_entry_no)
    VALUES (${modelId}::uuid, ${archive.source_id}::uuid, ${path}, ${name},
            ${parentRevisionId}::uuid, ${entry.no})
    ON CONFLICT (model_id, archive_revision_id, archive_entry_no) DO NOTHING`)
  const { rows: objects } = await tx.execute<{ id: string; revision_id: string | null }>(sql`
    SELECT id, current_revision_id AS revision_id FROM source_objects
     WHERE model_id = ${modelId}::uuid AND archive_revision_id = ${parentRevisionId}::uuid
       AND archive_entry_no = ${entry.no}`)
  const object = objects[0] as { id: string; revision_id: string | null }
  let revisionId = object.revision_id
  if (!revisionId) {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO source_revisions (model_id, source_object_id, sequence_no, byte_size)
      VALUES (${modelId}::uuid, ${object.id}::uuid, 1, ${entry.size})
      RETURNING id`)
    revisionId = (rows[0] as { id: string }).id
    await tx.execute(sql`
      UPDATE source_objects SET current_revision_id = ${revisionId}::uuid
       WHERE model_id = ${modelId}::uuid AND id = ${object.id}::uuid`)
  }
  let draftId: string | null = null
  if (groupId && mediaKindOf(name, null) && !ARCHIVE.test(name)) {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO inbox_drafts (model_id, group_id, source_revision_id, origin, priority,
                                byte_size, path)
      VALUES (${modelId}::uuid, ${groupId}::uuid, ${revisionId}::uuid, 'archive', 1, ${entry.size},
              ${path})
      ON CONFLICT DO NOTHING
      RETURNING id`)
    draftId = rows[0]?.id ?? null
  }
  return {
    object_id: object.id,
    revision_id: revisionId,
    entry_no: entry.no,
    path,
    draft_id: draftId,
    group_id: groupId,
  }
}
