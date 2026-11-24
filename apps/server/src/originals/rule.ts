import type { Queryable } from '@contentops/db'
import { sourcePath } from '@contentops/sources'
import { type SQL, sql } from 'drizzle-orm'
import { type PathRule, pathRuleOf, withoutDraft } from '../legacy/reconcile'
import { isExcluded, MODEL_CONFIG_KEY, type OriginKind, parseModelConfig } from './config'

/**
 * The rule of the originals (SPEC §9.4; owner's rule 24.11.2026) as one query over the ledger
 * `original_copies`. An original is a revision of the model's cloud folder (Я.Диск, Dropbox) that
 * is not inside an archive, or a registered web upload. Per original:
 *
 * - *надёжен* (`reliable`) — two different clouds hold it, each checked byte for byte
 *   (`verified_at`) and still seen (`missing_since` empty); a new object under the path drops the
 *   check by itself (trigger of 0027);
 * - *решён* (`decided`) — ContentOps has what it needs from these bytes: the master is built,
 *   checked and on our disk (acceptance by a person is not awaited), or ContentOps decided there
 *   will be none — rejected by a person with a reason, an alias of accepted bytes, not content or
 *   not media by the import's rules, an archive whose members are all decided. `master_failed`
 *   and what is not imported yet are not decided;
 * - *можно освобождать* (`releasable`) — both: the copy on the PC may go (the copy of Я.Диск,
 *   `E:\Ari`). A master is never a release target: `is_master` — these bytes are a master, and a
 *   web upload whose bytes are a master is never releasable; a blob is released only when
 *   `is_master` is false, whatever `releasable` says.
 *
 * `reason` — how it was decided (`master`, `alias`, `rejected`, `import_rule`, `archive`) or why
 * not (`not_imported`, `master_failed`, `master_missing`, a blocked reason, a draft state).
 * Nothing here writes; the later steps (the check, the route of Windows, the release in the VM)
 * read this query, so the rule lives in one place.
 */

export type OriginalKind = 'revision' | 'upload'
export type Holder = 'yandex_disk' | 'dropbox' | 'web_upload'

export interface OriginalState extends Record<string, unknown> {
  kind: OriginalKind
  id: string
  /** The source of the original, and so where it lies on the PC. */
  holder: Holder
  path: string
  byte_size: string
  member: boolean
  /** Different clouds that hold it checked. */
  places: number
  reliable: boolean
  decided: boolean
  reason: string
  is_master: boolean
  releasable: boolean
  /** A web upload whose bytes already went from our disk (`raw_released_at`). */
  released: boolean
}

/**
 * Revisions without a draft that the import's own rules settle (SPEC §6.3, the reconciliation):
 * not content, or not media by name. An archive is never «not media» here — it counts by its
 * members, and one not unpacked yet waits. Members of archives go by their name only, as in the
 * reconciliation.
 */
export async function settledWithoutDraft(q: Queryable, modelId: string): Promise<string[]> {
  const { rows } = await q.execute<{
    id: string
    path: string
    kind: string
    root_path: string | null
    member: boolean
  }>(sql`
    SELECT r.id, COALESCE(r.frozen_path, o.current_path) AS path, s.kind, s.root_path,
           o.archive_revision_id IS NOT NULL AS member
      FROM source_revisions r
      JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
      JOIN sources s ON s.model_id = o.model_id AND s.id = o.source_id
     WHERE r.model_id = ${modelId}::uuid AND s.kind IN ('yandex_disk', 'dropbox') AND NOT o.is_dir
       AND NOT EXISTS (SELECT 1 FROM inbox_drafts d
                        WHERE d.model_id = r.model_id AND d.source_revision_id = r.id)`)
  const rules = new Map<string, PathRule>()
  const settled: string[] = []
  for (const row of rows) {
    const key = `${row.kind}\u0000${row.root_path ?? ''}`
    let rule = rules.get(key)
    if (!rule) {
      rule = await pathRuleOf(q, modelId, { kind: row.kind, rootPath: row.root_path ?? '' })
      rules.set(key, rule)
    }
    const context = rule(row.path)
    const notContent = !row.member && context.notContent
    const outcome = withoutDraft(row.path, notContent)
    if (outcome === null) continue
    if (outcome === 'not_media' && context.isArchive && !notContent) continue
    settled.push(row.id)
  }
  return settled
}

/**
 * The query: a row per original of the model (`OriginalState`), with the members of archives when
 * `members` is set. `settled` — what `settledWithoutDraft` gave. Use as a subquery:
 * `SELECT … FROM (${originalsSql(…)}) o WHERE o.releasable`.
 */
export function originalsSql(
  modelId: string,
  settled: readonly string[],
  options: { members?: boolean; notOriginals?: readonly string[] } = {},
): SQL {
  return sql`
    WITH judged AS (
      SELECT r.model_id, 'revision'::text AS kind, r.id, s.kind AS holder,
             COALESCE(r.frozen_path, o.current_path) AS path, r.byte_size,
             o.archive_revision_id AS archive_id,
             EXISTS (SELECT 1 FROM review_cases c
                      WHERE c.model_id = r.model_id AND c.kind = 'unreadable_input'
                        AND c.dedup_key = 'archive:' || r.id::text) AS unreadable,
             COALESCE(d.source_sha256, r.source_sha256) AS own_sha256,
             d.id AS draft_id, d.state AS draft_state, d.outcome, d.blocked_reason,
             d.decided_by, d.reject_reason, d.master_sha256, d.master_verified_at,
             d.source_sha256 AS draft_source_sha256, d.duplicate_of_version_id,
             NULL::timestamptz AS released_at
        FROM source_revisions r
        JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
        JOIN sources s ON s.model_id = o.model_id AND s.id = o.source_id
        LEFT JOIN inbox_drafts d ON d.model_id = r.model_id AND d.source_revision_id = r.id
       WHERE r.model_id = ${modelId}::uuid AND s.kind IN ('yandex_disk', 'dropbox') AND NOT o.is_dir
         AND NOT (r.id = ANY (${sql.param([...(options.notOriginals ?? [])])}::uuid[]))
      UNION ALL
      SELECT u.model_id, 'upload', u.id, 'web_upload', u.client_filename, u.size_expected,
             NULL, false, u.sha256,
             d.id, d.state, d.outcome, d.blocked_reason,
             d.decided_by, d.reject_reason, d.master_sha256, d.master_verified_at,
             d.source_sha256, d.duplicate_of_version_id,
             u.raw_released_at
        FROM web_uploads u
        LEFT JOIN inbox_drafts d ON d.model_id = u.model_id AND d.web_upload_id = u.id
       WHERE u.model_id = ${modelId}::uuid AND u.state = 'registered'
    ),
    own AS (
      SELECT j.*,
             CASE
               WHEN j.master_verified_at IS NOT NULL AND j.draft_source_sha256 IS NOT NULL
                    AND EXISTS (SELECT 1 FROM blobs b
                                 WHERE b.sha256 = j.master_sha256 AND b.state = 'present')
                 THEN 'master'
               WHEN j.draft_state = 'resolved' AND j.outcome = 'alias'
                    AND EXISTS (SELECT 1 FROM asset_versions v
                                  JOIN blobs b ON b.sha256 = v.master_sha256
                                 WHERE v.model_id = j.model_id AND v.id = j.duplicate_of_version_id
                                   AND b.state = 'present')
                 THEN 'alias'
               WHEN j.draft_state = 'resolved' AND j.outcome = 'rejected'
                    AND j.decided_by IS NOT NULL AND j.reject_reason IS NOT NULL
                 THEN 'rejected'
               WHEN j.draft_id IS NULL AND j.id = ANY (${sql.param([...settled])}::uuid[])
                 THEN 'import_rule'
             END AS settled_as,
             (j.own_sha256 IS NOT NULL
              AND (j.master_sha256 = j.own_sha256
                   OR EXISTS (SELECT 1 FROM asset_versions v
                               WHERE v.master_sha256 = j.own_sha256))) AS is_master
        FROM judged j
    ),
    archives AS (
      SELECT archive_id, bool_and(settled_as IS NOT NULL) AS settled
        FROM own WHERE archive_id IS NOT NULL GROUP BY archive_id
    ),
    places AS (
      SELECT COALESCE(c.source_revision_id, c.web_upload_id) AS original_id,
             count(DISTINCT c.place)::int AS n
        FROM original_copies c
       WHERE c.model_id = ${modelId}::uuid AND c.verified_at IS NOT NULL
         AND c.missing_since IS NULL
       GROUP BY 1
    ),
    decided AS (
      SELECT o.*, COALESCE(p.n, 0) AS places,
             (o.settled_as IS NOT NULL
              OR (a.archive_id IS NOT NULL AND NOT o.unreadable AND a.settled)) AS is_decided,
             CASE
               WHEN o.settled_as IS NOT NULL THEN o.settled_as
               WHEN o.unreadable THEN 'archive_unreadable'
               WHEN a.archive_id IS NOT NULL THEN
                 CASE WHEN a.settled THEN 'archive' ELSE 'archive_members' END
               WHEN o.draft_id IS NULL THEN 'not_imported'
               WHEN o.blocked_reason IS NOT NULL THEN o.blocked_reason
               WHEN o.master_verified_at IS NOT NULL THEN 'master_missing'
               WHEN o.draft_state = 'resolved' THEN 'resolved:' || o.outcome
               ELSE o.draft_state
             END AS reason
        FROM own o
        LEFT JOIN archives a ON a.archive_id = o.id
        LEFT JOIN places p ON p.original_id = o.id
    )
    SELECT kind, id, holder, path, byte_size::text AS byte_size, archive_id IS NOT NULL AS member,
           places, places >= 2 AS reliable, is_decided AS decided, reason, is_master,
           (places >= 2 AND is_decided AND NOT (kind = 'upload' AND is_master)) AS releasable,
           released_at IS NOT NULL AS released
      FROM decided
     WHERE ${options.members === true}::boolean OR archive_id IS NULL`
}

/** The rule for a model, ready to read: the query with what the import's rules settle. */
export async function originalsRule(
  q: Queryable,
  modelId: string,
  options: { members?: boolean } = {},
): Promise<SQL> {
  return originalsSql(modelId, await settledWithoutDraft(q, modelId), {
    ...options,
    notOriginals: await notOriginals(q, modelId),
  })
}

/**
 * Revisions that are not originals: what lies in the folders `exclude` of the model's
 * `originals.model_config` — ContentOps's own copies in the model's cloud (`Архив Я.Диска` in
 * Lora's Dropbox holds copies of her Я.Диск files, not new originals) and tests. They are not
 * counted, not copied and never released; the scan still sees them, intake skips them by
 * `legacy.not_content`. A model without a configuration has none.
 */
export async function notOriginals(q: Queryable, modelId: string): Promise<string[]> {
  const { rows: configs } = await q.execute<{ value: unknown }>(sql`
    SELECT value FROM policy_settings
     WHERE key = ${MODEL_CONFIG_KEY} AND model_id = ${modelId}::uuid
       AND account_id IS NULL AND item_type IS NULL AND value IS NOT NULL`)
  const parsed = configs[0] ? parseModelConfig(configs[0].value) : null
  if (!parsed?.ok) return []
  const exclude = parsed.config.exclude
  if (exclude.yandex_disk.length === 0 && exclude.dropbox.length === 0) return []
  const { rows } = await q.execute<{
    id: string
    path: string
    frozen_path: string | null
    kind: OriginKind
    root_path: string | null
  }>(sql`
    SELECT r.id, o.current_path AS path, r.frozen_path, s.kind, s.root_path
      FROM source_revisions r
      JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
      JOIN sources s ON s.model_id = o.model_id AND s.id = o.source_id
     WHERE r.model_id = ${modelId}::uuid AND s.kind IN ('yandex_disk', 'dropbox') AND NOT o.is_dir`)
  const out: string[] = []
  for (const row of rows) {
    const folders = exclude[row.kind]
    if (folders.length === 0) continue
    const paths = [row.path, row.frozen_path].filter((p): p is string => !!p)
    if (
      paths.some((p) => isExcluded(sourcePath(p, row.root_path ?? '').relative, folders, row.kind))
    ) {
      out.push(row.id)
    }
  }
  return out
}

/** Every original of the model with its state (members of archives with `members`). */
export async function originalStates(
  q: Queryable,
  modelId: string,
  options: { members?: boolean } = {},
): Promise<OriginalState[]> {
  const { rows } = await q.execute<OriginalState>(sql`
    SELECT * FROM (${await originalsRule(q, modelId, options)}) o ORDER BY o.kind, o.path, o.id`)
  return rows
}
