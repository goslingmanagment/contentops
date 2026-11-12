import type { FileMatch, FileSearchResult } from '@contentops/contracts/domain/search'
import { formatDayMonth } from '@contentops/contracts/format'
import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { ModelScope } from '../context'
import { type DbItemType, publicIdOf } from './ids'

/**
 * «Отпустите — найдём такой же файл» (DESIGN §4.7, PRD §5 «совпадающие файлы»): which object
 * holds exactly these bytes. The browser hashes the dropped file; here the SHA-256 is looked up
 * among the masters and sources of the versions, the copies issued for pages (a KM keeps the
 * copy with stripped metadata, not the master), the platform copies, the files of the old disk
 * kept as aliases of a file and the drafts of «Приехало», including exact duplicates that became
 * aliases. A file re-encoded by a platform has other bytes: it needs a visual match (SPEC §13).
 */

interface MatchRow extends Record<string, unknown> {
  rank: number
  what: string
  type: DbItemType | null
  number: number | null
  title: string | null
  version_no: number | null
  variant_no: number | null
  account: string | null
  on_day: string | null
  group_id: string | null
}

export async function searchFile(
  q: Queryable,
  model: ModelScope,
  sha256: string,
): Promise<FileSearchResult> {
  const { rows } = await q.execute<MatchRow>(sql`
    WITH h AS (SELECT decode(${sha256}, 'hex') AS sha)
    SELECT m.* FROM (
      SELECT 1 AS rank,
             CASE WHEN v.master_sha256 = h.sha THEN 'мастер' ELSE 'исходник' END AS what,
             i.type, i.number, i.title, v.version_no, a.variant_no,
             NULL::text AS account, NULL::text AS on_day, NULL::text AS group_id, v.created_at AS at
        FROM h, asset_versions v
        JOIN assets a ON a.model_id = v.model_id AND a.id = v.asset_id
        JOIN content_items i ON i.model_id = a.model_id AND i.id = a.created_in_item_id
       WHERE v.model_id = ${model.id}::uuid
         AND (v.master_sha256 = h.sha OR v.source_sha256 = h.sha)
      UNION ALL
      SELECT 2, 'выданная копия', i.type, i.number, i.title, v.version_no, a.variant_no,
             r.account_code_snapshot,
             coalesce(r.slot_date_snapshot, (r.issued_at AT TIME ZONE 'Europe/Moscow')::date)::text,
             NULL, r.issued_at
        FROM h, download_receipt_entries e
        JOIN download_receipts r ON r.model_id = e.model_id AND r.id = e.receipt_id
        JOIN asset_versions v ON v.model_id = e.model_id AND v.id = e.asset_version_id
        JOIN assets a ON a.model_id = v.model_id AND a.id = v.asset_id
        JOIN content_items i ON i.model_id = a.model_id AND i.id = a.created_in_item_id
       WHERE e.model_id = ${model.id}::uuid AND e.output_sha256 = h.sha
      UNION ALL
      SELECT 3, 'копия для платформы', i.type, i.number, i.title, v.version_no, a.variant_no,
             NULL, NULL, NULL, ra.created_at
        FROM h, rendition_artifacts ra
        JOIN rendition_generations g ON g.id = ra.generation_id
        JOIN asset_versions v ON v.master_sha256 = g.master_sha256
        JOIN assets a ON a.model_id = v.model_id AND a.id = v.asset_id
        JOIN content_items i ON i.model_id = a.model_id AND i.id = a.created_in_item_id
       WHERE ra.output_sha256 = h.sha AND v.model_id = ${model.id}::uuid
      UNION ALL
      SELECT 4, 'файл со старого диска', i.type, i.number, i.title, NULL, NULL,
             NULL, NULL, NULL, sr.detected_at
        FROM h, source_revisions sr
        JOIN aliases al ON al.model_id = sr.model_id AND al.source_object_id = sr.source_object_id
                       AND al.asset_id IS NOT NULL
        JOIN assets a ON a.model_id = al.model_id AND a.id = al.asset_id
        JOIN content_items i ON i.model_id = a.model_id AND i.id = a.created_in_item_id
       WHERE sr.model_id = ${model.id}::uuid AND sr.source_sha256 = h.sha
      UNION ALL
      SELECT 5,
             CASE WHEN i.id IS NULL THEN 'в Приехало' ELSE 'дубль в Приехало' END,
             i.type, i.number, coalesce(i.title, g.proposed_title, d.path), NULL, NULL,
             NULL, NULL, d.group_id::text, d.discovered_at
        FROM h, inbox_drafts d
        JOIN inbox_groups g ON g.model_id = d.model_id AND g.id = d.group_id
        LEFT JOIN inbox_draft_candidates c ON c.model_id = d.model_id AND c.draft_id = d.id
                                          AND c.kind = 'exact_duplicate' AND c.chosen
        LEFT JOIN content_items i ON i.model_id = d.model_id AND i.id = c.item_id
       WHERE d.model_id = ${model.id}::uuid AND d.applied_item_id IS NULL
         AND (d.source_sha256 = h.sha OR d.master_sha256 = h.sha OR d.source_blob_sha256 = h.sha)
    ) m
    ORDER BY m.rank, m.at DESC
    LIMIT 40`)
  const { rows: pages } = await q.execute<{ code: string; label: string }>(sql`
    SELECT code, title AS label FROM accounts WHERE model_id = ${model.id}::uuid`)
  const label = new Map(pages.map((page) => [page.code, page.label]))
  const matches = unique(rows.map((row) => matchOf(row, label)))
  return { sha256, matches, text: phraseOf(matches[0]) }
}

function matchOf(row: MatchRow, label: ReadonlyMap<string, string>): FileMatch {
  return {
    item_id: row.type && row.number !== null ? publicIdOf(row.type, row.number) : null,
    title: row.title ?? '',
    what: row.what,
    // A FYP's version for a page is its variant (`u2` — «версия 2»), otherwise the version.
    version: row.variant_no ? row.variant_no : row.version_no,
    issued: row.on_day
      ? {
          account: row.account,
          label: row.account ? (label.get(row.account) ?? row.account) : null,
          on: row.on_day,
        }
      : null,
    group_id: row.group_id,
  }
}

function unique(matches: readonly FileMatch[]): FileMatch[] {
  const seen = new Set<string>()
  return matches.filter((match) => {
    const key = JSON.stringify([match.item_id, match.what, match.version, match.issued])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** «Этот файл: FYP-0412 версия 2 · Fansly 2 12 авг.» or «Такого файла нет» (DESIGN §4.7). */
export function phraseOf(match: FileMatch | undefined): string {
  if (!match) return 'Такого файла нет'
  if (!match.item_id) return `Этот файл в «Приехало»: ${match.title}`
  const version = match.version && match.version > 1 ? ` версия ${match.version}` : ''
  const issued = match.issued
    ? [match.issued.label, formatDayMonth(match.issued.on)].filter(Boolean).join(' ')
    : match.what
  return `Этот файл: ${match.item_id}${version} · ${issued}`
}
