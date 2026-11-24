import { type Queryable, WorkError, type WorkHandler } from '@contentops/db'
import { sourcePath } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import { CHECKED_BY } from './check'
import {
  type ConfiguredModel,
  configuredModels,
  joinPath,
  type OriginKind,
  pathKey,
  type RemoteRef,
} from './config'
import { addEnrol, type EnrolReport, emptyEnrol, enrolOriginals } from './enrol'
import type { CloudObject, OriginalsTransport } from './transport'

/**
 * Work `originals_audit` of role `worker`, slot `originals` (SPEC §9.4): every night, lists only,
 * nothing is downloaded. After a flush of what rclone keeps (MEGA has no change feed), per model
 * of `originals.model_config`: its Я.Диск and Dropbox (with the hashes the cloud lists; the
 * Dropbox listing also holds ContentOps's own copies there, `Архив Я.Диска` and
 * `Загрузки ContentOps`) and its folder in MEGA (with node IDs). Per row of the ledger whose cloud
 * was listed whole:
 *
 * - found as it was checked (MEGA — the same node and size; a copy in Dropbox — the same ID,
 *   size and Dropbox hash; an origin — the same size and the hash of the revision) →
 *   `last_seen_at`, and `unseen_since`, `missing_since` cleared; an origin
 *   whose listed hash is the revision's is checked by it (`verified_by = 'worker:originals'`);
 * - a copy not checked yet follows what lies under its path (its node and size);
 * - a checked object not found, or another one under its path → `unseen_since` on the first
 *   night, `missing_since` (from that night) when the next night's listing, at least 20 hours
 *   later, still does not find it. A copy never seen (not made yet) is left alone.
 *
 * A broken listing (an error, a dropped connection) marks nothing for its cloud. The free space of
 * MEGA and of each Dropbox goes into the report for «Настройки › Состояние».
 */

export const AUDIT_INTERVAL_MS = 24 * 60 * 60_000
export const auditStreamKey = 'originals-audit'
/** Two listings closer than this are one night. */
const NIGHT_MS = 20 * 60 * 60_000

export interface AuditOptions {
  transport: () => OriginalsTransport | null
  /** The time of the listing; the tests move it by a night. */
  now?: () => Date
}

export interface AuditListing {
  model: string
  place: 'yandex' | 'dropbox' | 'mega'
  remote: string
  complete: boolean
  files: number
  error?: string
}

export interface AuditSpace {
  remote: string
  place: 'dropbox' | 'mega'
  total_bytes: number | null
  free_bytes: number | null
  error?: string
}

export interface AuditReport {
  listed_at: string
  listings: AuditListing[]
  space: AuditSpace[]
  broken_configs: { code: string; error: string }[]
  enrolled: EnrolReport
  seen: number
  followed: number
  verified: number
  unseen: number
  /** Of the unseen, missing from this night on. */
  missing: number
}

interface LedgerRow extends Record<string, unknown> {
  id: string
  role: 'origin' | 'copy'
  path: string
  object_ref: string | null
  byte_size: string | null
  verified: boolean
  last_seen_at: string | null
  unseen_since: string | null
  missing_since: string | null
  root_path: string | null
  ref_md5: string | null
  ref_dropbox: string | null
  seen_dropbox: string | null
}

interface Change {
  id: string
  kind: 'seen' | 'follow' | 'verify' | 'unseen'
  object_ref?: string | null
  byte_size?: number
  copied_at?: string | null
  md5?: string | null
  dropbox?: string | null
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function originRows(q: Queryable, modelId: string, kind: OriginKind): Promise<LedgerRow[]> {
  const { rows } = await q.execute<LedgerRow>(sql`
    SELECT c.id, c.role, c.path, c.object_ref, c.byte_size::text AS byte_size,
           c.verified_at IS NOT NULL AS verified, c.last_seen_at::text AS last_seen_at,
           c.unseen_since::text AS unseen_since, c.missing_since::text AS missing_since,
           s.root_path, encode(r.md5, 'hex') AS ref_md5, encode(r.content_hash, 'hex') AS ref_dropbox,
           NULL::text AS seen_dropbox
      FROM original_copies c
      JOIN source_revisions r ON r.model_id = c.model_id AND r.id = c.source_revision_id
      JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
      JOIN sources s ON s.model_id = o.model_id AND s.id = o.source_id
     WHERE c.model_id = ${modelId}::uuid AND c.role = 'origin' AND s.kind = ${kind}
       AND c.place = ${kind === 'yandex_disk' ? 'yandex' : 'dropbox'}`)
  return rows
}

async function copyRows(q: Queryable, modelId: string, mega: RemoteRef): Promise<LedgerRow[]> {
  const prefix = mega.path === '' ? '' : `${mega.path}/`
  const { rows } = await q.execute<LedgerRow>(sql`
    SELECT c.id, c.role, c.path, c.object_ref, c.byte_size::text AS byte_size,
           c.verified_at IS NOT NULL AS verified, c.last_seen_at::text AS last_seen_at,
           c.unseen_since::text AS unseen_since, c.missing_since::text AS missing_since,
           NULL::text AS root_path, NULL::text AS ref_md5, NULL::text AS ref_dropbox,
           encode(c.seen_dropbox_hash, 'hex') AS seen_dropbox
      FROM original_copies c
     WHERE c.model_id = ${modelId}::uuid AND c.place = 'mega' AND c.role = 'copy'
       AND c.remote = ${mega.remote} AND left(c.path, ${prefix.length}) = ${prefix}`)
  return rows
}

/** ContentOps's own copies in the model's Dropbox (`Архив Я.Диска`, `Загрузки ContentOps`). */
async function dropboxCopyRows(
  q: Queryable,
  modelId: string,
  remote: string,
): Promise<LedgerRow[]> {
  const { rows } = await q.execute<LedgerRow>(sql`
    SELECT c.id, c.role, c.path, c.object_ref, c.byte_size::text AS byte_size,
           c.verified_at IS NOT NULL AS verified, c.last_seen_at::text AS last_seen_at,
           c.unseen_since::text AS unseen_since, c.missing_since::text AS missing_since,
           NULL::text AS root_path, NULL::text AS ref_md5, NULL::text AS ref_dropbox,
           encode(c.seen_dropbox_hash, 'hex') AS seen_dropbox
      FROM original_copies c
     WHERE c.model_id = ${modelId}::uuid AND c.place = 'dropbox' AND c.role = 'copy'
       AND c.remote = ${remote}`)
  return rows
}

/** An origin is the revision when the size and the listed hash are the revision's. */
function judgeOrigin(row: LedgerRow, entry: CloudObject | undefined, kind: OriginKind): Change {
  if (!entry || entry.size !== Number(row.byte_size)) return { id: row.id, kind: 'unseen' }
  const [want, got] =
    kind === 'yandex_disk' ? [row.ref_md5, entry.md5] : [row.ref_dropbox, entry.dropbox]
  if (want !== null && got !== null && want !== got) return { id: row.id, kind: 'unseen' }
  if (!row.verified && want !== null && got === want) {
    return {
      id: row.id,
      kind: 'verify',
      ...(kind === 'yandex_disk' ? { md5: got } : { dropbox: got }),
    }
  }
  return { id: row.id, kind: 'seen' }
}

/**
 * A checked copy is its node (in Dropbox — its ID, which stays when the file is rewritten, and
 * the Dropbox hash it was checked by); one not checked follows the path.
 */
function judgeCopy(row: LedgerRow, entry: CloudObject | undefined): Change | null {
  if (row.verified) {
    const same =
      entry !== undefined &&
      entry.id === row.object_ref &&
      entry.size === Number(row.byte_size) &&
      (row.seen_dropbox === null || entry.dropbox === null || entry.dropbox === row.seen_dropbox)
    return same ? { id: row.id, kind: 'seen' } : { id: row.id, kind: 'unseen' }
  }
  if (!entry?.id) {
    // Never seen — not copied yet; once seen and now gone — lost.
    return row.last_seen_at === null ? null : { id: row.id, kind: 'unseen' }
  }
  if (entry.id === row.object_ref && entry.size === Number(row.byte_size)) {
    return { id: row.id, kind: 'seen' }
  }
  return {
    id: row.id,
    kind: 'follow',
    object_ref: entry.id,
    byte_size: entry.size,
    copied_at: entry.modTime,
  }
}

async function apply(
  q: Queryable,
  modelId: string,
  changes: Change[],
  at: Date,
  report: AuditReport,
): Promise<void> {
  const by = (kind: Change['kind']) => changes.filter((change) => change.kind === kind)
  const when = at.toISOString()
  const seen = by('seen').map((change) => change.id)
  if (seen.length > 0) {
    await q.execute(sql`
      UPDATE original_copies
         SET last_seen_at = ${when}::timestamptz, unseen_since = NULL, missing_since = NULL
       WHERE model_id = ${modelId}::uuid AND id = ANY (${sql.param(seen)}::uuid[])`)
  }
  const follow = by('follow')
  if (follow.length > 0) {
    await q.execute(sql`
      UPDATE original_copies AS c
         SET object_ref = x.object_ref, byte_size = x.byte_size,
             copied_at = COALESCE(c.copied_at, x.copied_at), last_seen_at = ${when}::timestamptz,
             unseen_since = NULL, missing_since = NULL
        FROM jsonb_to_recordset(${JSON.stringify(follow)}::jsonb)
          AS x(id uuid, object_ref text, byte_size bigint, copied_at timestamptz)
       WHERE c.model_id = ${modelId}::uuid AND c.id = x.id AND c.verified_at IS NULL`)
  }
  const verify = by('verify')
  if (verify.length > 0) {
    await q.execute(sql`
      UPDATE original_copies AS c
         SET verified_at = ${when}::timestamptz, verified_by = ${CHECKED_BY},
             seen_md5 = decode(x.md5, 'hex'), seen_dropbox_hash = decode(x.dropbox, 'hex'),
             last_seen_at = ${when}::timestamptz, unseen_since = NULL, missing_since = NULL
        FROM jsonb_to_recordset(${JSON.stringify(verify)}::jsonb)
          AS x(id uuid, md5 text, dropbox text)
       WHERE c.model_id = ${modelId}::uuid AND c.id = x.id AND c.verified_at IS NULL`)
  }
  const unseen = by('unseen').map((change) => change.id)
  if (unseen.length > 0) {
    // One statement reads the old values: the first night sets `unseen_since`, a later one
    // (20 hours on) turns it into `missing_since`.
    const { rows } = await q.execute<{ missing: boolean }>(sql`
      UPDATE original_copies
         SET unseen_since = COALESCE(unseen_since, ${when}::timestamptz),
             missing_since = CASE
               WHEN missing_since IS NOT NULL THEN missing_since
               WHEN unseen_since IS NOT NULL
                    AND ${when}::timestamptz - unseen_since >= ${NIGHT_MS}::bigint * interval '1 millisecond'
                 THEN unseen_since
             END
       WHERE model_id = ${modelId}::uuid AND id = ANY (${sql.param(unseen)}::uuid[])
      RETURNING old.missing_since IS NULL AND new.missing_since IS NOT NULL AS missing`)
    report.missing += rows.filter((row) => row.missing).length
  }
  report.seen += seen.length
  report.followed += follow.length
  report.verified += verify.length
  report.unseen += unseen.length
}

async function listWhole(
  transport: OriginalsTransport,
  ref: RemoteRef,
  signal: AbortSignal,
): Promise<{ entries: CloudObject[] } | { error: string }> {
  try {
    return { entries: await transport.list(ref.remote, ref.path, signal) }
  } catch (error) {
    if (signal.aborted) throw signal.reason
    return { error: errorText(error).slice(0, 500) }
  }
}

async function auditModel(
  q: Queryable,
  transport: OriginalsTransport,
  model: ConfiguredModel,
  at: Date,
  signal: AbortSignal,
  report: AuditReport,
): Promise<void> {
  for (const kind of ['yandex_disk', 'dropbox'] as const) {
    const ref = model.config[kind]
    if (!ref) continue
    const place = kind === 'yandex_disk' ? 'yandex' : 'dropbox'
    const listed = await listWhole(transport, ref, signal)
    const listing: AuditListing = {
      model: model.code,
      place,
      remote: ref.remote,
      complete: 'entries' in listed,
      files: 'entries' in listed ? listed.entries.length : 0,
    }
    if ('error' in listed) listing.error = listed.error
    report.listings.push(listing)
    if (!('entries' in listed)) continue
    const byPath = new Map(listed.entries.map((entry) => [pathKey(entry.path, kind), entry]))
    const changes: Change[] = []
    for (const row of await originRows(q, model.id, kind)) {
      // The remote's folder is the root of the source.
      const relative = joinPath(sourcePath(row.path, row.root_path ?? '').relative)
      const inRemote = ref.path === '' ? relative : relativeTo(relative, ref.path, kind)
      if (inRemote === null) continue
      changes.push(judgeOrigin(row, byPath.get(pathKey(inRemote, kind)), kind))
    }
    if (kind === 'dropbox') {
      for (const row of await dropboxCopyRows(q, model.id, ref.remote)) {
        const inRemote = ref.path === '' ? row.path : relativeTo(row.path, ref.path, kind)
        if (inRemote === null) continue
        const change = judgeCopy(row, byPath.get(pathKey(inRemote, kind)))
        if (change) changes.push(change)
      }
    }
    await apply(q, model.id, changes, at, report)
  }
  const mega = model.config.mega
  if (mega) {
    const listed = await listWhole(transport, mega, signal)
    const listing: AuditListing = {
      model: model.code,
      place: 'mega',
      remote: mega.remote,
      complete: 'entries' in listed,
      files: 'entries' in listed ? listed.entries.length : 0,
    }
    if ('error' in listed) listing.error = listed.error
    report.listings.push(listing)
    if ('entries' in listed) {
      const byPath = new Map(
        listed.entries.map((entry) => [pathKey(joinPath(mega.path, entry.path), 'mega'), entry]),
      )
      const changes: Change[] = []
      for (const row of await copyRows(q, model.id, mega)) {
        const change = judgeCopy(row, byPath.get(pathKey(row.path, 'mega')))
        if (change) changes.push(change)
      }
      await apply(q, model.id, changes, at, report)
    }
  }
}

/** The path inside the remote's folder when the remote is not the root of the source. */
function relativeTo(relative: string, folder: string, kind: OriginKind): string | null {
  const key = pathKey(relative, kind)
  const base = pathKey(folder, kind)
  if (!key.startsWith(`${base}/`)) return null
  return relative.slice(folder.length + 1)
}

export function originalsAuditHandler(options: AuditOptions): WorkHandler {
  return async ({ db, signal }) => {
    const transport = options.transport()
    if (!transport) {
      throw new WorkError('permanent', 'not_configured', 'RCLONE_CONFIG is not set or not there')
    }
    const at = options.now?.() ?? new Date()
    const { models, broken } = await configuredModels(db)
    const report: AuditReport = {
      listed_at: at.toISOString(),
      listings: [],
      space: [],
      broken_configs: broken,
      enrolled: emptyEnrol(),
      seen: 0,
      followed: 0,
      verified: 0,
      unseen: 0,
      missing: 0,
    }
    for (const model of models) addEnrol(report.enrolled, await enrolOriginals(db, model))
    await transport.flush(signal)
    for (const model of models) await auditModel(db, transport, model, at, signal, report)
    const remotes = new Map<string, AuditSpace['place']>()
    for (const model of models) {
      if (model.config.mega) remotes.set(model.config.mega.remote, 'mega')
      if (model.config.dropbox) remotes.set(model.config.dropbox.remote, 'dropbox')
    }
    for (const [remote, place] of remotes) {
      try {
        const space = await transport.about(remote, signal)
        report.space.push({ remote, place, total_bytes: space.total, free_bytes: space.free })
      } catch (error) {
        if (signal.aborted) throw signal.reason
        report.space.push({
          remote,
          place,
          total_bytes: null,
          free_bytes: null,
          error: errorText(error).slice(0, 300),
        })
      }
    }
    return { report }
  }
}
