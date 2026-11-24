import type { Queryable } from '@contentops/db'
import { nfc, sourcePath } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import { type ConfiguredModel, isExcluded, joinPath, type OriginKind } from './config'
import { notOriginals } from './rule'
import { originRows } from './seed'
import { UPLOADS_FOLDER } from './transport'

/**
 * New originals get their rows in the ledger by themselves (SPEC §9.4), before every check, copy
 * and audit: the origin row as `ops.js originals seed` makes it, and the rows of the copies the
 * model's configuration asks for, not checked, without a node yet (the copy work writes them or
 * finds them there, the check and the audit read them):
 *
 * - `copies` — a MEGA copy at `<mega>/<folder>/<path in the source>` (Lora's Я.Диск and Dropbox,
 *   Ari's new Dropbox files under «Вне каталога»);
 * - `dropbox_copies` — a copy in the model's own Dropbox at `<folder>/<path in the source>`
 *   (Lora's Я.Диск → «Архив Я.Диска»);
 * - every registered web upload still on our disk — a MEGA copy at
 *   `<mega>/Загрузки ContentOps/<ГГГГ-ММ>/<upload id>_<name>` and a Dropbox copy at
 *   `Загрузки ContentOps/<ГГГГ-ММ>/<upload id>_<name>` (the month of the upload, Moscow).
 *
 * Only rows that do not exist are added; a row already there is never changed here. Members of
 * archives are not originals; a gone object or an older revision gets no copy row.
 */

export interface EnrolReport {
  origins: number
  /** MEGA copies of source files. */
  copies: number
  /** Copies of source files in the model's own Dropbox. */
  archive: number
  /** Copies of web uploads, MEGA and Dropbox. */
  uploads: number
}

export const emptyEnrol = (): EnrolReport => ({ origins: 0, copies: 0, archive: 0, uploads: 0 })

export function addEnrol(total: EnrolReport, add: EnrolReport): void {
  total.origins += add.origins
  total.copies += add.copies
  total.archive += add.archive
  total.uploads += add.uploads
}

const BATCH = 2_000
const NAME_MAX = 150

/** A file name every cloud takes: no separators or reserved characters, no trailing dots. */
export function safeName(name: string): string {
  let out = nfc(name)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters go
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/[\\/:*?"<>|]/gu, '_')
    .trim()
    .replace(/[. ]+$/u, '')
  if (out === '') out = 'file'
  const chars = [...out]
  if (chars.length <= NAME_MAX) return out
  const dot = out.lastIndexOf('.')
  const ext = dot > 0 && out.length - dot <= 11 ? out.slice(dot) : ''
  const stem = [...out.slice(0, out.length - ext.length)]
  return stem.slice(0, NAME_MAX - [...ext].length).join('') + ext
}

export async function enrolOriginals(q: Queryable, model: ConfiguredModel): Promise<EnrolReport> {
  const { rowCount } = await q.execute(sql`
    ${originRows(model.id, await notOriginals(q, model.id))}
    ON CONFLICT (model_id, source_revision_id, place) WHERE source_revision_id IS NOT NULL
    DO NOTHING`)
  const report: EnrolReport = { ...emptyEnrol(), origins: rowCount ?? 0 }
  const { mega, dropbox } = model.config
  for (const kind of ['yandex_disk', 'dropbox'] as const satisfies readonly OriginKind[]) {
    const folder = model.config.copies[kind]
    if (mega && folder) {
      report.copies += await enrolCopies(q, model, kind, {
        place: 'mega',
        remote: mega.remote,
        root: joinPath(mega.path, folder),
      })
    }
  }
  const archive = model.config.dropbox_copies.yandex_disk
  if (dropbox && archive) {
    report.archive += await enrolCopies(q, model, 'yandex_disk', {
      place: 'dropbox',
      remote: dropbox.remote,
      root: archive,
    })
  }
  if (mega) {
    report.uploads += await enrolUploads(q, model, {
      place: 'mega',
      remote: mega.remote,
      root: joinPath(mega.path, UPLOADS_FOLDER),
    })
  }
  if (dropbox) {
    report.uploads += await enrolUploads(q, model, {
      place: 'dropbox',
      remote: dropbox.remote,
      root: UPLOADS_FOLDER,
    })
  }
  return report
}

interface Target {
  place: 'mega' | 'dropbox'
  remote: string
  /** The folder of the copies in the remote. */
  root: string
}

async function insert(
  q: Queryable,
  model: ConfiguredModel,
  target: Target,
  column: 'source_revision_id' | 'web_upload_id',
  wanted: { original_id: string; path: string }[],
): Promise<number> {
  let added = 0
  for (let at = 0; at < wanted.length; at += BATCH) {
    const batch = wanted.slice(at, at + BATCH)
    const { rowCount } = await q.execute(
      column === 'source_revision_id'
        ? sql`
      INSERT INTO original_copies (model_id, source_revision_id, place, role, remote, path)
      SELECT ${model.id}::uuid, x.original_id, ${target.place}, 'copy', ${target.remote}, x.path
        FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS x(original_id uuid, path text)
      ON CONFLICT (model_id, source_revision_id, place) WHERE source_revision_id IS NOT NULL
      DO NOTHING`
        : sql`
      INSERT INTO original_copies (model_id, web_upload_id, place, role, remote, path)
      SELECT ${model.id}::uuid, x.original_id, ${target.place}, 'copy', ${target.remote}, x.path
        FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS x(original_id uuid, path text)
      ON CONFLICT (model_id, web_upload_id, place) WHERE web_upload_id IS NOT NULL
      DO NOTHING`,
    )
    added += rowCount ?? 0
  }
  return added
}

async function enrolCopies(
  q: Queryable,
  model: ConfiguredModel,
  kind: OriginKind,
  target: Target,
): Promise<number> {
  const { rows } = await q.execute<{ id: string; path: string; root_path: string | null }>(sql`
    SELECT r.id, o.current_path AS path, s.root_path
      FROM source_revisions r
      JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
      JOIN sources s ON s.model_id = o.model_id AND s.id = o.source_id
     WHERE r.model_id = ${model.id}::uuid AND s.kind = ${kind} AND NOT o.is_dir
       AND o.archive_revision_id IS NULL AND o.current_revision_id = r.id
       AND o.gone_since IS NULL
       AND NOT EXISTS (SELECT 1 FROM original_copies c
                        WHERE c.model_id = r.model_id AND c.source_revision_id = r.id
                          AND c.place = ${target.place})
     ORDER BY r.id`)
  const exclude = model.config.exclude[kind]
  const wanted: { original_id: string; path: string }[] = []
  for (const row of rows) {
    const relative = sourcePath(row.path, row.root_path ?? '').relative
    if (relative === '' || isExcluded(relative, exclude, kind)) continue
    wanted.push({ original_id: row.id, path: joinPath(target.root, relative) })
  }
  return insert(q, model, target, 'source_revision_id', wanted)
}

async function enrolUploads(q: Queryable, model: ConfiguredModel, target: Target) {
  const { rows } = await q.execute<{ id: string; name: string; month: string }>(sql`
    SELECT u.id, u.client_filename AS name,
           to_char(u.created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM') AS month
      FROM web_uploads u
     WHERE u.model_id = ${model.id}::uuid AND u.state = 'registered' AND u.sha256 IS NOT NULL
       AND u.raw_released_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM original_copies c
                        WHERE c.model_id = u.model_id AND c.web_upload_id = u.id
                          AND c.place = ${target.place})
     ORDER BY u.id`)
  const wanted = rows.map((row) => ({
    original_id: row.id,
    path: joinPath(target.root, row.month, `${row.id}_${safeName(row.name)}`),
  }))
  return insert(q, model, target, 'web_upload_id', wanted)
}
