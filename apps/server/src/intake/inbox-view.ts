import type { ActorRef } from '@contentops/contracts/domain/common'
import type { FileRole } from '@contentops/contracts/domain/files'
import type {
  DraftFile,
  DraftHint,
  DraftState,
  InboxGroup,
  InboxList,
  OrderCandidate,
} from '@contentops/contracts/domain/inbox'
import type { ItemType } from '@contentops/contracts/domain/item-type'
import type { Queryable, values } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { instant, instantOrNull } from '../commands'
import { ApiProblem } from '../errors'
import { sourceThumbPath } from './source-thumbs'

/**
 * «Приехало» from the database (DESIGN §4.8, §5.3): a group is the unit of acceptance, its
 * drafts are the files. The state of a group is computed from its drafts: ◆ a decision, ▲ an
 * error, «готовится» with its stage, «готово», or what it became.
 */

export const DB_TYPE_TO_ITEM: Record<values.ContentType, ItemType> = {
  PPV: 'ppv',
  SET: 'set',
  SXT: 'sexting',
  CUS: 'custom',
  FYP: 'fyp',
  LIFE: 'life',
  RAW: 'raw',
  PRM: 'promo',
}
export const ITEM_TO_DB_TYPE = Object.fromEntries(
  Object.entries(DB_TYPE_TO_ITEM).map(([db, item]) => [item, db]),
) as Record<ItemType, values.ContentType>

const REJECT_KEEP_DAYS = 30

type InboxFilter = 'active' | 'accepted' | 'rejected'

interface GroupRow extends Record<string, unknown> {
  id: string
  group_key: string
  grouping: values.Grouping
  evidence: { root?: string | null; path?: string; day?: string } | null
  proposed_type: values.ContentType | null
  proposed_title: string | null
  proposed_description: string | null
  proposed_tags: string[] | null
  proposed_ppv_kind: values.PpvKind | null
  proposed_purpose: values.RawPurpose | null
  has_second_person: boolean | null
  custom_order_id: string | null
  row_version: string
  discovered_at: string
  source_kind: values.SourceKind
  source_label: string
}

interface DraftRow extends Record<string, unknown> {
  id: string
  group_id: string
  state: values.DraftState
  outcome: values.DraftOutcome | null
  origin: values.DraftOrigin
  path: string | null
  byte_size: string | null
  discovered_at: string
  arrived_at: string | null
  decided_at: string | null
  decided_by: string | null
  decided_name: string | null
  decided_kind: 'human' | 'agent' | null
  decided_gender: 'f' | 'm' | null
  reject_reason: string | null
  rejected_at: string | null
  blocked_reason: values.DraftBlockedReason | null
  error: string | null
  proposed_role: values.AssetRole | null
  proposed_ordinal: number | null
  source_blob: boolean
  has_master: boolean
  master_verified: boolean
  media_kind: values.MediaKind | null
  target_public_id: string | null
  applied_public_id: string | null
  uploader_id: string | null
  uploader_name: string | null
  uploader_kind: 'human' | 'agent' | null
  uploader_gender: 'f' | 'm' | null
  fetch_done: string | null
  fetch_total: string | null
  thumb_generation: string | null
  duplicate_handle: string | null
  shot_at: string | null
}

const SYSTEM: ActorRef = { type: 'system', id: null, name: 'Система', gender: null }

function actorOf(
  id: string | null,
  name: string | null,
  kind: string | null,
  gender: 'f' | 'm' | null,
): ActorRef {
  if (!id || !name) return SYSTEM
  return { type: kind === 'agent' ? 'agent' : 'person', id, name, gender }
}

function baseName(path: string | null): string {
  if (!path) return ''
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
}

function parentOf(path: string | null): string {
  if (!path) return ''
  const cut = path.lastIndexOf('/')
  return cut > 0 ? path.slice(0, cut) : path
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']

function dayWords(iso: string): string {
  const [, month, day] = iso.slice(0, 10).split('-').map(Number)
  return `${day} ${MONTHS[(month ?? 1) - 1]}`
}

/** «3 фото», «2 видео», «3 фото · 1 видео». */
function contentWords(drafts: readonly DraftRow[]): string {
  const videos = drafts.filter((draft) => draft.media_kind === 'video').length
  const photos = drafts.length - videos
  return [photos > 0 ? `${photos} фото` : null, videos > 0 ? `${videos} видео` : null]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

function groupTitle(group: GroupRow, drafts: readonly DraftRow[]): string {
  if (group.proposed_title) return group.proposed_title
  // A web upload is «Загружено вами · 3 фото» (DESIGN §5.3): who uploaded is said beside it.
  if (group.source_kind === 'web_upload') return `Загружено вами · ${contentWords(drafts)}`
  const root = group.evidence?.root ?? group.source_label
  if (group.grouping === 'exif_day' && group.evidence?.day) {
    return `${root} · съёмка ${dayWords(group.evidence.day)}`
  }
  const first = drafts.map((draft) => draft.arrived_at ?? draft.discovered_at).sort()[0]
  return first ? `${root} · ${dayWords(instant(first))}` : root
}

const DECISION: Partial<Record<values.DraftBlockedReason, InboxGroup['state']>> = {
  ambiguous_order: { kind: 'decision', decision: 'which_order' },
  video_in_set: { kind: 'decision', decision: 'video_in_set' },
  needs_type: { kind: 'decision', decision: 'what_is_it' },
  id_collision: { kind: 'decision', decision: 'number_taken' },
  cross_model_dup: { kind: 'decision', decision: 'cross_model' },
}

/** The stage of a draft that is still being prepared (DESIGN §5.3). */
function stageOf(
  draft: DraftRow,
): 'discovered' | 'downloading' | 'preview' | 'compressing' | 'checking' {
  if (draft.state === 'discovered') return draft.fetch_total ? 'downloading' : 'discovered'
  if (!draft.source_blob) return 'downloading'
  if (!draft.has_master) return 'compressing'
  return 'checking'
}

const PREPARING_BLOCK = {
  discovered: 'Ещё качается',
  downloading: 'Ещё качается',
  preview: 'Превью собирается',
  compressing: 'Мастер ещё собирается',
  checking: 'Проверяется',
} as const

/** State of the unresolved drafts of a group, and the line under a disabled «Принять». */
export function activeState(
  group: GroupRow,
  drafts: readonly DraftRow[],
): { state: DraftState; block: string | null } {
  const failed = drafts.find(
    (draft) =>
      draft.error !== null ||
      draft.blocked_reason === 'master_failed' ||
      draft.blocked_reason === 'source_unavailable',
  )
  if (failed) {
    const vanished = failed.blocked_reason === 'source_unavailable'
    return {
      state: {
        kind: 'error',
        error: vanished ? 'vanished' : 'master_failed',
        detail: vanished ? 'Файла больше нет в источнике' : (failed.error ?? 'Мастер не собрался'),
      },
      block: vanished ? 'Файла нет в источнике' : 'Сначала разберитесь с ошибкой',
    }
  }
  for (const draft of drafts) {
    const decision = draft.blocked_reason ? DECISION[draft.blocked_reason] : undefined
    if (decision) return { state: decision, block: 'Сначала примите решение' }
  }
  const preparing = drafts.filter(
    (draft) => draft.state === 'discovered' || draft.state === 'processing',
  )
  if (preparing.length > 0) {
    const stages = preparing.map(stageOf)
    const order = ['discovered', 'downloading', 'preview', 'compressing', 'checking'] as const
    const stage = order.find((candidate) => stages.includes(candidate)) ?? 'discovered'
    const total = drafts.reduce((sum, draft) => sum + Number(draft.byte_size ?? 0), 0)
    const done = drafts.reduce(
      (sum, draft) =>
        sum + (draft.source_blob ? Number(draft.byte_size ?? 0) : Number(draft.fetch_done ?? 0)),
      0,
    )
    const progress = total > 0 ? Math.min(0.99, done / total) : null
    return {
      state: { kind: 'preparing', stage, progress, done_bytes: done, total_bytes: total },
      block: PREPARING_BLOCK[stage],
    }
  }
  if (!group.proposed_type) {
    return { state: { kind: 'decision', decision: 'what_is_it' }, block: 'Сначала выберите тип' }
  }
  const target = drafts.find((draft) => draft.target_public_id)?.target_public_id
  return {
    state: {
      kind: 'ready',
      note: target
        ? { kind: 'extends', item_id: target }
        : group.custom_order_id
          ? { kind: 'order_part', order_id: group.custom_order_id, part: orderPart(drafts) }
          : { kind: 'new' },
    },
    block: null,
  }
}

const HOW: Record<'new_item' | 'append' | 'alias', 'new' | 'extend' | 'duplicate'> = {
  new_item: 'new',
  append: 'extend',
  alias: 'duplicate',
}

function resolvedState(
  drafts: readonly DraftRow[],
  filter: 'accepted' | 'rejected',
  now: Date,
): DraftState | null {
  const latest = [...drafts].sort((a, b) =>
    (b.decided_at ?? '').localeCompare(a.decided_at ?? ''),
  )[0]
  if (!latest?.decided_at) return null
  const by = actorOf(
    latest.decided_by,
    latest.decided_name,
    latest.decided_kind,
    latest.decided_gender,
  )
  if (filter === 'rejected') {
    const at = latest.rejected_at ?? latest.decided_at
    const days = Math.floor((now.getTime() - new Date(instant(at)).getTime()) / 86_400_000)
    return {
      kind: 'rejected',
      reason: latest.reject_reason,
      by,
      at: instant(at),
      days_left: Math.max(0, REJECT_KEEP_DAYS - days),
    }
  }
  if (!latest.applied_public_id || !latest.outcome || latest.outcome === 'rejected') return null
  return {
    kind: 'accepted',
    item_id: latest.applied_public_id,
    how:
      latest.origin === 'web_upload' && latest.outcome !== 'alias' ? 'upload' : HOW[latest.outcome],
    ...(latest.duplicate_handle ? { file_key: latest.duplicate_handle } : {}),
    by,
    at: instant(latest.decided_at),
  }
}

const ROLE: Partial<Record<values.AssetRole, FileRole>> = {
  master: 'master',
  teaser: 'teaser',
  pic: 'photo',
  clip: 'clip',
  raw: 'raw',
  ed: 'photo',
}

const ROLE_LABEL: Record<FileRole, string> = {
  master: 'мастер',
  teaser: 'тизер',
  photo: 'фото',
  clip: 'клип',
  montage: 'монтаж',
  source: 'исходник',
  raw: 'сырьё',
  promo_link: 'промо',
}

function fileOf(model: string, draft: DraftRow, index: number): DraftFile {
  const video = draft.media_kind === 'video'
  const role: FileRole =
    (draft.proposed_role && ROLE[draft.proposed_role]) || (video ? 'master' : 'photo')
  const position =
    role === 'photo' || role === 'clip' || role === 'raw'
      ? (draft.proposed_ordinal ?? index + 1)
      : null
  return {
    key: draft.id,
    file_name: baseName(draft.path),
    role,
    role_label: position ? `${ROLE_LABEL[role]} ${position}` : ROLE_LABEL[role],
    media: video ? 'video' : 'photo',
    position,
    duration_s: null,
    size_bytes: Number(draft.byte_size ?? 0),
    thumb: {
      key: `draft:${draft.id}`,
      ratio: video ? '9:16' : '3:4',
      url: draft.thumb_generation
        ? `/api/v1/${model}/g/${draft.thumb_generation}/thumb-640.webp`
        : draft.origin === 'disk_scan'
          ? sourceThumbPath(model, draft.id)
          : null,
    },
    shot_at: instantOrNull(draft.shot_at),
  }
}

interface Extras {
  hints: DraftHint[]
  candidates: OrderCandidate[]
}

const NO_EXTRAS: Extras = { hints: [], candidates: [] }

function orderPart(drafts: readonly DraftRow[]): string {
  const video = drafts.some((draft) => draft.media_kind === 'video')
  const photo = drafts.some((draft) => draft.media_kind !== 'video')
  return video && photo ? 'видео и фото' : video ? 'видео' : 'фото'
}

function view(
  model: string,
  group: GroupRow,
  drafts: readonly DraftRow[],
  filter: InboxFilter,
  now: Date,
  extras: Extras = NO_EXTRAS,
): InboxGroup | null {
  if (drafts.length === 0) return null
  let state: DraftState | null
  let block: string | null = null
  if (filter === 'active') {
    const computed = activeState(group, drafts)
    state = computed.state
    block = computed.block
  } else {
    state = resolvedState(drafts, filter, now)
  }
  if (!state) return null
  const first = drafts[0] as DraftRow
  const arrived =
    drafts.map((draft) => draft.arrived_at ?? draft.discovered_at).sort()[0] ?? group.discovered_at
  const web = first.origin === 'web_upload'
  return {
    id: group.id,
    title: groupTitle(group, drafts),
    source_path: group.evidence?.path
      ? group.grouping === 'folder'
        ? group.evidence.path
        : parentOf(group.evidence.path)
      : parentOf(first.path),
    root: group.evidence?.root ?? group.source_label,
    uploaded_by: web
      ? actorOf(first.uploader_id, first.uploader_name, first.uploader_kind, first.uploader_gender)
      : null,
    arrived_at: instant(arrived),
    size_bytes: drafts.reduce((sum, draft) => sum + Number(draft.byte_size ?? 0), 0),
    file_count: drafts.length,
    state,
    accept_block: block,
    fields: {
      type: group.proposed_type ? DB_TYPE_TO_ITEM[group.proposed_type] : null,
      title: group.proposed_title ?? '',
      description: group.proposed_description ?? '',
      tags: group.proposed_tags ?? [],
      ppv_kind: group.proposed_ppv_kind,
      raw_purpose: group.proposed_purpose === 'mass_dm' ? 'mailing' : group.proposed_purpose,
      channel: null,
      collection: null,
      second_person: group.has_second_person ?? false,
      fan_name: null,
      order_id: group.custom_order_id,
      shot_on: null,
    },
    hints: extras.hints,
    files: drafts.map((draft, index) => fileOf(model, draft, index)),
    candidates: extras.candidates,
    archive_entries: null,
    target_item: drafts.find((draft) => draft.target_public_id)?.target_public_id ?? null,
    version: Number(group.row_version),
  }
}

async function loadGroups(
  q: Queryable,
  modelId: string,
  groupIds: string[] | null,
): Promise<GroupRow[]> {
  const { rows } = await q.execute<GroupRow>(sql`
    SELECT g.id, g.group_key, g.grouping, g.evidence, g.proposed_type, g.proposed_title,
           g.proposed_description, g.proposed_tags, g.proposed_ppv_kind, g.proposed_purpose,
           g.has_second_person, g.custom_order_id, g.row_version, g.discovered_at, s.kind AS source_kind,
           s.label AS source_label
      FROM inbox_groups g JOIN sources s ON s.model_id = g.model_id AND s.id = g.source_id
     WHERE g.model_id = ${modelId}::uuid
       AND (${groupIds === null} OR g.id = ANY (${sql.param(groupIds ?? [])}::uuid[]))`)
  return rows
}

async function loadDrafts(
  q: Queryable,
  modelId: string,
  groupIds: string[],
  filter: InboxFilter,
): Promise<DraftRow[]> {
  if (groupIds.length === 0) return []
  const which =
    filter === 'active'
      ? sql`d.state <> 'resolved'`
      : filter === 'accepted'
        ? sql`d.state = 'resolved' AND d.outcome <> 'rejected'`
        : sql`d.state = 'resolved' AND d.outcome = 'rejected'`
  const { rows } = await q.execute<DraftRow>(sql`
    SELECT d.id, d.group_id, d.state, d.outcome, d.origin, d.path, d.byte_size, d.discovered_at,
           r.remote_created_at AS arrived_at, d.decided_at, d.decided_by,
           pd.display_name AS decided_name, pd.kind AS decided_kind, pd.gender AS decided_gender,
           d.reject_reason, d.rejected_at, d.blocked_reason, d.error, d.proposed_role,
           d.proposed_ordinal, d.source_blob_sha256 IS NOT NULL AS source_blob,
           d.master_sha256 IS NOT NULL AS has_master, d.master_verified_at IS NOT NULL AS master_verified,
           coalesce(b.media_kind, CASE
             WHEN d.path ~* '\\.(mp4|mov|m4v|avi|mkv|webm|mts|m2ts|3gp|hevc)$' THEN 'video' ELSE 'image' END
           ) AS media_kind,
           (SELECT public_item_id(i.type, i.number) FROM content_items i
             WHERE i.model_id = d.model_id AND i.id = d.target_item_id) AS target_public_id,
           (SELECT public_item_id(i.type, i.number) FROM content_items i
             WHERE i.model_id = d.model_id AND i.id = d.applied_item_id) AS applied_public_id,
           u.principal_id AS uploader_id, pu.display_name AS uploader_name, pu.kind AS uploader_kind, pu.gender AS uploader_gender,
           fw.progress_num AS fetch_done, fw.progress_den AS fetch_total,
           NULL::timestamptz AS shot_at,
           (SELECT g.id FROM rendition_generations g
             WHERE g.input_sha256 = d.source_sha256 AND g.kind = 'thumb640' AND g.state = 'ready'
               AND NOT g.meta_stripped
             ORDER BY g.ready_at DESC LIMIT 1) AS thumb_generation,
           (SELECT public_item_id(i.type, i.number) || '/' || m.role || coalesce(lpad(m.ordinal::text, 2, '0'), '')
              FROM asset_versions v
              JOIN item_memberships m ON m.model_id = v.model_id AND m.asset_id = v.asset_id AND m.kind = 'owned'
              JOIN content_items i ON i.model_id = m.model_id AND i.id = m.item_id
             WHERE v.model_id = d.model_id AND v.id = d.duplicate_of_version_id LIMIT 1) AS duplicate_handle
      FROM inbox_drafts d
      LEFT JOIN source_revisions r ON r.model_id = d.model_id AND r.id = d.source_revision_id
      LEFT JOIN blobs b ON b.sha256 = d.source_blob_sha256
      LEFT JOIN principals pd ON pd.id = d.decided_by
      LEFT JOIN web_uploads u ON u.model_id = d.model_id AND u.id = d.web_upload_id
      LEFT JOIN principals pu ON pu.id = u.principal_id
      LEFT JOIN LATERAL (
        SELECT w.progress_num, w.progress_den FROM work_operations w
         WHERE w.model_id = d.model_id AND w.kind = 'fetch' AND w.source_revision_id = d.source_revision_id
           AND w.state IN ('pending', 'running', 'retry_wait')
         ORDER BY w.created_at DESC LIMIT 1
      ) fw ON true
     WHERE d.model_id = ${modelId}::uuid
       AND d.group_id = ANY (${sql.param(groupIds)}::uuid[]) AND ${which}
     ORDER BY d.group_id, d.proposed_ordinal NULLS LAST, d.path, d.id`)
  return rows
}

/**
 * Candidates of the drafts (schema §3.4 `inbox_draft_candidates`): ◆ «Какой заказ?» without a
 * preselection, and the pHash hint «Похоже на фото № 7 из SET-069 — сравнить» (SPEC §6.2).
 */
async function loadExtras(q: Queryable, modelId: string, drafts: readonly DraftRow[]) {
  const extras = new Map<string, Extras>()
  if (drafts.length === 0) return extras
  const groupOf = new Map(drafts.map((draft) => [draft.id, draft.group_id]))
  const { rows } = await q.execute<{
    draft_id: string
    kind: 'order' | 'similar_photo'
    order_id: string | null
    item_public: string | null
    handle: string | null
    ordinal: number | null
    buyer: string | null
    brief: string | null
    due: string | null
    signals: Record<string, unknown> | null
  }>(sql`
    SELECT c.draft_id, c.kind, c.order_id, public_item_id(i.type, i.number) AS item_public,
           m.role || coalesce(lpad(m.ordinal::text, 2, '0'), '') AS handle, m.ordinal,
           o.buyer_name AS buyer, o.brief, (o.due_at AT TIME ZONE 'Europe/Moscow')::date::text AS due,
           c.signals
      FROM inbox_draft_candidates c
      LEFT JOIN content_items i ON i.model_id = c.model_id AND i.id = c.item_id
      LEFT JOIN asset_versions v ON v.model_id = c.model_id AND v.id = c.version_id
      LEFT JOIN item_memberships m ON m.model_id = v.model_id AND m.asset_id = v.asset_id
                                  AND m.kind = 'owned'
      LEFT JOIN custom_orders o ON o.model_id = c.model_id AND o.id = c.order_id
     WHERE c.model_id = ${modelId}::uuid AND c.dismissed_at IS NULL
       AND c.kind IN ('order', 'similar_photo')
       AND c.draft_id = ANY (${sql.param(drafts.map((draft) => draft.id))}::uuid[])
     ORDER BY c.score DESC NULLS LAST, c.created_at`)
  for (const row of rows) {
    const group = groupOf.get(row.draft_id) as string
    const entry = extras.get(group) ?? { hints: [], candidates: [] }
    extras.set(group, entry)
    if (row.kind === 'similar_photo' && row.item_public) {
      const number = row.ordinal ? ` № ${row.ordinal}` : ''
      entry.hints.push({
        kind: 'similar',
        text: `Похоже на фото${number} из ${row.item_public} — сравнить`,
        item_id: row.item_public,
        file_key: row.handle ?? row.item_public,
      })
    } else if (
      row.kind === 'order' &&
      row.order_id &&
      !entry.candidates.some((candidate) => candidate.order_id === row.order_id)
    ) {
      entry.candidates.push({
        order_id: row.order_id,
        title: row.buyer ?? 'Заказ',
        deadline: row.due,
        excerpt: (row.brief ?? '').slice(0, 140),
        matched: Object.keys(row.signals ?? {}),
      })
    }
  }
  return extras
}

const SECTION = { decision: 0, error: 0, ready: 1, preparing: 2 } as const

/** `GET /{model}/inbox`: groups of «Новое» or «Решённое». */
export async function inboxList(
  q: Queryable,
  model: { id: string; code: string },
  filter: InboxFilter,
): Promise<InboxList> {
  const modelId = model.id
  const now = new Date()
  const groups = await loadGroups(q, modelId, null)
  const drafts = await loadDrafts(
    q,
    modelId,
    groups.map((group) => group.id),
    filter,
  )
  const extras = await loadExtras(q, modelId, drafts)
  const byGroup = new Map<string, DraftRow[]>()
  for (const draft of drafts)
    byGroup.set(draft.group_id, [...(byGroup.get(draft.group_id) ?? []), draft])
  const items = groups
    .map((group) =>
      view(model.code, group, byGroup.get(group.id) ?? [], filter, now, extras.get(group.id)),
    )
    .filter((item): item is InboxGroup => item !== null)
    .sort((left, right) => {
      const rank = (item: InboxGroup) => SECTION[item.state.kind as keyof typeof SECTION] ?? 3
      if (filter === 'active' && rank(left) !== rank(right)) return rank(left) - rank(right)
      const leftAt =
        left.state.kind === 'accepted' || left.state.kind === 'rejected'
          ? left.state.at
          : left.arrived_at
      const rightAt =
        right.state.kind === 'accepted' || right.state.kind === 'rejected'
          ? right.state.at
          : right.arrived_at
      return rightAt.localeCompare(leftAt)
    })
  const count =
    filter === 'active'
      ? items.filter((item) => ['decision', 'error', 'ready'].includes(item.state.kind)).length
      : (await inboxList(q, model, 'active')).count
  const { rows } = await q.execute<{ at: string | null; disputes: number }>(sql`
    SELECT (SELECT max(w.finished_at) FROM work_operations w
             WHERE w.model_id = ${modelId}::uuid AND w.kind = 'scan' AND w.state = 'succeeded') AS at,
           (SELECT count(*)::int FROM review_cases c
             WHERE c.model_id = ${modelId}::uuid AND c.state = 'open'
               AND c.kind IN ('legacy_unparsed', 'unreadable_input', 'cross_model_duplicate')) AS disputes`)
  return {
    items,
    next_cursor: null,
    count,
    disk_checked_at: instantOrNull(rows[0]?.at),
    legacy_disputes: rows[0]?.disputes ?? 0,
  }
}

/** `GET /{model}/inbox/groups/{group}`: the group with what is still open, else its decision. */
export async function inboxGroup(
  q: Queryable,
  model: { id: string; code: string },
  groupId: string,
): Promise<InboxGroup> {
  const modelId = model.id
  const [group] = await loadGroups(q, modelId, [groupId])
  if (!group) throw new ApiProblem('not_found', 'Такой группы нет')
  const now = new Date()
  for (const filter of ['active', 'accepted', 'rejected'] as const) {
    const drafts = await loadDrafts(q, modelId, [groupId], filter)
    const extras = await loadExtras(q, modelId, drafts)
    const shown = view(model.code, group, drafts, filter, now, extras.get(groupId))
    if (shown) return shown
  }
  throw new ApiProblem('not_found', 'Такой группы нет')
}
