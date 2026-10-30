import { createHash } from 'node:crypto'
import type {
  Dispute,
  DisputeKind,
  DisputeOption,
  LegacyProgress,
  LegacyReview,
  LegacyRoot,
} from '@contentops/contracts/domain/legacy'
import type { Queryable } from '@contentops/db'
import { sourcePath } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import { instant } from '../commands'
import { labelMappings } from './labels'
import { type ImportReport, lastImportWork } from './parse'
import { snapshotOf } from './snapshot'

/**
 * «Приехало › Разбор старого» (DESIGN §4.9) from the database: the progress line by roots, the
 * card «Метки старых имён → страницы» and the disputed cases by kind. Disputes are what a person
 * has to decide: number claims of §6.4 whose decision nobody confirmed, and the open review
 * cases of the pass (and of the snapshot and intake).
 */

const NUMBER_OPTIONS: DisputeOption[] = [
  { key: 'keep', label: 'оставить', input: null },
  { key: 'new_number', label: 'новый номер', input: null },
  { key: 'typo', label: 'опечатка', input: null },
  { key: 'unclear', label: 'неясно — оставить в разборе', input: null },
]
const UNCLEAR: DisputeOption = { key: 'unclear', label: 'неясно — оставить в разборе', input: null }
const option = (key: string, label: string, input: DisputeOption['input'] = null) => ({
  key,
  label,
  input,
})

/** Roots of the old disk in the order of DESIGN §4.9. */
export const ROOTS = [
  'PPV',
  'Секстинги',
  'Сеты',
  'Кастомы',
  'FYP',
  'Остальное',
  'SMM',
  'Архивы',
  '«Старый формат»',
] as const

const ARCHIVE = /\.(zip|rar|7z|tar|gz|tgz)$/i

/** The root of DESIGN §4.9 a path of the old disk belongs to (first component). */
export function displayRoot(relative: string, member = false): string {
  if (member) return 'Архивы'
  const parts = relative.split('/')
  const first = parts[0] ?? ''
  if (parts.length === 1 && ARCHIVE.test(first)) return 'Архивы'
  if (/^старый формат$/i.test(first)) return '«Старый формат»'
  if (/^1\.\s*ppv$/i.test(first)) return 'PPV'
  if (/^2\.\s*fyp$/i.test(first)) return 'FYP'
  if (/^3\.\s*customs?$/i.test(first)) return 'Кастомы'
  if (/^4\.\s*sets?$/i.test(first)) return 'Сеты'
  if (/^5\.\s*sextings?$/i.test(first)) return 'Секстинги'
  if (/^9\.\s*smm$/i.test(first)) return 'SMM'
  return 'Остальное'
}

const pad = (type: string, n: number) =>
  `${type}-${String(n).padStart(type === 'FYP' || type === 'RAW' ? 4 : 3, '0')}`

/** `[PPV-032]_cocoa_cup_01.07.2025` → `cocoa_cup`: the words a person recognises. */
export function shortName(name: string): string {
  const words = name
    .replace(/^\[[^\]]+\]_?/, '')
    .replace(/_(\d{1,2}\.\d{1,2}(\.\d{2,4})?|X(\.X){0,2})$/i, '')
  return words || name
}

const COUNT_WORD: Record<number, string> = { 2: 'двух', 3: 'трёх', 4: 'четырёх', 5: 'пяти' }

// ── Number claims ─────────────────────────────────────────────────────────────────────

export interface NumberUnit extends Record<string, unknown> {
  id: string
  type: string
  claimed: number
  decision: 'keep' | 'renumber' | 'typo' | 'unclear'
  assigned: number | null
  decided_by: string | null
  decided_at: string | null
  by_name: string | null
  registry_claim_id: string | null
  claim_id: string
  object_id: string
  name: string
  path: string
  claim_kind: string
  form: string | null
  registry_number: number | null
}

export async function numberUnits(q: Queryable, modelId: string): Promise<NumberUnit[]> {
  const { rows } = await q.execute<NumberUnit>(sql`
    SELECT n.id, n.type, n.claimed_number AS claimed, n.decision, n.assigned_number AS assigned,
           n.decided_by, n.decided_at::text AS decided_at, p.display_name AS by_name,
           n.registry_claim_id, n.claim_id, n.source_object_id AS object_id,
           o.current_name AS name, o.current_path AS path, c.claim_kind,
           c.payload ->> 'form' AS form, (r.payload ->> 'number')::int AS registry_number
      FROM legacy_number_claims n
      JOIN legacy_claims c ON c.model_id = n.model_id AND c.id = n.claim_id
      JOIN source_objects o ON o.model_id = n.model_id AND o.id = n.source_object_id
      LEFT JOIN legacy_claims r ON r.model_id = n.model_id AND r.id = n.registry_claim_id
      LEFT JOIN principals p ON p.id = n.decided_by
     WHERE n.model_id = ${modelId}::uuid AND c.resolution <> 'ignored'
     ORDER BY n.type, n.claimed_number, o.current_name, n.id`)
  return rows
}

const isFolder = (unit: NumberUnit) => unit.claim_kind === 'number' && unit.form !== 'evidence'

/** Units of a collision: folders (not typos) claiming one number, two names or more. */
export function collisions(units: readonly NumberUnit[]): Map<string, NumberUnit[]> {
  const groups = new Map<string, NumberUnit[]>()
  for (const unit of units) {
    if (!isFolder(unit) || unit.decision === 'typo') continue
    const key = `${unit.type}:${unit.claimed}`
    groups.set(key, [...(groups.get(key) ?? []), unit])
  }
  for (const [key, group] of groups) {
    if (new Set(group.map((unit) => unit.name)).size < 2) groups.delete(key)
  }
  return groups
}

/** Registry rows without a folder: their number stays reserved, the parser left them unclear. */
export function registryOnly(units: readonly NumberUnit[]): NumberUnit[] {
  const linked = new Set(
    units.flatMap((unit) => (unit.registry_claim_id ? [unit.registry_claim_id] : [])),
  )
  return units.filter(
    (unit) =>
      unit.claim_kind === 'registry_row' &&
      !linked.has(unit.claim_id) &&
      unit.decision === 'unclear',
  )
}

const settled = (units: readonly NumberUnit[]) =>
  units.every((unit) => unit.decided_by !== null && unit.decision !== 'unclear')

function resolvedOf(units: readonly NumberUnit[], option: string): Dispute['resolved'] {
  if (!settled(units)) return null
  const last = [...units].sort((a, b) => ((a.decided_at ?? '') < (b.decided_at ?? '') ? 1 : -1))[0]
  return {
    option,
    by: last?.by_name ?? 'система',
    at: instant(last?.decided_at ?? new Date().toISOString()),
  }
}

const FOLDER_PROPOSAL: Record<NumberUnit['decision'], string> = {
  keep: 'keep',
  renumber: 'new_number',
  typo: 'typo',
  unclear: 'unclear',
}

function base(id: string, kind: DisputeKind, root: string, title: string): Dispute {
  return {
    id,
    kind,
    root,
    title,
    fragment: null,
    thumbs: [],
    label: null,
    folders: [],
    proposal: null,
    options: [],
    postponed: null,
    resolved: null,
  }
}

const thumb = (objectId: string) => ({ key: `legacy:${objectId}`, ratio: '3:4' as const })

function numberDisputes(units: readonly NumberUnit[], rootOf: (path: string) => string): Dispute[] {
  const out: Dispute[] = []
  for (const [key, group] of collisions(units)) {
    const [type = 'PPV', number = '0'] = key.split(':')
    const id = pad(type, Number(number))
    const byName = new Map<string, NumberUnit>()
    for (const unit of group) if (!byName.has(unit.name)) byName.set(unit.name, unit)
    const folders = [...byName.values()]
    const keep = folders.filter((unit) => unit.decision === 'keep')
    const fresh = folders.filter((unit) => unit.decision === 'renumber')
    const proposal =
      keep.length === 1 && fresh.length === folders.length - 1
        ? `${shortName(keep[0]?.name ?? '')} оставляет ${String(number).padStart(3, '0')}, ${fresh
            .map((unit) => shortName(unit.name))
            .join(' и ')} ${fresh.length === 1 ? 'получает новый номер' : 'получают новые номера'}`
        : null
    out.push({
      ...base(
        `number.${type}.${number}`,
        'number_taken',
        rootOf(group[0]?.path ?? ''),
        `${id} у ${COUNT_WORD[folders.length] ?? folders.length} папок`,
      ),
      fragment: folders.map((unit) => unit.name).join(' · '),
      thumbs: folders.map((unit) => thumb(unit.object_id)),
      folders: folders.map((unit) => ({
        name: unit.name,
        thumb: thumb(unit.object_id),
        proposal: FOLDER_PROPOSAL[unit.decision],
      })),
      proposal,
      options: NUMBER_OPTIONS,
      resolved: resolvedOf(group, 'proposal'),
    })
  }
  for (const unit of units) {
    if (!isFolder(unit) || unit.decision !== 'typo') continue
    const registry = unit.assigned ?? unit.registry_number
    out.push({
      ...base(
        `typo.${unit.id}`,
        'number_typo',
        rootOf(unit.path),
        `${unit.name} — в реестре ${registry === null ? '?' : String(registry).padStart(3, '0')}`,
      ),
      fragment: unit.name,
      thumbs: [thumb(unit.object_id)],
      proposal: registry === null ? null : pad(unit.type, registry),
      options: [option('keep', `оставить ${pad(unit.type, unit.claimed)}`), UNCLEAR],
      resolved: resolvedOf([unit], 'proposal'),
    })
  }
  for (const unit of registryOnly(units)) {
    out.push({
      ...base(
        `trace.${unit.id}`,
        'number_no_trace',
        'PPV',
        `${pad(unit.type, unit.claimed)}: папки нет, есть строка реестра`,
      ),
      fragment: unit.name,
      options: [option('keep', 'Номер остаётся за реестром'), UNCLEAR],
      resolved: resolvedOf([unit], 'keep'),
    })
  }
  return out
}

// ── Review cases ──────────────────────────────────────────────────────────────────────

interface CaseRow extends Record<string, unknown> {
  id: string
  kind: string
  state: string
  source_object_id: string | null
  details: {
    title?: string
    root?: string
    fragment?: string
    path?: string
    channel?: string | null
    files?: number
    objects?: string[]
  } | null
  resolution: { option?: string } | null
  resolved_at: string | null
  by_name: string | null
}

const CASE_KIND: Record<string, DisputeKind> = {
  legacy_unparsed: 'unparsed',
  unreadable_input: 'archive_broken',
  cross_model_duplicate: 'cross_model',
  smm_folder: 'smm_pack',
  number_hole: 'number_no_trace',
  merge_split: 'short_shoot',
}

const CASE_OPTIONS: Record<string, DisputeOption[]> = {
  legacy_unparsed: [
    option('assign', 'Задать тип и номер…', 'type_number'),
    option('ignore', 'Игнорировать…', 'reason'),
  ],
  unreadable_input: [option('manual', 'Разобрать вручную')],
  cross_model_duplicate: [],
  smm_folder: [
    option('pack', 'Пак подрядчику…', 'contractor'),
    option('vendor_shoot', 'Съёмка вендора'),
    UNCLEAR,
  ],
  number_hole: [
    option('leave_empty', 'Оставить пустыми'),
    option('reserve', 'Резерв по находке…', 'reason'),
  ],
  merge_split: [option('merge', 'Слить с соседней'), option('keep', 'Оставить')],
}

/** Open cases, and those decided in the last two weeks: a person sees what was done. */
async function caseDisputes(q: Queryable, modelId: string): Promise<Dispute[]> {
  const { rows } = await q.execute<CaseRow>(sql`
    SELECT c.id, c.kind, c.state, c.source_object_id, c.details, c.resolution,
           c.resolved_at::text AS resolved_at, p.display_name AS by_name
      FROM review_cases c LEFT JOIN principals p ON p.id = c.resolved_by
     WHERE c.model_id = ${modelId}::uuid
       AND c.kind IN ('legacy_unparsed', 'unreadable_input', 'cross_model_duplicate',
                      'smm_folder', 'number_hole', 'merge_split')
       AND (c.state = 'open' OR c.resolved_at > now() - interval '14 days')
     ORDER BY c.kind, c.details ->> 'title', c.id`)
  return rows.map((row) => {
    const kind = CASE_KIND[row.kind] ?? 'archive_broken'
    const details = row.details ?? {}
    const fallback =
      row.kind === 'cross_model_duplicate' ? 'Такой файл есть у другой модели' : 'Архив не читается'
    const objects = details.objects ?? (row.source_object_id ? [row.source_object_id] : [])
    return {
      ...base(
        `case.${row.id}`,
        kind,
        displayRoot(details.path ?? details.root ?? ''),
        details.title ?? fallback,
      ),
      fragment:
        row.kind === 'smm_folder'
          ? `${details.channel ?? 'SMM'} · файлов ${details.files ?? 0}`
          : (details.fragment ?? null),
      thumbs: row.kind === 'number_hole' ? [] : objects.slice(0, 3).map(thumb),
      options: CASE_OPTIONS[row.kind] ?? [],
      resolved:
        row.state === 'open'
          ? null
          : {
              option: row.resolution?.option ?? row.state,
              by: row.by_name ?? 'система',
              at: instant(row.resolved_at ?? new Date().toISOString()),
            },
    }
  })
}

/** Root archives of another model: parked until she is connected, no action (DESIGN §4.9). */
function foreignArchives(report: ImportReport | null): Dispute[] {
  return (report?.archives ?? [])
    .filter((archive) => archive.foreignModel)
    .map((archive) => ({
      ...base(
        `foreign.${createHash('sha256').update(archive.path).digest('hex').slice(0, 16)}`,
        'foreign_archive',
        'Архивы',
        `${archive.bytes === null ? '' : `${(archive.bytes / 1024 ** 3).toFixed(1).replace('.', ',')} ГБ · `}${archive.foreignModel}`,
      ),
      fragment: archive.path,
      postponed: `Отложено до подключения: ${archive.foreignModel}`,
    }))
}

export async function legacyDisputes(
  q: Queryable,
  modelId: string,
  report: ImportReport | null = null,
): Promise<Dispute[]> {
  const units = await numberUnits(q, modelId)
  const rootOf = await rootResolver(q, modelId)
  return [
    ...numberDisputes(units, rootOf),
    ...(await caseDisputes(q, modelId)),
    ...foreignArchives(report),
  ]
}

/** «Разбор старого · 38» on the tab: cases a person still has to decide. */
export async function openDisputeCount(q: Queryable, modelId: string): Promise<number> {
  const disputes = await legacyDisputes(q, modelId)
  return disputes.filter((dispute) => !dispute.resolved && !dispute.postponed).length
}

/** Source path → root of DESIGN §4.9, relative to the root of the object's source. */
async function rootResolver(q: Queryable, modelId: string): Promise<(path: string) => string> {
  const { rows } = await q.execute<{ root_path: string | null }>(sql`
    SELECT root_path FROM sources
     WHERE model_id = ${modelId}::uuid AND kind = 'yandex_disk' ORDER BY created_at LIMIT 1`)
  const root = rows[0]?.root_path ?? 'disk:/'
  return (path: string) => displayRoot(sourcePath(path, root).relative)
}

// ── Progress ──────────────────────────────────────────────────────────────────────────

async function progressOf(
  q: Queryable,
  modelId: string,
  disputes: readonly Dispute[],
): Promise<LegacyProgress> {
  const snapshot = await snapshotOf(q, modelId, null)
  const empty: LegacyProgress = {
    processed_folders: 0,
    total_folders: 0,
    old_names: 0,
    unresolved: disputes.filter((d) => !d.resolved && !d.postponed).length,
    roots: [],
    stalled: null,
  }
  if (!snapshot) return empty
  // Files of the snapshot's source: done when a decision closed their draft.
  const { rows } = await q.execute<{
    path: string
    member: boolean
    done: boolean
    accepted: boolean
    claims: boolean
  }>(sql`
    SELECT o.current_path AS path, o.archive_revision_id IS NOT NULL AS member,
           EXISTS (SELECT 1 FROM source_revisions r
                     JOIN inbox_drafts d ON d.model_id = r.model_id AND d.source_revision_id = r.id
                    WHERE r.model_id = o.model_id AND r.source_object_id = o.id
                      AND d.state = 'resolved') AS done,
           EXISTS (SELECT 1 FROM source_revisions r
                     JOIN inbox_drafts d ON d.model_id = r.model_id AND d.source_revision_id = r.id
                    WHERE r.model_id = o.model_id AND r.source_object_id = o.id
                      AND d.outcome IN ('new_item', 'append', 'alias')) AS accepted,
           EXISTS (SELECT 1 FROM legacy_claims c
                    WHERE c.model_id = o.model_id AND c.source_object_id = o.id
                      AND c.resolution = 'pending') AS claims
      FROM source_objects o
     WHERE o.model_id = ${modelId}::uuid AND o.source_id = ${snapshot.sourceId}::uuid
       AND NOT o.is_dir AND o.gone_since IS NULL`)
  const { rows: names } = await q.execute<{ n: number }>(sql`
    SELECT count(DISTINCT c.source_object_id)::int AS n FROM legacy_claims c
     WHERE c.model_id = ${modelId}::uuid AND c.resolution = 'pending'`)
  const folders = new Map<string, boolean>()
  const roots = new Map<string, LegacyRoot>(
    ROOTS.map((root) => [root, { root, accepted: 0, old_names: 0, disputed: 0, waiting: 0 }]),
  )
  for (const row of rows) {
    const relative = sourcePath(row.path, snapshot.rootPath).relative
    const folder = relative.split('/').slice(0, -1).join('/')
    folders.set(folder, (folders.get(folder) ?? true) && row.done)
    const root = roots.get(displayRoot(relative, row.member)) as LegacyRoot
    if (row.accepted) root.accepted = (root.accepted ?? 0) + 1
    else if (!row.done) root.waiting = (root.waiting ?? 0) + 1
    if (row.claims) root.old_names = (root.old_names ?? 0) + 1
  }
  for (const dispute of disputes) {
    if (dispute.resolved || dispute.postponed) continue
    const root = roots.get(dispute.root)
    if (root) root.disputed += 1
  }
  return {
    ...empty,
    processed_folders: [...folders.values()].filter(Boolean).length,
    total_folders: folders.size,
    old_names: names[0]?.n ?? 0,
    roots: [...roots.values()].filter(
      (root) => (root.accepted ?? 0) + (root.waiting ?? 0) + root.disputed > 0,
    ),
  }
}

/** `GET /api/v1/{model}/legacy`. */
export async function legacyReview(
  q: Queryable,
  model: { id: string; code: string },
): Promise<LegacyReview> {
  const last = await lastImportWork(q, model.id, 'parse')
  const disputes = await legacyDisputes(q, model.id, last?.report ?? null)
  return {
    progress: await progressOf(q, model.id, disputes),
    labels: await labelMappings(q, model),
    disputes,
  }
}
