import type { ActorRef } from '@contentops/contracts/domain/common'
import type { FileRole, MasterFrame } from '@contentops/contracts/domain/files'
import {
  type DraftFile,
  type DraftHint,
  type DraftState,
  type InboxGroup,
  type InboxList,
  inboxSectionOf,
  type OrderCandidate,
} from '@contentops/contracts/domain/inbox'
import type { ItemType } from '@contentops/contracts/domain/item-type'
import { DEFAULT_PAGE_LIMIT } from '@contentops/contracts/domain/pagination'
import { formatDayMonth } from '@contentops/contracts/format'
import { orderTitleOf } from '@contentops/contracts/order-card'
import type { Queryable, values } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { renditionUrl, thumbRatio } from '../catalog/entries'
import { handleSql } from '../catalog/ids'
import { instant, instantOrNull } from '../commands'
import { ApiProblem } from '../errors'
import { openDisputeCount } from '../legacy/review'
import { mediaPreviews } from '../media/previews'
import { frameChoices } from './frames'
import { exportRoleOf } from './grouping'
import { appendRefusal, newObjectRefusal, type Refusal } from './refusal'
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
  evidence: {
    root?: string | null
    path?: string
    day?: string
    plan_row_id?: string
    was?: string
    now?: string
    legacy?: unknown
    /** The question of the import on a folder without a number (`legacy/doubt.ts`). */
    doubt?: { kind: string; text: string }
  } | null
  proposed_type: values.ContentType | null
  proposed_title: string | null
  proposed_title_en: string | null
  proposed_description: string | null
  proposed_tags: string[] | null
  proposed_ppv_kind: values.PpvKind | null
  proposed_purpose: values.RawPurpose | null
  has_second_person: boolean | null
  custom_order_id: string | null
  /** The hub's order (`K-12`) the custom is delivered for (package N), instead of a history one. */
  hub_order_code: string | null
  /** «Канал ▾» of a promo pack: the code of the channel; «Подборка ▾»: the collection. */
  channel_code: string | null
  collection_public_id: string | null
  /** The object this group already made (`CUS-197`): a new file of it joins that object. */
  created_public_id: string | null
  /** «Похоже на исправление CUS-195»: the custom of the order and its open revision. */
  fix_item_public: string | null
  fix_revision_id: string | null
  /** The order of the group was chosen by the rule, not by a person (SPEC §8.2). */
  order_proposed: boolean
  row_version: string
  discovered_at: string
  source_kind: values.SourceKind
  source_label: string
}

/**
 * What the state of a group needs from each of its drafts: a light row, read for every group the
 * list considers. What a tile of a file needs (`FileRow`) is read only for the groups shown.
 */
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
  source_blob: boolean
  has_master: boolean
  master_verified: boolean
  media_kind: values.MediaKind | null
  target_public_id: string | null
  applied_public_id: string | null
  fetch_done: string | null
  fetch_total: string | null
  /** The source's answer when the last fetch gave up (attempts spent); null otherwise. */
  fetch_failed: string | null
  duplicate_handle: string | null
  target_item_id: string | null
  /** Only of a draft waiting for ◆ «К какому кадру?»: its bytes find similar frames. */
  source_hex: string | null
  /** «Похоже на ролик» nobody answered yet (SPEC §6.2). */
  video_copy: boolean
}

/** A file of a group as its tile shows it. */
interface FileRow extends Record<string, unknown> {
  id: string
  group_id: string
  state: values.DraftState
  origin: values.DraftOrigin
  /** The source bytes: the viewer plays the previews built from them. */
  source_hex: string | null
  path: string | null
  byte_size: string | null
  media_kind: values.MediaKind | null
  proposed_role: values.AssetRole | null
  proposed_ordinal: number | null
  /** Place of the file in its group (1…), by the order of the files. */
  position: string
  thumb_generation: string | null
  shot_at: string | null
  uploader_id: string | null
  uploader_name: string | null
  uploader_kind: 'human' | 'agent' | null
  uploader_gender: 'f' | 'm' | null
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

/**
 * What matched, in the order a person reads it: who it is (the model's line, the buyer), the
 * words of the brief, the length, the days after the card. Stored as keys of a JSON object,
 * which keeps no order.
 */
function matchedWords(signals: Record<string, unknown> | null): string[] {
  const rank = (signal: string) =>
    signal.startsWith('строка модели')
      ? 0
      : signal.startsWith('покупатель')
        ? 1
        : signal.startsWith('в ТЗ')
          ? 2
          : signal.includes('при заказанных')
            ? 3
            : 4
  return Object.keys(signals ?? {})
    .filter((key) => !key.startsWith('revision'))
    .sort((left, right) => rank(left) - rank(right))
}

/** `2026-10-28` → «28 окт.», как в хабе. */
function shortDay(iso: string): string {
  return formatDayMonth(iso.slice(0, 10))
}

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
  which_frame: { kind: 'decision', decision: 'which_frame' },
  row_changed: { kind: 'decision', decision: 'substitute_montage' },
  archive_split: { kind: 'decision', decision: 'split_archive' },
  video_copy: { kind: 'decision', decision: 'video_copy' },
}

const VIDEO_COPY_BLOCK = 'Сначала ответьте: копия или отдельный объект'

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

/** Verdicts of a broken source that may be taken as it is (schema §9.2 «Принятие»). */
const BROKEN_SOURCE: Record<string, string> = {
  source_decode_errors: 'ошибки декодирования',
  source_truncated: 'файл обрезан',
}

/** Other master verdicts in words; `unreadable` waits for a replacement in the draft. */
const MASTER_FAILURE: Record<string, string> = {
  unreadable: 'файл не читается — ждёт замены',
}

const TYPE_OF_ID = /^([A-Z]+)-/

/**
 * What «Принять» would refuse by the files of a group (`refusal.ts`), told before the click: the
 * files are known from discovery, so this does not wait for the master.
 */
function refusalOf(group: GroupRow, drafts: readonly DraftRow[]): Refusal | null {
  const videos = drafts.filter((draft) => draft.media_kind === 'video').length
  const photos = drafts.length - videos
  const target =
    drafts.find((draft) => draft.target_public_id)?.target_public_id ?? group.created_public_id
  if (target) {
    const type = TYPE_OF_ID.exec(target)?.[1] as values.ContentType | undefined
    return type ? appendRefusal(type, videos) : null
  }
  return group.proposed_type ? newObjectRefusal(group.proposed_type, videos, photos) : null
}

/** State of the unresolved drafts of a group, and the line under a disabled «Принять». */
export function activeState(
  group: GroupRow,
  drafts: readonly DraftRow[],
): { state: DraftState; block: string | null } {
  const failed = drafts.find(
    (draft) =>
      draft.error !== null ||
      draft.fetch_failed !== null ||
      draft.blocked_reason === 'master_failed' ||
      draft.blocked_reason === 'source_unavailable',
  )
  if (failed) {
    const vanished = failed.blocked_reason === 'source_unavailable'
    if (vanished) {
      return {
        state: { kind: 'error', error: 'vanished', detail: 'Файла больше нет в источнике' },
        block: 'Файла нет в источнике',
      }
    }
    // The source kept failing and the fetch gave up: ▲ with its answer, «Повторить» fetches again.
    if (failed.fetch_failed !== null) {
      return {
        state: {
          kind: 'error',
          error: 'fetch_failed',
          detail: `источник ответил: ${failed.fetch_failed.replace(/\s+/g, ' ').trim()}`,
        },
        block: 'Файл не скачался',
      }
    }
    // A broken source kept its bytes as the would-be master: «Принять как есть» (SPEC §9.2).
    const verdict = /^master: (\w+)/.exec(failed.error ?? '')?.[1] ?? null
    const broken = failed.has_master && verdict !== null && verdict in BROKEN_SOURCE
    return {
      state: {
        kind: 'error',
        error: broken ? 'source_broken' : 'master_failed',
        detail:
          (verdict && (BROKEN_SOURCE[verdict] ?? MASTER_FAILURE[verdict])) ??
          failed.error ??
          'Мастер не собрался',
      },
      block: broken ? 'Примите как есть или отклоните' : 'Сначала разберитесь с ошибкой',
    }
  }
  // The import of the old corpus finds a refusal by itself and marks the group (`auto-accept`);
  // its words come from the rule, so three videos of a PPV are not «Видео среди фото».
  const marked = drafts.some((draft) => draft.blocked_reason === 'video_in_set')
  const refused = !group.evidence?.legacy || marked ? refusalOf(group, drafts) : null
  for (const draft of drafts) {
    if (draft.blocked_reason === 'video_in_set' && refused) continue
    const decision = draft.blocked_reason ? DECISION[draft.blocked_reason] : undefined
    // The import's question on the folder is the line: «Только фото — это сет?».
    const asked = draft.blocked_reason === 'needs_type' ? group.evidence?.doubt?.text : undefined
    if (decision) {
      const block = decision.kind === 'decision' && decision.decision === 'video_copy'
      return {
        state: decision,
        block: asked ?? (block ? VIDEO_COPY_BLOCK : 'Сначала примите решение'),
      }
    }
  }
  // «Похоже на ролик» another question hid when the print was compared: asked now (SPEC §6.2).
  if (drafts.some((draft) => draft.video_copy)) {
    return { state: { kind: 'decision', decision: 'video_copy' }, block: VIDEO_COPY_BLOCK }
  }
  if (refused) {
    return { state: { kind: 'decision', decision: refused.decision }, block: refused.message }
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
  // A promo pack is a collection of a channel (DESIGN §4.8): «готово · Промо: Instagram».
  if (group.proposed_type === 'PRM' && !group.evidence?.legacy && !group.created_public_id) {
    return group.channel_code
      ? {
          state: { kind: 'ready', note: { kind: 'promo', channel: group.channel_code } },
          block: null,
        }
      : { state: { kind: 'ready', note: { kind: 'new' } }, block: 'Сначала выберите канал' }
  }
  const target = drafts.find((draft) => draft.target_public_id)?.target_public_id
  return {
    state: {
      kind: 'ready',
      note: target
        ? { kind: 'extends', item_id: target }
        : group.fix_item_public && group.fix_revision_id && group.custom_order_id
          ? { kind: 'fix_of', item_id: group.fix_item_public, revision_id: group.fix_revision_id }
          : (group.hub_order_code ?? group.custom_order_id)
            ? {
                kind: 'order_part',
                order_id: (group.hub_order_code ?? group.custom_order_id) as string,
                part: orderPart(drafts),
                ...(group.order_proposed ? { proposed: true } : {}),
              }
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

function fileOf(model: string, draft: FileRow): DraftFile {
  const video = draft.media_kind === 'video'
  // The role a person chose, else the one the export name says (`…_teaser__0m14s.mp4`).
  const named = exportRoleOf(baseName(draft.path))
  const role: FileRole =
    (draft.proposed_role && ROLE[draft.proposed_role]) ||
    (named && ROLE[named.role]) ||
    (video ? 'master' : 'photo')
  const position =
    role === 'photo' || role === 'clip' || role === 'raw'
      ? (draft.proposed_ordinal ?? named?.ordinal ?? Number(draft.position))
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
  frames?: InboxGroup['frame_choices']
}

const NO_EXTRAS: Extras = { hints: [], candidates: [] }

function orderPart(drafts: readonly DraftRow[]): string {
  const video = drafts.some((draft) => draft.media_kind === 'video')
  const photo = drafts.some((draft) => draft.media_kind !== 'video')
  return video && photo ? 'видео и фото' : video ? 'видео' : 'фото'
}

/** What the state of a group is, and the line under a disabled «Принять»; null — not shown. */
interface Computed {
  group: GroupRow
  drafts: DraftRow[]
  state: DraftState
  block: string | null
}

function compute(
  group: GroupRow,
  drafts: DraftRow[],
  filter: InboxFilter,
  now: Date,
): Computed | null {
  if (drafts.length === 0) return null
  if (filter === 'active') {
    const { state, block } = activeState(group, drafts)
    return { group, drafts, state, block }
  }
  const state = resolvedState(drafts, filter, now)
  return state ? { group, drafts, state, block: null } : null
}

function view(
  model: string,
  { group, drafts, state, block }: Computed,
  files: readonly FileRow[],
  extras: Extras = NO_EXTRAS,
): InboxGroup {
  const first = drafts[0] as DraftRow
  const arrived =
    drafts.map((draft) => draft.arrived_at ?? draft.discovered_at).sort()[0] ?? group.discovered_at
  const uploader = first.origin === 'web_upload' ? files[0] : undefined
  return {
    id: group.id,
    title: groupTitle(group, drafts),
    source_path: group.evidence?.path
      ? group.grouping === 'folder'
        ? group.evidence.path
        : parentOf(group.evidence.path)
      : parentOf(first.path),
    root: group.evidence?.root ?? group.source_label,
    uploaded_by: uploader
      ? actorOf(
          uploader.uploader_id,
          uploader.uploader_name,
          uploader.uploader_kind,
          uploader.uploader_gender,
        )
      : null,
    arrived_at: instant(arrived),
    size_bytes: drafts.reduce((sum, draft) => sum + Number(draft.byte_size ?? 0), 0),
    file_count: drafts.length,
    video_count: drafts.filter((draft) => draft.media_kind === 'video').length,
    state,
    accept_block: block,
    fields: {
      type: group.proposed_type ? DB_TYPE_TO_ITEM[group.proposed_type] : null,
      title: group.proposed_title ?? '',
      title_en: group.proposed_title_en ?? '',
      description: group.proposed_description ?? '',
      tags: group.proposed_tags ?? [],
      ppv_kind: group.proposed_ppv_kind,
      raw_purpose: group.proposed_purpose === 'mass_dm' ? 'mailing' : group.proposed_purpose,
      channel: group.channel_code,
      collection: group.collection_public_id,
      second_person: group.has_second_person,
      fan_name: null,
      // A hub order by its code (`K-12`), a history one by its id.
      order_id: group.hub_order_code ?? group.custom_order_id,
      shot_on: null,
    },
    hints:
      state.kind === 'decision' && state.decision === 'substitute_montage' && group.evidence?.was
        ? [
            ...extras.hints,
            { kind: 'row_change', was: group.evidence.was, now: group.evidence.now ?? '' },
          ]
        : state.kind === 'decision' &&
            state.decision === 'what_is_it' &&
            group.evidence?.doubt &&
            drafts.some((draft) => draft.blocked_reason === 'needs_type')
          ? [{ kind: 'import_doubt', text: group.evidence.doubt.text }, ...extras.hints]
          : extras.hints,
    files: files.map((file) => fileOf(model, file)),
    candidates: extras.candidates,
    archive_entries: null,
    target_item: drafts.find((draft) => draft.target_public_id)?.target_public_id ?? null,
    frame_choices:
      state.kind === 'decision' && state.decision === 'which_frame'
        ? (extras.frames ?? null)
        : null,
    version: Number(group.row_version),
  }
}

const GROUP_COLUMNS = sql`
  g.id, g.group_key, g.grouping, g.evidence, g.proposed_type, g.proposed_title, g.proposed_title_en,
  g.proposed_description, g.proposed_tags, g.proposed_ppv_kind, g.proposed_purpose,
  g.has_second_person, g.custom_order_id, g.hub_order_code, g.row_version, g.discovered_at, s.kind AS source_kind,
  s.label AS source_label,
  (SELECT ch.code FROM promo_channels ch
    WHERE ch.model_id = g.model_id AND ch.id = g.proposed_channel_id) AS channel_code,
  (SELECT public_item_id(i.type, i.number) FROM content_items i
    WHERE i.model_id = g.model_id AND i.id = g.proposed_collection_id) AS collection_public_id,
  (SELECT public_item_id(i.type, i.number) FROM content_items i
    WHERE i.model_id = g.model_id AND i.created_from_group_id = g.id) AS created_public_id,
  (SELECT public_item_id(i.type, i.number) FROM inbox_draft_candidates c
     JOIN inbox_drafts x ON x.model_id = c.model_id AND x.id = c.draft_id
     JOIN content_items i ON i.model_id = c.model_id AND i.id = c.item_id
    WHERE c.model_id = g.model_id AND x.group_id = g.id AND x.state <> 'resolved'
      AND c.kind = 'existing_item' AND c.dismissed_at IS NULL AND c.signals ? 'revision_id'
    LIMIT 1) AS fix_item_public,
  (SELECT c.signals ->> 'revision_id' FROM inbox_draft_candidates c
     JOIN inbox_drafts x ON x.model_id = c.model_id AND x.id = c.draft_id
    WHERE c.model_id = g.model_id AND x.group_id = g.id AND x.state <> 'resolved'
      AND c.kind = 'existing_item' AND c.dismissed_at IS NULL AND c.signals ? 'revision_id'
    LIMIT 1) AS fix_revision_id,
  EXISTS (SELECT 1 FROM inbox_draft_candidates c
            JOIN inbox_drafts x ON x.model_id = c.model_id AND x.id = c.draft_id
           WHERE c.model_id = g.model_id AND x.group_id = g.id AND x.state <> 'resolved'
             AND c.kind = 'order' AND c.chosen AND c.chosen_by IS NULL
             AND c.order_id = g.custom_order_id) AS order_proposed`

async function loadGroups(q: Queryable, modelId: string, groupIds: string[]): Promise<GroupRow[]> {
  if (groupIds.length === 0) return []
  const { rows } = await q.execute<GroupRow>(sql`
    SELECT ${GROUP_COLUMNS}
      FROM inbox_groups g JOIN sources s ON s.model_id = g.model_id AND s.id = g.source_id
     WHERE g.model_id = ${modelId}::uuid AND g.id = ANY (${sql.param(groupIds)}::uuid[])`)
  return rows
}

/** Photo or video of a draft before its bytes are known: by the extension of its path. */
const MEDIA_KIND = sql`coalesce(b.media_kind, CASE
  WHEN d.path ~* '\.(mp4|mov|m4v|avi|mkv|webm|mts|m2ts|3gp|hevc)$' THEN 'video' ELSE 'image' END)`

/** The last fetch of a revision (index `work_operations_fetch_revision`, migration 0012). */
const LAST_FETCH = sql`
  LEFT JOIN LATERAL (
    SELECT w.state, w.progress_num, w.progress_den, w.error_text, w.error_code
      FROM work_operations w
     WHERE w.model_id = d.model_id AND w.kind = 'fetch'
       AND w.source_revision_id = d.source_revision_id
     ORDER BY w.created_at DESC LIMIT 1
  ) fw ON d.source_revision_id IS NOT NULL AND d.state <> 'resolved'`

const OPEN_DRAFT = sql`d.state IN ('discovered', 'processing', 'ready')`

function draftsOf(filter: InboxFilter) {
  return filter === 'active'
    ? OPEN_DRAFT
    : filter === 'accepted'
      ? sql`d.state = 'resolved' AND d.outcome <> 'rejected'`
      : sql`d.state = 'resolved' AND d.outcome = 'rejected'`
}

/** Light rows of the drafts of `groupIds`: what the state of each group needs. */
async function loadDrafts(
  q: Queryable,
  modelId: string,
  groupIds: string[],
  filter: InboxFilter,
): Promise<DraftRow[]> {
  if (groupIds.length === 0) return []
  const { rows } = await q.execute<DraftRow>(sql`
    SELECT d.id, d.group_id, d.state, d.outcome, d.origin, d.path, d.byte_size, d.discovered_at,
           r.remote_created_at AS arrived_at, d.decided_at, d.decided_by,
           pd.display_name AS decided_name, pd.kind AS decided_kind, pd.gender AS decided_gender,
           d.reject_reason, d.rejected_at, d.blocked_reason, d.error,
           d.source_blob_sha256 IS NOT NULL AS source_blob,
           d.master_sha256 IS NOT NULL AS has_master, d.master_verified_at IS NOT NULL AS master_verified,
           ${MEDIA_KIND} AS media_kind,
           public_item_id(ti.type, ti.number) AS target_public_id,
           public_item_id(ai.type, ai.number) AS applied_public_id,
           CASE WHEN fw.state IN ('pending', 'running', 'retry_wait') THEN fw.progress_num END AS fetch_done,
           CASE WHEN fw.state IN ('pending', 'running', 'retry_wait') THEN fw.progress_den END AS fetch_total,
           CASE WHEN d.source_sha256 IS NULL AND fw.state = 'failed'
                THEN coalesce(fw.error_text, fw.error_code, 'ошибка') END AS fetch_failed,
           dup.handle AS duplicate_handle, d.target_item_id,
           CASE WHEN d.blocked_reason = 'which_frame' THEN encode(d.source_sha256, 'hex') END AS source_hex,
           d.state <> 'resolved' AND EXISTS (
             SELECT 1 FROM inbox_draft_candidates vc
              WHERE vc.model_id = d.model_id AND vc.draft_id = d.id AND vc.kind = 'similar_video'
                AND vc.dismissed_at IS NULL AND NOT vc.chosen) AS video_copy
      FROM inbox_drafts d
      LEFT JOIN source_revisions r ON r.model_id = d.model_id AND r.id = d.source_revision_id
      LEFT JOIN blobs b ON b.sha256 = d.source_blob_sha256
      LEFT JOIN principals pd ON pd.id = d.decided_by
      LEFT JOIN content_items ti ON ti.model_id = d.model_id AND ti.id = d.target_item_id
      LEFT JOIN content_items ai ON ai.model_id = d.model_id AND ai.id = d.applied_item_id
      ${LAST_FETCH}
      LEFT JOIN LATERAL (
        SELECT ${handleSql('m')} AS handle
          FROM asset_versions v
          JOIN item_memberships m ON m.model_id = v.model_id AND m.asset_id = v.asset_id AND m.kind = 'owned'
         WHERE v.model_id = d.model_id AND v.id = d.duplicate_of_version_id LIMIT 1
      ) dup ON d.duplicate_of_version_id IS NOT NULL
     WHERE d.model_id = ${modelId}::uuid
       AND d.group_id = ANY (${sql.param(groupIds)}::uuid[]) AND ${draftsOf(filter)}
     ORDER BY d.group_id, d.proposed_ordinal NULLS LAST, d.path, d.id`)
  return rows
}

/**
 * The files of `groupIds` as their tiles show them. `perGroup` — only the first files of each
 * group for the list (videos first: the mosaic shows the master); `null` — every file.
 */
async function loadFiles(
  q: Queryable,
  modelId: string,
  groupIds: string[],
  filter: InboxFilter,
  perGroup: number | null,
): Promise<FileRow[]> {
  if (groupIds.length === 0) return []
  const { rows } = await q.execute<FileRow>(sql`
    WITH ranked AS (
      SELECT d.id,
             row_number() OVER (PARTITION BY d.group_id
                                ORDER BY d.proposed_ordinal NULLS LAST, d.path, d.id) AS position,
             row_number() OVER (PARTITION BY d.group_id
                                ORDER BY (${MEDIA_KIND}) = 'video' DESC, d.proposed_ordinal NULLS LAST,
                                         d.path, d.id) AS preview
        FROM inbox_drafts d LEFT JOIN blobs b ON b.sha256 = d.source_blob_sha256
       WHERE d.model_id = ${modelId}::uuid
         AND d.group_id = ANY (${sql.param(groupIds)}::uuid[]) AND ${draftsOf(filter)}
    )
    SELECT d.id, d.group_id, d.state, d.origin, encode(d.source_sha256, 'hex') AS source_hex,
           d.path, d.byte_size, ${MEDIA_KIND} AS media_kind,
           d.proposed_role, d.proposed_ordinal, ranked.position,
           (SELECT g.id FROM rendition_generations g
             WHERE g.input_sha256 = d.source_sha256 AND g.kind = 'thumb640' AND g.state = 'ready'
               AND NOT g.meta_stripped
             ORDER BY g.ready_at DESC LIMIT 1) AS thumb_generation,
           NULL::timestamptz AS shot_at,
           u.principal_id AS uploader_id, pu.display_name AS uploader_name,
           pu.kind AS uploader_kind, pu.gender AS uploader_gender
      FROM ranked
      JOIN inbox_drafts d ON d.model_id = ${modelId}::uuid AND d.id = ranked.id
      LEFT JOIN blobs b ON b.sha256 = d.source_blob_sha256
      LEFT JOIN web_uploads u ON u.model_id = d.model_id AND u.id = d.web_upload_id
      LEFT JOIN principals pu ON pu.id = u.principal_id
     WHERE ${perGroup === null ? sql`true` : sql`ranked.preview <= ${perGroup}`}
     ORDER BY d.group_id, ranked.position`)
  return rows
}

/**
 * Candidates of the open drafts of `groupIds` (schema §3.4 `inbox_draft_candidates`): ◆ «Какой
 * заказ?» without a preselection, the pHash hint «Похоже на фото № 7 из SET-069 — сравнить»
 * (SPEC §6.2), and the frames of ◆ «К какому кадру?».
 */
async function loadExtras(
  q: Queryable,
  model: { id: string; code: string },
  groupIds: readonly string[],
  drafts: readonly DraftRow[],
) {
  const modelId = model.id
  const extras = new Map<string, Extras>()
  if (groupIds.length === 0) return extras
  // ◆ «К какому кадру?»: the first unanswered file of a group and the frames of its set.
  for (const draft of drafts) {
    if (draft.blocked_reason !== 'which_frame' || !draft.target_item_id) continue
    const entry = extras.get(draft.group_id) ?? { hints: [], candidates: [] }
    extras.set(draft.group_id, entry)
    if (entry.frames) continue
    entry.frames = {
      file_key: draft.id,
      frames: await frameChoices(
        q,
        model,
        draft.target_item_id,
        draft.source_hex ? Buffer.from(draft.source_hex, 'hex') : null,
      ),
    }
  }
  const { rows } = await q.execute<{
    group_id: string
    draft_id: string
    kind: 'order' | 'similar_photo' | 'similar_video' | 'existing_item'
    score: number | null
    order_id: string | null
    item_public: string | null
    handle: string | null
    ordinal: number | null
    buyer: string | null
    brief: string | null
    due: string | null
    card_on: string | null
    signals: Record<string, unknown> | null
    by_rule: boolean
    revision: string | null
    revision_on: string | null
  }>(sql`
    SELECT d.group_id, d.id AS draft_id, c.kind, c.score, c.order_id,
           public_item_id(i.type, i.number) AS item_public, ${handleSql('m')} AS handle, m.ordinal,
           o.buyer_name AS buyer, o.brief, (o.due_at AT TIME ZONE 'Europe/Moscow')::date::text AS due,
           (o.card_at AT TIME ZONE 'Europe/Moscow')::date::text AS card_on,
           c.signals, c.chosen AND c.chosen_by IS NULL AS by_rule,
           rv.requirement AS revision,
           (rv.requested_at AT TIME ZONE 'Europe/Moscow')::date::text AS revision_on
      FROM inbox_draft_candidates c
      LEFT JOIN custom_order_revisions rv
        ON c.kind = 'existing_item' AND rv.model_id = c.model_id
       AND rv.id = (c.signals ->> 'revision_id')::uuid
      JOIN inbox_drafts d ON d.model_id = c.model_id AND d.id = c.draft_id
      LEFT JOIN content_items i ON i.model_id = c.model_id AND i.id = c.item_id
      LEFT JOIN asset_versions v ON v.model_id = c.model_id AND v.id = c.version_id
      LEFT JOIN item_memberships m ON m.model_id = v.model_id AND m.asset_id = v.asset_id
                                  AND m.kind = 'owned'
      LEFT JOIN custom_orders o ON o.model_id = c.model_id AND o.id = c.order_id
     WHERE c.model_id = ${modelId}::uuid AND c.dismissed_at IS NULL
       AND c.kind IN ('order', 'similar_photo', 'similar_video', 'existing_item')
       AND NOT (c.kind = 'similar_video' AND c.chosen)
       AND d.group_id = ANY (${sql.param([...groupIds])}::uuid[]) AND ${OPEN_DRAFT}
     ORDER BY c.score DESC NULLS LAST, c.created_at`)
  const said = new Set<string>()
  for (const row of rows) {
    const entry: Extras = extras.get(row.group_id) ?? { hints: [], candidates: [] }
    extras.set(row.group_id, entry)
    // What the rule saw (SPEC §8.2): the order it chose by itself and the fix it waits for.
    if (row.by_rule && !said.has(`${row.group_id}:${row.kind}`)) {
      said.add(`${row.group_id}:${row.kind}`)
      if (row.kind === 'order') {
        const title = orderTitleOf(row.brief ?? '') || row.buyer || 'Заказ'
        const matched = matchedWords(row.signals).join(' · ')
        entry.hints.push({
          kind: 'order_match',
          text: `Заказ «${title}»${row.card_on ? ` от ${shortDay(row.card_on)}` : ''}: ${matched}`,
        })
      } else if (row.kind === 'existing_item' && row.revision) {
        entry.hints.push({
          kind: 'order_match',
          text: `Правка${row.revision_on ? ` от ${shortDay(row.revision_on)}` : ''} к ${row.item_public}: «${row.revision}»`,
        })
      }
      continue
    }
    if (row.kind === 'similar_photo' && row.item_public) {
      const number = row.ordinal ? ` № ${row.ordinal}` : ''
      entry.hints.push({
        kind: 'similar',
        text: `Похоже на фото${number} из ${row.item_public} — сравнить`,
        item_id: row.item_public,
        file_key: row.handle ?? row.item_public,
      })
    } else if (row.kind === 'similar_video' && row.item_public) {
      // One hint per file: the closest video comes first (ORDER BY score).
      if (
        entry.hints.some((hint) => hint.kind === 'similar_video' && hint.draft_key === row.draft_id)
      )
        continue
      entry.hints.push(
        similarVideoHint(row.item_public, row.handle, row.draft_id, row.score, row.signals),
      )
    } else if (
      row.kind === 'order' &&
      row.order_id &&
      !entry.candidates.some((candidate) => candidate.order_id === row.order_id)
    ) {
      entry.candidates.push({
        order_id: row.order_id,
        title: orderTitleOf(row.brief ?? '') || row.buyer || 'Заказ',
        deadline: row.due,
        excerpt: (row.brief ?? '').slice(0, 140),
        matched: matchedWords(row.signals),
      })
    }
  }
  return extras
}

/** «Похоже на ролик FYP-0019/master» with what the prints said (SPEC §6.2). */
function similarVideoHint(
  item: string,
  handle: string | null,
  draftId: string,
  score: number | null,
  signals: Record<string, unknown> | null,
): Extract<DraftHint, { kind: 'similar_video' }> {
  const file = handle ?? 'master'
  const [mine, theirs] = Array.isArray(signals?.duration_ms) ? signals.duration_ms : []
  const seconds = (ms: unknown) => (typeof ms === 'number' ? Math.round(ms / 100) / 10 : 0)
  return {
    kind: 'similar_video',
    text: `Похоже на ролик ${item}/${file}`,
    item_id: item,
    file_key: file,
    draft_key: draftId,
    similarity: Math.max(0, Math.min(100, Math.round((score ?? 0) * 100))),
    frames_close: typeof signals?.frames_close === 'number' ? signals.frames_close : 0,
    frames: typeof signals?.frames === 'number' && signals.frames > 0 ? signals.frames : 10,
    duration_s: [seconds(mine), seconds(theirs)],
  }
}

/** Files of a group in the list: the mosaic of a tile and the stack of a row show three. */
export const LIST_FILES = 6
/** «Принятые» of the last 14 days, «Отклонённые» while their bytes wait (DESIGN §4.10). */
const ACCEPTED_DAYS = 14

/**
 * Groups «Новое» may show (DESIGN §4.8–4.9): with an open draft, not superseded; a group of the
 * old corpus only with something for a person — a decision, an error, no type. The import
 * accepts the rest itself, and those are most of the drafts at stage 7.
 */
async function activeCandidates(q: Queryable, modelId: string): Promise<GroupRow[]> {
  const { rows } = await q.execute<GroupRow>(sql`
    SELECT ${GROUP_COLUMNS}
      FROM inbox_groups g JOIN sources s ON s.model_id = g.model_id AND s.id = g.source_id
     WHERE g.model_id = ${modelId}::uuid
       AND g.id IN (SELECT d.group_id FROM inbox_drafts d
                     WHERE d.model_id = ${modelId}::uuid AND ${OPEN_DRAFT})
       AND (g.evidence ->> 'superseded') IS DISTINCT FROM 'true'
       AND (NOT coalesce(g.evidence ? 'legacy', false) OR g.proposed_type IS NULL
            OR EXISTS (
              SELECT 1 FROM inbox_drafts d ${LAST_FETCH}
               WHERE d.model_id = g.model_id AND d.group_id = g.id AND ${OPEN_DRAFT}
                 AND (d.blocked_reason IS NOT NULL OR d.error IS NOT NULL
                      OR (d.source_sha256 IS NULL AND fw.state = 'failed'))))`)
  return rows
}

/** Groups with drafts decided this way lately: accepted in 14 days, rejected in 30. */
async function decidedCandidates(
  q: Queryable,
  modelId: string,
  filter: 'accepted' | 'rejected',
): Promise<GroupRow[]> {
  const recent =
    filter === 'accepted'
      ? sql`d.decided_at >= now() - make_interval(days => ${ACCEPTED_DAYS})`
      : sql`coalesce(d.rejected_at, d.decided_at) >= now() - make_interval(days => ${REJECT_KEEP_DAYS})`
  const { rows } = await q.execute<GroupRow>(sql`
    SELECT ${GROUP_COLUMNS}
      FROM inbox_groups g JOIN sources s ON s.model_id = g.model_id AND s.id = g.source_id
     WHERE g.model_id = ${modelId}::uuid
       AND g.id IN (SELECT d.group_id FROM inbox_drafts d
                     WHERE d.model_id = ${modelId}::uuid AND ${draftsOf(filter)} AND ${recent})`)
  return rows
}

const SECTION = { decision: 0, error: 0, ready: 1, preparing: 2 } as const

function rankOf(state: DraftState): number {
  return SECTION[state.kind as keyof typeof SECTION] ?? 3
}

/** When a decided group was decided; when an open one arrived. */
function sortTime({ state, group, drafts }: Computed): string {
  if (state.kind === 'accepted' || state.kind === 'rejected') return state.at
  const arrived = drafts.map((draft) => draft.arrived_at ?? draft.discovered_at).sort()[0]
  return instant(arrived ?? group.discovered_at)
}

interface Position {
  rank: number
  at: string
  id: string
}

/** Opaque keyset cursor (SPEC §11.2): the place of the last group of the page. */
function cursorOf(position: Position): string {
  return Buffer.from(JSON.stringify([position.rank, position.at, position.id])).toString(
    'base64url',
  )
}

function positionOf(cursor: string | undefined): Position | null {
  if (!cursor) return null
  try {
    const [rank, at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [
      number,
      string,
      string,
    ]
    if (typeof rank !== 'number' || typeof at !== 'string' || typeof id !== 'string') {
      throw new Error('cursor')
    }
    return { rank, at, id }
  } catch {
    throw new ApiProblem('invalid_request', 'Такого курсора нет', { cursor })
  }
}

/** Sections first (◆ and ▲, «готово», «готовится»), inside — newest first, then by id. */
function compareGroups(left: Position, right: Position): number {
  if (left.rank !== right.rank) return left.rank - right.rank
  if (left.at !== right.at) return right.at.localeCompare(left.at)
  return right.id.localeCompare(left.id)
}

/** Groups of «Новое» with their state; the old corpus shows only what needs a person. */
async function activeGroups(q: Queryable, modelId: string, now: Date): Promise<Computed[]> {
  const groups = await activeCandidates(q, modelId)
  const drafts = await loadDrafts(
    q,
    modelId,
    groups.map((group) => group.id),
    'active',
  )
  const byGroup = Map.groupBy(drafts, (draft) => draft.group_id)
  return groups
    .map((group) => compute(group, byGroup.get(group.id) ?? [], 'active', now))
    .filter((item): item is Computed => item !== null)
    .filter(
      (item) =>
        !item.group.evidence?.legacy ||
        item.state.kind === 'decision' ||
        item.state.kind === 'error',
    )
}

const COUNTED: ReadonlySet<DraftState['kind']> = new Set(['decision', 'error', 'ready'])

/**
 * «Приехало · 9» (DESIGN §2.2, §4.8): groups where a person is needed — ◆, ▲ and «готово», the
 * same number as on the tab «Новое»; `attention` — a ◆ or ▲ among them (the dot on the avatar).
 */
export async function inboxCount(
  q: Queryable,
  modelId: string,
): Promise<{ count: number; attention: boolean }> {
  const groups = await activeGroups(q, modelId, new Date())
  return {
    count: groups.filter((item) => COUNTED.has(item.state.kind)).length,
    attention: groups.some((item) => item.state.kind === 'decision' || item.state.kind === 'error'),
  }
}

export interface InboxPage {
  cursor?: string | undefined
  limit?: number | undefined
}

/**
 * `GET /{model}/inbox`: groups of «Новое» or «Решённое», a page at a time (SPEC §11.2). The
 * state of every group is computed from light rows of its drafts; files, thumbnails and
 * candidates are read only for the groups of the page, and of each only its first files.
 */
export async function inboxList(
  q: Queryable,
  model: { id: string; code: string },
  filter: InboxFilter,
  page: InboxPage = {},
): Promise<InboxList> {
  const modelId = model.id
  const now = new Date()
  const limit = page.limit ?? DEFAULT_PAGE_LIMIT
  const after = positionOf(page.cursor)
  let all: Computed[]
  if (filter === 'active') {
    all = await activeGroups(q, modelId, now)
  } else {
    const groups = await decidedCandidates(q, modelId, filter)
    const drafts = await loadDrafts(
      q,
      modelId,
      groups.map((group) => group.id),
      filter,
    )
    const byGroup = Map.groupBy(drafts, (draft) => draft.group_id)
    all = groups
      .map((group) => compute(group, byGroup.get(group.id) ?? [], filter, now))
      .filter((item): item is Computed => item !== null)
  }
  const placed = all
    .map((item) => ({
      item,
      position: {
        rank: filter === 'active' ? rankOf(item.state) : 0,
        at: sortTime(item),
        id: item.group.id,
      },
    }))
    .sort((left, right) => compareGroups(left.position, right.position))
  const rest = after ? placed.filter(({ position }) => compareGroups(position, after) > 0) : placed
  const shown = rest.slice(0, limit)
  const ids = shown.map(({ item }) => item.group.id)
  const files = Map.groupBy(
    await loadFiles(q, modelId, ids, filter, LIST_FILES),
    (file) => file.group_id,
  )
  const extras =
    filter === 'active'
      ? await loadExtras(
          q,
          model,
          ids,
          shown.flatMap(({ item }) => item.drafts),
        )
      : new Map<string, Extras>()
  const last = shown.at(-1)
  // «Новое · 9» is the same number on every tab of «Приехало».
  const active = filter === 'active' ? all : await activeGroups(q, modelId, now)
  const sections = { decision: 0, ready: 0, preparing: 0 }
  for (const item of active) {
    const section = inboxSectionOf(item.state)
    if (section) sections[section] += 1
  }
  const { rows } = await q.execute<{ at: string | null }>(sql`
    SELECT (SELECT max(w.finished_at) FROM work_operations w
             WHERE w.model_id = ${modelId}::uuid AND w.kind = 'scan' AND w.state = 'succeeded') AS at`)
  return {
    items: shown.map(({ item }) =>
      view(model.code, item, files.get(item.group.id) ?? [], extras.get(item.group.id)),
    ),
    next_cursor: last && rest.length > shown.length ? cursorOf(last.position) : null,
    count: active.filter((item) => COUNTED.has(item.state.kind)).length,
    sections,
    disk_checked_at: instantOrNull(rows[0]?.at),
    // «Разбор старого · 38»: what a person still decides there (DESIGN §4.9).
    legacy_disputes: await openDisputeCount(q, modelId),
  }
}

/**
 * What the viewer plays of the drafts (SPEC §6.1, DESIGN §3.5): the previews built from the
 * source. Only a single group carries them — the viewer asks for it; the list stays light.
 */
async function withPreviews(
  q: Queryable,
  model: { id: string; code: string },
  files: readonly DraftFile[],
  rows: readonly FileRow[],
): Promise<DraftFile[]> {
  const previews = await mediaPreviews(
    q,
    model,
    rows.map((row) => ({
      media: row.media_kind === 'video' ? 'video' : 'image',
      master: null,
      source: row.source_hex,
    })),
  )
  const frames = await draftFrames(
    q,
    model,
    rows.flatMap((row) => (row.media_kind === 'video' && row.source_hex ? [row.source_hex] : [])),
  )
  return files.map((file, index) => {
    const preview = previews[index]
    const row = rows[index]
    if (!preview || !row) return file
    // Not fetched or checked yet: the preview comes with the first pass after the bytes.
    const preparing = row.state === 'discovered' || row.state === 'processing'
    const own = row.source_hex ? frames.get(row.source_hex) : undefined
    return {
      ...file,
      preview:
        preview.url || preview.building || !preparing
          ? preview
          : { ...preview, building: { progress: null } },
      ...(own ? { frames: own } : {}),
    }
  })
}

/**
 * Up to ten annotation frames of each video at equal steps (SPEC §9.3 `frames/NNNN.webp`),
 * from the newest ready pass over its source: «Сравнить» of «Похоже на ролик» shows them.
 */
async function draftFrames(
  q: Queryable,
  model: { id: string; code: string },
  sources: readonly string[],
): Promise<Map<string, MasterFrame[]>> {
  const out = new Map<string, MasterFrame[]>()
  if (sources.length === 0) return out
  const { rows } = await q.execute<{
    sha: string
    generation: string
    name: string
    frame_ms: number
    width: number | null
    height: number | null
  }>(sql`
    SELECT encode(g.input_sha256, 'hex') AS sha, g.id AS generation, a.name,
           a.frame_ms::float8 AS frame_ms, a.width, a.height
      FROM (SELECT DISTINCT ON (input_sha256) id, input_sha256 FROM rendition_generations
             WHERE input_sha256 IN (SELECT decode(h, 'hex') FROM unnest(${sql.param([...sources])}::text[]) h)
               AND kind = 'frames' AND state = 'ready' AND NOT meta_stripped
             ORDER BY input_sha256, ready_at DESC) g
      JOIN rendition_artifacts a ON a.generation_id = g.id AND a.state = 'ready'
     WHERE a.frame_ms IS NOT NULL
     ORDER BY 1, a.frame_ms`)
  const bySource = new Map<string, (typeof rows)[number][]>()
  for (const row of rows) bySource.set(row.sha, [...(bySource.get(row.sha) ?? []), row])
  for (const [sha, all] of bySource) {
    const step = Math.max(1, all.length / 10)
    const picked = Array.from(
      { length: Math.min(10, all.length) },
      (_, i) => all[Math.floor(i * step)] as (typeof all)[number],
    )
    out.set(
      sha,
      picked.map((frame, i) => ({
        t_s: Math.round(frame.frame_ms / 100) / 10,
        thumb: {
          key: `draft:${sha.slice(0, 12)}/frame${String(i + 1).padStart(2, '0')}`,
          ratio: thumbRatio('video', frame.width, frame.height),
          url: renditionUrl(model, frame.generation, frame.name),
        },
      })),
    )
  }
  return out
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
    const computed = compute(group, drafts, filter, now)
    if (!computed) continue
    const files = await loadFiles(q, modelId, [groupId], filter, null)
    const extras =
      filter === 'active'
        ? await loadExtras(q, model, [groupId], drafts)
        : new Map<string, Extras>()
    const shown = view(model.code, computed, files, extras.get(groupId))
    return { ...shown, files: await withPreviews(q, model, shown.files, files) }
  }
  throw new ApiProblem('not_found', 'Такой группы нет')
}
