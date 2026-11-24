import { randomUUID } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { type Db, logAction, SYSTEM_ACTOR, type Tx, withActorTx } from '@contentops/db'
import { sourcePath } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import {
  decodeText,
  type ManifestLine,
  type MegaEntry,
  parseCombined,
  parseManifest,
  parseMd5Sums,
  parseMegaListing,
} from './inputs'

/**
 * `ops.js originals seed` (SPEC §9.4, ops/README.md «Оригиналы: два места»): the ledger of the
 * places of the originals from what is known tonight, owner-run, idempotent. It writes only
 * `original_copies` and one `action_log` row; without `write` it counts what it would write and
 * rolls back.
 *
 * - *Origins*: a row per revision of the model's cloud folder (not inside an archive): its cloud,
 *   path, identity, size; checked when the import read its bytes and they matched the hash of the
 *   cloud (`source_revisions.verified_at`); missing when the object is gone or has a newer revision.
 * - *MEGA of the old Я.Диск* (`mega`, a listing `rclone lsjson -R --files-only` of
 *   `originals/<model>/yadisk`): a copy row per file of the listing under the path of a revision,
 *   with its node ID and the time the node appeared. The night's check (`checks`, `verify-mega.ps1`:
 *   `<root>.ya.md5` and `<root>.combined`) marks it checked only if the line is `=` (the bytes
 *   downloaded back from MEGA gave the MD5 of Я.Диск), that MD5 is the MD5 of the revision
 *   ContentOps knows under the path (for the old disk — the one of the frozen snapshot), the node
 *   has the size of the revision, and the node is not newer than the check (it started when the
 *   `.ya.md5` list was written). Otherwise the copy stays unchecked.
 * - *Ari's manifest* (`manifest`, `ari-manifest.tsv`): a copy row in MEGA per file of her Dropbox
 *   the manifest places there, with the size it gives; unchecked, without a node ID.
 */

export interface SeedInput {
  model: string
  /** `rclone lsjson -R --files-only` of the MEGA folder of the model's Я.Диск. */
  mega?: string
  /** The folder in MEGA that listing is of; default `originals/<model>/yadisk`. */
  megaRoot?: string
  /** The folder of the night's check: `<root>.ya.md5` and `<root>.combined` per root. */
  checks?: string
  /** Ari's `ari-manifest.tsv`. */
  manifest?: string
  /** The folder in MEGA the manifest's paths are under; default `originals/<model>`. */
  manifestRoot?: string
  /** Write; without it the counts of what would be written, nothing changed. */
  write: boolean
}

export interface SeedReport {
  model: string
  written: boolean
  origins: { rows: number; checked: number; inserted: number; updated: number }
  mega?: {
    listed: number
    matched: number
    /** Files of the listing with no revision under their path (not the old disk, a duplicate name). */
    not_in_catalog: number
    /** A second node for the same revision (another spelling of the path): not seeded. */
    duplicates: number
    checked: number
    /** Why the rest stays unchecked. */
    unchecked: Record<string, number>
    inserted: number
    updated: number
  }
  checks?: { roots: number; lines: number; same: number }
  manifest?: {
    lines: number
    matched: number
    not_in_catalog: number
    size_differs: number
    duplicates: number
    inserted: number
    updated: number
  }
}

class DryRun extends Error {
  constructor(readonly report: SeedReport) {
    super('dry run')
  }
}

const nfc = (text: string) => text.normalize('NFC')

function bump(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1
}

async function readText(path: string): Promise<string> {
  return decodeText(await readFile(path))
}

/** «night-24.11»: the Moscow date the check started. */
export function nightLabel(at: Date): string {
  const day = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
  }).format(at)
  return `night-${day}`
}

interface Check {
  mark: string
  md5: string | null
  checkedAt: Date
}

/** The night's check by the path relative to the root of Я.Диск (NFC). */
async function readChecks(dir: string): Promise<{
  byPath: Map<string, Check>
  roots: number
  lines: number
  same: number
}> {
  const byPath = new Map<string, Check>()
  let roots = 0
  let count = 0
  let same = 0
  for (const name of (await readdir(dir)).sort()) {
    if (!name.endsWith('.combined')) continue
    const tag = name.slice(0, -'.combined'.length)
    const sumsFile = join(dir, `${tag}.ya.md5`)
    const sumsStat = await stat(sumsFile).catch(() => null)
    if (!sumsStat) continue
    roots += 1
    const root = tag === '_root-files' ? '' : tag
    const sums = parseMd5Sums(await readText(sumsFile))
    for (const line of parseCombined(await readText(join(dir, name)))) {
      count += 1
      if (line.mark === '=') same += 1
      const full = root ? `${root}/${line.path}` : line.path
      byPath.set(nfc(full), {
        mark: line.mark,
        md5: sums.get(line.path) ?? null,
        checkedAt: sumsStat.mtime,
      })
    }
  }
  return { byPath, roots, lines: count, same }
}

interface Revision {
  id: string
  /** Relative to the root of its source, as written. */
  relative: string
  size: number
  md5: string | null
  gone: boolean
}

/** The revisions ContentOps knows under the current paths of a source kind of the model. */
async function revisionsByPath(
  tx: Tx,
  modelId: string,
  kind: 'yandex_disk' | 'dropbox',
  key: (relative: string) => string,
): Promise<Map<string, Revision>> {
  const { rows } = await tx.execute<{
    id: string
    path: string
    root_path: string | null
    size: string
    md5: string | null
    gone: boolean
  }>(sql`
    SELECT r.id, o.current_path AS path, s.root_path, r.byte_size::text AS size,
           encode(r.md5, 'hex') AS md5, o.gone_since IS NOT NULL AS gone
      FROM source_objects o
      JOIN sources s ON s.model_id = o.model_id AND s.id = o.source_id
      JOIN source_revisions r ON r.model_id = o.model_id AND r.id = o.current_revision_id
     WHERE o.model_id = ${modelId}::uuid AND s.kind = ${kind} AND NOT o.is_dir
       AND o.archive_revision_id IS NULL
     ORDER BY o.gone_since NULLS FIRST, r.detected_at DESC`)
  const out = new Map<string, Revision>()
  for (const row of rows) {
    const relative = sourcePath(row.path, row.root_path ?? '').relative
    const k = key(relative)
    // A live object wins over a gone one under the same path.
    if (out.has(k)) continue
    out.set(k, {
      id: row.id,
      relative,
      size: Number(row.size),
      md5: row.md5,
      gone: row.gone,
    })
  }
  return out
}

async function seedOrigins(tx: Tx, modelId: string): Promise<SeedReport['origins']> {
  const { rows: counted } = await tx.execute<{ rows: string; checked: string }>(sql`
    SELECT count(*)::text AS rows, count(r.verified_at)::text AS checked
      FROM source_revisions r
      JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
      JOIN sources s ON s.model_id = o.model_id AND s.id = o.source_id
     WHERE r.model_id = ${modelId}::uuid AND s.kind IN ('yandex_disk', 'dropbox') AND NOT o.is_dir
       AND o.archive_revision_id IS NULL`)
  const { rows } = await tx.execute<{ inserted: boolean }>(sql`
    INSERT INTO original_copies AS c (
      model_id, source_revision_id, place, role, path, object_ref, byte_size,
      seen_md5, seen_sha256, seen_dropbox_hash, verified_at, verified_by, last_seen_at,
      missing_since)
    SELECT r.model_id, r.id,
           CASE s.kind WHEN 'yandex_disk' THEN 'yandex' ELSE 'dropbox' END, 'origin',
           CASE WHEN replaced THEN COALESCE(r.frozen_path, o.current_path) ELSE o.current_path END,
           CASE s.kind
             WHEN 'yandex_disk' THEN encode(COALESCE(r.remote_sha256, r.md5), 'hex')
             ELSE o.resource_id || '@' || r.remote_rev
           END,
           r.byte_size,
           CASE WHEN r.verified_at IS NOT NULL THEN r.md5 END,
           CASE WHEN r.verified_at IS NOT NULL THEN r.source_sha256 END,
           CASE WHEN r.verified_at IS NOT NULL THEN r.content_hash END,
           r.verified_at, CASE WHEN r.verified_at IS NOT NULL THEN 'import' END,
           o.last_seen_at,
           CASE
             WHEN replaced THEN COALESCE(
               (SELECT min(n.detected_at) FROM source_revisions n
                 WHERE n.model_id = r.model_id AND n.previous_id = r.id), o.last_seen_at)
             ELSE o.gone_since
           END
      FROM source_revisions r
      JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
      JOIN sources s ON s.model_id = o.model_id AND s.id = o.source_id
      CROSS JOIN LATERAL (
        SELECT o.current_revision_id IS NOT NULL AND o.current_revision_id <> r.id AS replaced
      ) x
     WHERE r.model_id = ${modelId}::uuid AND s.kind IN ('yandex_disk', 'dropbox') AND NOT o.is_dir
       AND o.archive_revision_id IS NULL
       -- What the check needs: the provider's identity of the object.
       AND (CASE s.kind WHEN 'yandex_disk' THEN COALESCE(r.remote_sha256, r.md5) IS NOT NULL
                        ELSE o.resource_id IS NOT NULL AND r.remote_rev IS NOT NULL END)
    ON CONFLICT (model_id, source_revision_id, place) WHERE source_revision_id IS NOT NULL
    DO UPDATE SET
      path = EXCLUDED.path,
      last_seen_at = GREATEST(c.last_seen_at, EXCLUDED.last_seen_at),
      missing_since = EXCLUDED.missing_since,
      verified_at = COALESCE(c.verified_at, EXCLUDED.verified_at),
      verified_by = CASE WHEN c.verified_at IS NULL THEN EXCLUDED.verified_by ELSE c.verified_by END,
      seen_md5 = CASE WHEN c.verified_at IS NULL THEN EXCLUDED.seen_md5 ELSE c.seen_md5 END,
      seen_sha256 = CASE WHEN c.verified_at IS NULL THEN EXCLUDED.seen_sha256 ELSE c.seen_sha256 END,
      seen_dropbox_hash = CASE WHEN c.verified_at IS NULL THEN EXCLUDED.seen_dropbox_hash
                               ELSE c.seen_dropbox_hash END
     WHERE c.role = 'origin'
       AND ((c.path, c.missing_since) IS DISTINCT FROM (EXCLUDED.path, EXCLUDED.missing_since)
            OR c.last_seen_at IS DISTINCT FROM GREATEST(c.last_seen_at, EXCLUDED.last_seen_at)
            OR (c.verified_at IS NULL AND EXCLUDED.verified_at IS NOT NULL))
    RETURNING (xmax = 0) AS inserted`)
  return {
    rows: Number(counted[0]?.rows ?? 0),
    checked: Number(counted[0]?.checked ?? 0),
    inserted: rows.filter((row) => row.inserted).length,
    updated: rows.filter((row) => !row.inserted).length,
  }
}

interface MegaRow {
  revision_id: string
  path: string
  object_ref: string | null
  byte_size: number
  seen_md5: string | null
  copied_at: string | null
  verified_at: string | null
  verified_by: string | null
  last_seen_at: string | null
}

async function upsertMega(
  tx: Tx,
  modelId: string,
  rows: MegaRow[],
): Promise<{ inserted: number; updated: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0 }
  // Take the new check when there is one and it is not older than the row's.
  const take = sql`(EXCLUDED.verified_at IS NOT NULL
                    AND (c.verified_at IS NULL OR EXCLUDED.verified_at >= c.verified_at))`
  const { rows: done } = await tx.execute<{ inserted: boolean }>(sql`
    INSERT INTO original_copies AS c (
      model_id, source_revision_id, place, role, remote, path, object_ref, byte_size, seen_md5,
      copied_at, verified_at, verified_by, last_seen_at)
    SELECT ${modelId}::uuid, x.revision_id, 'mega', 'copy', 'mega', x.path, x.object_ref,
           x.byte_size, decode(x.seen_md5, 'hex'), x.copied_at, x.verified_at, x.verified_by,
           x.last_seen_at
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(
        revision_id uuid, path text, object_ref text, byte_size bigint, seen_md5 text,
        copied_at timestamptz, verified_at timestamptz, verified_by text, last_seen_at timestamptz)
    ON CONFLICT (model_id, source_revision_id, place) WHERE source_revision_id IS NOT NULL
    DO UPDATE SET
      path = EXCLUDED.path,
      object_ref = EXCLUDED.object_ref,
      byte_size = EXCLUDED.byte_size,
      copied_at = EXCLUDED.copied_at,
      last_seen_at = GREATEST(c.last_seen_at, EXCLUDED.last_seen_at),
      missing_since = NULL,
      verified_at = CASE WHEN ${take} THEN EXCLUDED.verified_at ELSE c.verified_at END,
      verified_by = CASE WHEN ${take} THEN EXCLUDED.verified_by ELSE c.verified_by END,
      seen_md5 = CASE WHEN ${take} THEN EXCLUDED.seen_md5 ELSE c.seen_md5 END,
      seen_sha256 = CASE WHEN ${take} THEN NULL ELSE c.seen_sha256 END,
      seen_dropbox_hash = CASE WHEN ${take} THEN NULL ELSE c.seen_dropbox_hash END
     WHERE (c.path, c.object_ref, c.byte_size, c.copied_at, c.missing_since)
             IS DISTINCT FROM (EXCLUDED.path, EXCLUDED.object_ref, EXCLUDED.byte_size,
                               EXCLUDED.copied_at, NULL::timestamptz)
        OR c.last_seen_at IS DISTINCT FROM GREATEST(c.last_seen_at, EXCLUDED.last_seen_at)
        OR (${take} AND (c.verified_at, c.verified_by, c.seen_md5)
                          IS DISTINCT FROM (EXCLUDED.verified_at, EXCLUDED.verified_by,
                                            EXCLUDED.seen_md5))
    RETURNING (xmax = 0) AS inserted`)
  return {
    inserted: done.filter((row) => row.inserted).length,
    updated: done.filter((row) => !row.inserted).length,
  }
}

async function seedMega(
  tx: Tx,
  modelId: string,
  entries: MegaEntry[],
  megaRoot: string,
  listedAt: Date,
  checks: Map<string, Check> | null,
): Promise<NonNullable<SeedReport['mega']>> {
  const revisions = await revisionsByPath(tx, modelId, 'yandex_disk', nfc)
  if (revisions.size === 0) throw new Error('the model has no files of Я.Диск to match MEGA with')
  let notInCatalog = 0
  let duplicates = 0
  const chosen = new Map<string, { entry: MegaEntry; row: MegaRow; why: string | null }>()
  for (const entry of entries) {
    const revision = revisions.get(nfc(entry.path))
    if (!revision) {
      notInCatalog += 1
      continue
    }
    const check = checks?.get(nfc(entry.path)) ?? null
    let why: string | null = null
    if (!check) why = 'no_check'
    else if (check.mark !== '=') why = `check:${check.mark}`
    else if (!check.md5 || check.md5 !== revision.md5) why = 'md5_not_of_revision'
    else if (entry.size !== revision.size) why = 'size_differs'
    else if (!entry.id) why = 'no_node_id'
    else if (!entry.modTime || Date.parse(entry.modTime) > check.checkedAt.getTime()) {
      why = 'node_newer_than_check'
    }
    const proof = why === null ? check : null
    const row: MegaRow = {
      revision_id: revision.id,
      path: `${megaRoot}/${entry.path}`,
      object_ref: entry.id,
      byte_size: entry.size,
      seen_md5: proof?.md5 ?? null,
      copied_at: entry.modTime,
      verified_at: proof ? proof.checkedAt.toISOString() : null,
      verified_by: proof ? nightLabel(proof.checkedAt) : null,
      last_seen_at: listedAt.toISOString(),
    }
    const earlier = chosen.get(revision.id)
    if (earlier) {
      duplicates += 1
      // The node under the revision's own spelling of the path is the canonical one.
      if (earlier.entry.path === revision.relative || entry.path !== revision.relative) continue
    }
    chosen.set(revision.id, { entry, row, why })
  }
  const unchecked: Record<string, number> = {}
  for (const { why } of chosen.values()) if (why !== null) bump(unchecked, why)
  const rows = [...chosen.values()].map((c) => c.row)
  const written = await upsertMega(tx, modelId, rows)
  return {
    listed: entries.length,
    matched: chosen.size,
    not_in_catalog: notInCatalog,
    duplicates,
    checked: rows.filter((row) => row.verified_at !== null).length,
    unchecked,
    ...written,
  }
}

const KIND_ORDER = ['catalog', 'new', 'outside', 'copy']

async function seedManifest(
  tx: Tx,
  modelId: string,
  lines: ManifestLine[],
  manifestRoot: string,
): Promise<NonNullable<SeedReport['manifest']>> {
  // Dropbox ignores the case of a path.
  const key = (relative: string) => nfc(relative).toLowerCase()
  const revisions = await revisionsByPath(tx, modelId, 'dropbox', key)
  if (revisions.size === 0)
    throw new Error('the model has no files of Dropbox to match the manifest')
  let notInCatalog = 0
  let sizeDiffers = 0
  let duplicates = 0
  const chosen = new Map<string, ManifestLine>()
  for (const line of lines) {
    const revision = revisions.get(key(line.dropbox.replace(/^\/+/u, '')))
    if (!revision) {
      notInCatalog += 1
      continue
    }
    if (line.size !== revision.size) {
      sizeDiffers += 1
      continue
    }
    const earlier = chosen.get(revision.id)
    if (earlier) {
      duplicates += 1
      const rank = (kind: string) => {
        const at = KIND_ORDER.indexOf(kind)
        return at < 0 ? KIND_ORDER.length : at
      }
      if (rank(earlier.kind) <= rank(line.kind)) continue
    }
    chosen.set(revision.id, line)
  }
  const rows = [...chosen.entries()].map(([revisionId, line]) => ({
    revision_id: revisionId,
    path: `${manifestRoot}/${line.mega}`,
    byte_size: line.size,
  }))
  let inserted = 0
  let updated = 0
  if (rows.length > 0) {
    const { rows: done } = await tx.execute<{ inserted: boolean }>(sql`
      INSERT INTO original_copies AS c (
        model_id, source_revision_id, place, role, remote, path, byte_size)
      SELECT ${modelId}::uuid, x.revision_id, 'mega', 'copy', 'mega', x.path, x.byte_size
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
          AS x(revision_id uuid, path text, byte_size bigint)
      ON CONFLICT (model_id, source_revision_id, place) WHERE source_revision_id IS NOT NULL
      DO UPDATE SET path = EXCLUDED.path, byte_size = EXCLUDED.byte_size
       -- A row a listing or a check filled knows more than the manifest.
       WHERE c.object_ref IS NULL
         AND (c.path, c.byte_size) IS DISTINCT FROM (EXCLUDED.path, EXCLUDED.byte_size)
      RETURNING (xmax = 0) AS inserted`)
    inserted = done.filter((row) => row.inserted).length
    updated = done.length - inserted
  }
  return {
    lines: lines.length,
    matched: chosen.size,
    not_in_catalog: notInCatalog,
    size_differs: sizeDiffers,
    duplicates,
    inserted,
    updated,
  }
}

export async function seedOriginals(db: Db, input: SeedInput): Promise<SeedReport> {
  if (input.checks && !input.mega) {
    throw new Error('--checks needs --mega: a check is kept only with the node it saw')
  }
  const megaEntries = input.mega ? parseMegaListing(await readText(input.mega)) : null
  const listedAt = input.mega ? (await stat(input.mega)).mtime : null
  const checks = input.checks ? await readChecks(input.checks) : null
  const manifest = input.manifest ? parseManifest(await readText(input.manifest)) : null
  try {
    return await withActorTx(
      db,
      { actor: SYSTEM_ACTOR('ops'), action: 'originals.seed', requestId: randomUUID() },
      async (tx) => {
        const { rows: models } = await tx.execute<{ id: string }>(sql`
          SELECT id FROM models WHERE code = ${input.model}`)
        const modelId = models[0]?.id
        if (!modelId) throw new Error(`${input.model}: no such model`)
        const report: SeedReport = {
          model: input.model,
          written: input.write,
          origins: await seedOrigins(tx, modelId),
        }
        if (megaEntries && listedAt) {
          report.mega = await seedMega(
            tx,
            modelId,
            megaEntries,
            (input.megaRoot ?? `originals/${input.model}/yadisk`).replace(/\/+$/u, ''),
            listedAt,
            checks?.byPath ?? null,
          )
        }
        if (checks) {
          report.checks = { roots: checks.roots, lines: checks.lines, same: checks.same }
        }
        if (manifest) {
          report.manifest = await seedManifest(
            tx,
            modelId,
            manifest,
            (input.manifestRoot ?? `originals/${input.model}`).replace(/\/+$/u, ''),
          )
        }
        if (!input.write) throw new DryRun(report)
        await logAction(tx, {
          modelId,
          subjectKind: 'original_copies',
          subjectLabel: `Места оригиналов: ${input.model}`,
          after: {
            origins: report.origins,
            ...(report.mega ? { mega: report.mega } : {}),
            ...(report.checks ? { checks: report.checks } : {}),
            ...(report.manifest ? { manifest: report.manifest } : {}),
          },
        })
        return report
      },
    )
  } catch (error) {
    if (error instanceof DryRun) return error.report
    throw error
  }
}
