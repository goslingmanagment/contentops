import type { Queryable, WorkContext, WorkSuccess } from '@contentops/db'
import { WorkError } from '@contentops/db'
import { sourcePath } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import { mediaKindOf } from '../intake/grouping'
import { displayRoot, ROOTS } from './review'
import { type SnapshotWork, snapshotOf } from './snapshot'

/**
 * The reconciliation with the snapshot (SPEC §6.3 «Сверка», PLAN этап 3 — the exit artifact):
 * every revision the snapshot pinned has exactly one outcome — accepted, an alias of accepted
 * bytes, rejected with its author and reason, an archive accounted by its members, blocked or
 * waiting with a concrete reason; the counts by root add up to the snapshot, members of
 * archives are a denominator of their own. The work writes nothing but its report; stage 3
 * closes at zero unexplained rows.
 */

export const RECONCILE_DATASET = 'reconcile'

export type Outcome =
  | 'accepted'
  | 'alias'
  | 'rejected'
  | 'archive'
  | 'blocked'
  | 'waiting'
  | 'not_media'
  | 'unexplained'

export interface RootCount {
  root: string
  snapshot: number
  outcomes: Partial<Record<Outcome, number>>
  /** Sum of the outcomes equals the snapshot count. */
  adds_up: boolean
}

export interface ReconcileReport {
  mode: 'reconcile'
  model: string
  snapshot: { work_id: string; work_key: string; source: string }
  files: RootCount[]
  members: RootCount[]
  totals: { files: number; members: number; unexplained: number }
  /** Reasons of blocked and waiting rows, counted. */
  reasons: Record<string, number>
  /** The unexplained rows themselves (stage 3 closes at zero). */
  unexplained: { revision_id: string; path: string; why: string }[]
}

interface Row extends Record<string, unknown> {
  revision_id: string
  path: string
  member: boolean
  container: boolean
  unreadable: boolean
  gone: boolean
  draft_state: string | null
  outcome: string | null
  blocked_reason: string | null
  error: string | null
  decided_by: string | null
  reject_reason: string | null
  successor_state: string | null
  successor_outcome: string | null
}

function classify(row: Row): { outcome: Outcome; reason: string | null } {
  if (row.container) {
    return row.unreadable
      ? { outcome: 'blocked', reason: 'archive_unreadable' }
      : { outcome: 'archive', reason: null }
  }
  if (row.unreadable) return { outcome: 'blocked', reason: 'archive_unreadable' }
  if (row.draft_state === null) {
    const name = row.path.slice(row.path.lastIndexOf('/') + 1)
    if (mediaKindOf(name, null) === null) return { outcome: 'not_media', reason: null }
    return { outcome: 'waiting', reason: 'not_imported_yet' }
  }
  if (row.draft_state === 'resolved') {
    if (row.outcome === 'new_item' || row.outcome === 'append')
      return { outcome: 'accepted', reason: null }
    if (row.outcome === 'alias') return { outcome: 'alias', reason: null }
    if (row.outcome === 'rejected') {
      return row.decided_by && row.reject_reason
        ? { outcome: 'rejected', reason: null }
        : { outcome: 'unexplained', reason: 'rejected_without_author_or_reason' }
    }
    return { outcome: 'unexplained', reason: `resolved:${row.outcome}` }
  }
  if (row.blocked_reason) {
    // Changed in the cloud after the snapshot: the frozen row keeps its outcome (SPEC §6.3).
    if (row.blocked_reason === 'source_unavailable' && row.successor_state !== null) {
      return {
        outcome: 'blocked',
        reason: `changed_after_snapshot:${row.successor_outcome ?? row.successor_state}`,
      }
    }
    if (row.blocked_reason === 'source_unavailable') {
      return {
        outcome: 'blocked',
        reason: row.gone ? 'source_gone_without_bytes' : 'source_unavailable',
      }
    }
    return {
      outcome: 'blocked',
      reason: row.error ? `${row.blocked_reason}:${row.error}` : row.blocked_reason,
    }
  }
  return { outcome: 'waiting', reason: row.draft_state }
}

async function rowsOf(q: Queryable, snapshot: SnapshotWork): Promise<Row[]> {
  const { rows } = await q.execute<Row>(sql`
    SELECT r.id AS revision_id, r.frozen_path AS path, o.archive_revision_id IS NOT NULL AS member,
           EXISTS (SELECT 1 FROM source_objects m
                    WHERE m.model_id = r.model_id AND m.archive_revision_id = r.id) AS container,
           EXISTS (SELECT 1 FROM review_cases c
                    WHERE c.model_id = r.model_id AND c.kind = 'unreadable_input'
                      AND c.dedup_key = 'archive:' || r.id::text) AS unreadable,
           o.gone_since IS NOT NULL AS gone,
           d.state AS draft_state, d.outcome, d.blocked_reason, d.error, d.decided_by,
           d.reject_reason, sd.state AS successor_state, sd.outcome AS successor_outcome
      FROM source_revisions r
      JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
      LEFT JOIN inbox_drafts d ON d.model_id = r.model_id AND d.source_revision_id = r.id
      LEFT JOIN LATERAL (
        SELECT n.id FROM source_revisions n
         WHERE n.model_id = r.model_id AND n.previous_id = r.id
         ORDER BY n.sequence_no DESC LIMIT 1
      ) succ ON true
      LEFT JOIN inbox_drafts sd ON sd.model_id = r.model_id AND sd.source_revision_id = succ.id
     WHERE r.model_id = ${snapshot.modelId}::uuid AND r.frozen_by_work_id = ${snapshot.id}::uuid
     ORDER BY r.frozen_path`)
  return rows
}

export async function reconcile(
  q: Queryable,
  snapshot: SnapshotWork,
  model: string,
): Promise<ReconcileReport> {
  const rows = await rowsOf(q, snapshot)
  const files = new Map<string, RootCount>()
  const members = new Map<string, RootCount>()
  const reasons: Record<string, number> = {}
  const unexplained: ReconcileReport['unexplained'] = []
  for (const row of rows) {
    const relative = sourcePath(row.path, snapshot.rootPath).relative
    const root = displayRoot(relative, row.member)
    const table = row.member ? members : files
    const count = table.get(root) ?? { root, snapshot: 0, outcomes: {}, adds_up: true }
    const { outcome, reason } = classify(row)
    count.snapshot += 1
    count.outcomes[outcome] = (count.outcomes[outcome] ?? 0) + 1
    table.set(root, count)
    if (reason && (outcome === 'blocked' || outcome === 'waiting')) {
      reasons[`${outcome}:${reason}`] = (reasons[`${outcome}:${reason}`] ?? 0) + 1
    }
    if (outcome === 'unexplained') {
      unexplained.push({ revision_id: row.revision_id, path: relative, why: reason ?? '' })
    }
  }
  const ordered = (table: Map<string, RootCount>) =>
    [...table.values()]
      .map((count) => ({
        ...count,
        adds_up: Object.values(count.outcomes).reduce((n, v) => n + (v ?? 0), 0) === count.snapshot,
      }))
      .sort(
        (a, b) =>
          ROOTS.indexOf(a.root as (typeof ROOTS)[number]) -
          ROOTS.indexOf(b.root as (typeof ROOTS)[number]),
      )
  const fileCounts = ordered(files)
  const memberCounts = ordered(members)
  return {
    mode: 'reconcile',
    model,
    snapshot: { work_id: snapshot.id, work_key: snapshot.workKey, source: snapshot.sourceLabel },
    files: fileCounts,
    members: memberCounts,
    totals: {
      files: fileCounts.reduce((n, c) => n + c.snapshot, 0),
      members: memberCounts.reduce((n, c) => n + c.snapshot, 0),
      unexplained: unexplained.length,
    },
    reasons,
    unexplained,
  }
}

/** The work: the report on its row, nothing else written. */
export async function reconcileWork(ctx: WorkContext): Promise<WorkSuccess> {
  const modelId = ctx.work.modelId as string
  const snapshot = await snapshotOf(ctx.db, modelId, ctx.work.scope)
  if (!snapshot) throw new WorkError('permanent', 'snapshot_missing', 'нет готового снимка')
  const { rows } = await ctx.db.execute<{ code: string }>(sql`
    SELECT code FROM models WHERE id = ${modelId}::uuid`)
  return { report: await reconcile(ctx.db, snapshot, rows[0]?.code ?? '') }
}

const LABEL: Record<Outcome, string> = {
  accepted: 'принято',
  alias: 'алиас',
  rejected: 'отклонено',
  archive: 'архив (по участникам)',
  blocked: 'заблокировано',
  waiting: 'ожидает',
  not_media: 'не медиа',
  unexplained: 'НЕОБЪЯСНЕНО',
}

/** The report as Markdown, out of git (it may name real paths). */
export function reconcileMarkdown(report: ReconcileReport): string {
  const table = (counts: RootCount[]) => {
    const kinds = Object.keys(LABEL) as Outcome[]
    return [
      `| Корень | В снимке | ${kinds.map((k) => LABEL[k]).join(' | ')} | Сходится |`,
      `| --- | --- | ${kinds.map(() => '---').join(' | ')} | --- |`,
      ...counts.map(
        (c) =>
          `| ${c.root} | ${c.snapshot} | ${kinds.map((k) => c.outcomes[k] ?? 0).join(' | ')} | ${c.adds_up ? 'да' : 'нет'} |`,
      ),
      '',
    ]
  }
  return [
    `# Сверка импорта со снимком: ${report.model}`,
    '',
    `- Снимок: \`${report.snapshot.work_key}\` (${report.snapshot.source})`,
    `- Файлов в снимке: ${report.totals.files}; участников архивов: ${report.totals.members}`,
    `- Необъяснённых строк: **${report.totals.unexplained}**`,
    '',
    '## Файлы по корням',
    '',
    ...table(report.files),
    '## Участники архивов',
    '',
    ...(report.members.length > 0 ? table(report.members) : ['нет', '']),
    '## Причины ожидания и блокировки',
    '',
    ...(Object.keys(report.reasons).length === 0
      ? ['нет', '']
      : [
          ...Object.entries(report.reasons)
            .sort(([, a], [, b]) => b - a)
            .map(([reason, n]) => `- ${reason}: ${n}`),
          '',
        ]),
    '## Необъяснённые строки',
    '',
    ...(report.unexplained.length === 0
      ? ['нет', '']
      : [...report.unexplained.map((u) => `- ${u.path} — ${u.why}`), '']),
  ].join('\n')
}
