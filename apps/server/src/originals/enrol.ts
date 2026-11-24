import type { Queryable } from '@contentops/db'
import { sourcePath } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import { type ConfiguredModel, isExcluded, joinPath, type OriginKind } from './config'
import { notOriginals } from './rule'
import { originRows } from './seed'

/**
 * New originals get their rows in the ledger by themselves (SPEC §9.4), before every check and
 * audit: the origin row as `ops.js originals seed` makes it, and — where the model's
 * configuration says where its nightly copy puts a source (`copies`) — a MEGA copy row at
 * `<mega>/<folder>/<path in the source>`, not checked, without a node yet (the audit or the check
 * finds it). Only rows that do not exist are added; a row already there is never changed here.
 * Members of archives are not originals; a gone object or an older revision gets no copy row.
 */

export interface EnrolReport {
  origins: number
  copies: number
}

const BATCH = 2_000

export async function enrolOriginals(q: Queryable, model: ConfiguredModel): Promise<EnrolReport> {
  const { rowCount } = await q.execute(sql`
    ${originRows(model.id, await notOriginals(q, model.id))}
    ON CONFLICT (model_id, source_revision_id, place) WHERE source_revision_id IS NOT NULL
    DO NOTHING`)
  let copies = 0
  const mega = model.config.mega
  if (mega) {
    for (const kind of ['yandex_disk', 'dropbox'] as const satisfies readonly OriginKind[]) {
      const folder = model.config.copies[kind]
      if (!folder) continue
      copies += await enrolCopies(q, model, kind, joinPath(mega.path, folder), mega.remote)
    }
  }
  return { origins: rowCount ?? 0, copies }
}

async function enrolCopies(
  q: Queryable,
  model: ConfiguredModel,
  kind: OriginKind,
  root: string,
  remote: string,
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
                          AND c.place = 'mega')
     ORDER BY r.id`)
  const exclude = model.config.exclude[kind]
  const wanted: { revision_id: string; path: string }[] = []
  for (const row of rows) {
    const relative = sourcePath(row.path, row.root_path ?? '').relative
    if (relative === '' || isExcluded(relative, exclude, kind)) continue
    wanted.push({ revision_id: row.id, path: joinPath(root, relative) })
  }
  let added = 0
  for (let at = 0; at < wanted.length; at += BATCH) {
    const batch = wanted.slice(at, at + BATCH)
    const { rowCount } = await q.execute(sql`
      INSERT INTO original_copies (model_id, source_revision_id, place, role, remote, path)
      SELECT ${model.id}::uuid, x.revision_id, 'mega', 'copy', ${remote}, x.path
        FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS x(revision_id uuid, path text)
      ON CONFLICT (model_id, source_revision_id, place) WHERE source_revision_id IS NOT NULL
      DO NOTHING`)
    added += rowCount ?? 0
  }
  return added
}
