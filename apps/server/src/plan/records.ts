import type { ActorRef, Gender } from '@contentops/contracts/domain/common'
import type { Account, Model } from '@contentops/contracts/domain/model'
import type { CancelReason, SurfaceKind } from '@contentops/contracts/domain/placement'
import type { Queryable } from '@contentops/db'
import { type SQL, sql } from 'drizzle-orm'
import { instant, instantOrNull } from '../commands'
import type { ModelScope } from '../context'
import { ApiProblem } from '../errors'
import { modelViews } from '../handlers/models'

/**
 * The stored facts of the plan (schema §3.5, §3.6): plan rows with their page, surface and
 * object, the placements and evidence that belong to them, and the people who wrote them.
 * Views and rules read these records; nothing here computes a level.
 */

/** Surface kinds of the schema; the contract says `dm` for `mass_dm`. */
export type DbSurface = 'wall' | 'fyp' | 'story' | 'vault' | 'mass_dm'

export function surfaceOfDb(kind: DbSurface): SurfaceKind {
  return kind === 'mass_dm' ? 'dm' : kind
}

export function dbSurface(kind: SurfaceKind): DbSurface {
  return kind === 'dm' ? 'mass_dm' : kind
}

export type DbItemType = 'PPV' | 'SET' | 'SXT' | 'CUS' | 'FYP' | 'LIFE' | 'RAW' | 'PRM'

export interface RowRecord {
  id: string
  item_id: string | null
  item_type: DbItemType | null
  item_number: number | null
  item_title: string | null
  item_title_en: string | null
  ppv_kind: 'bundle' | 'dm' | null
  has_second_person: boolean | null
  account_id: string
  account: string
  platform: 'fansly' | 'onlyfans'
  surface_id: string
  surface: DbSurface
  slot_date: string
  slot_time: string | null
  slot_at: string
  assignee_id: string | null
  /** The row's assignee or the page's usual one (SPEC §4). */
  executor_id: string | null
  release_id: string | null
  release_date: string | null
  manifest_id: string | null
  marked_manifest_id: string | null
  expected_type: 'FYP' | 'PPV' | null
  expected_role: 'teaser' | null
  input_manifest_id: string | null
  input_item_id: string | null
  input_item_type: DbItemType | null
  input_item_number: number | null
  uniq_variant_no: number | null
  marked_by: string | null
  marked_at: string | null
  mark_kind: 'posted' | 'scheduled' | null
  stated_occurred_at: string | null
  requires_new_upload: boolean
  caption: string | null
  tier_refs: string[] | null
  price_mills: string | null
  repost: boolean
  album_name: string | null
  cancelled_at: string | null
  cancelled_by: string | null
  cancel_reason: CancelReason | 'second_person' | null
  note: string | null
  created_at: string
  created_by: string | null
  row_version: number
  /** Publication through Hub (5б, schema §3.5). */
  hub_publication_id: number | null
  hub_kind: PublicationKind | null
  hub_status: string | null
  hub_status_reason: string | null
  hub_status_at: string | null
  hub_updated_at: string | null
  hub_version: number | null
  hub_checks: HubChecks | null
  hub_files: HubFile[]
  hub_content_hash: string | null
  hub_prepared_at: string | null
  hub_prepared_by: string | null
  hub_prepared_version: number | null
  hub_sent_at: string | null
  hub_sent_by: string | null
  platform_post_ref: string | null
  vault_album_ref: string | null
}

export type PublicationKind = 'fyp_post' | 'subscriber_post' | 'paid_post' | 'story' | 'vault_album'

/** Hub's checks of the draft as kept on the row (`hub_checks`). */
export interface HubChecks {
  blocked: boolean
  findings: { code: string; severity: string; media_key: string | null }[]
}

/** One file of the draft (`hub_files`): uploaded to Hub or the same file in the page's vault. */
export interface HubFile {
  version_id: string
  name: string
  role: 'media' | 'preview'
  sha256: string | null
  bytes: number | null
  file_id: number | null
  vault_media_ref: string | null
  uploaded_at: string | null
}

const ROW_COLUMNS = sql`
  r.id, r.item_id, i.type AS item_type, i.number AS item_number, i.title AS item_title,
  i.title_en AS item_title_en, i.ppv_kind, i.has_second_person,
  r.account_id, a.code AS account, a.platform, r.surface_id, s.kind AS surface,
  r.slot_date::text AS slot_date, to_char(r.slot_time, 'HH24:MI') AS slot_time,
  r.slot_at::text AS slot_at, r.assignee_id, coalesce(r.assignee_id, a.default_assignee_id) AS executor_id,
  r.release_id, pr.release_date::text AS release_date, r.manifest_id, r.marked_manifest_id,
  r.expected_type, r.expected_role, r.input_manifest_id, im.origin_item_id AS input_item_id,
  ii.type AS input_item_type, ii.number AS input_item_number, r.uniq_variant_no,
  r.marked_by, r.marked_at::text AS marked_at, r.mark_kind,
  r.stated_occurred_at::text AS stated_occurred_at, r.requires_new_upload,
  r.caption, r.tier_refs, r.price_mills::text AS price_mills, r.repost, r.album_name,
  r.cancelled_at::text AS cancelled_at, r.cancelled_by, r.cancel_reason, r.note,
  r.created_at::text AS created_at, r.created_by, r.row_version::int AS row_version,
  r.hub_publication_id::text AS hub_publication_id, r.hub_kind, r.hub_status, r.hub_status_reason,
  r.hub_status_at::text AS hub_status_at, r.hub_updated_at::text AS hub_updated_at, r.hub_version,
  r.hub_checks, r.hub_files, r.hub_content_hash, r.hub_prepared_at::text AS hub_prepared_at,
  r.hub_prepared_by, r.hub_prepared_version::int AS hub_prepared_version,
  r.hub_sent_at::text AS hub_sent_at, r.hub_sent_by, r.platform_post_ref, r.vault_album_ref`

const ROW_JOINS = sql`
  FROM posting_plan_rows r
  JOIN accounts a ON a.model_id = r.model_id AND a.id = r.account_id
  JOIN surfaces s ON s.model_id = r.model_id AND s.id = r.surface_id
  LEFT JOIN content_items i ON i.model_id = r.model_id AND i.id = r.item_id
  LEFT JOIN ppv_releases pr ON pr.model_id = r.model_id AND pr.id = r.release_id
  LEFT JOIN asset_manifests im ON im.model_id = r.model_id AND im.id = r.input_manifest_id
  LEFT JOIN content_items ii ON ii.model_id = im.model_id AND ii.id = im.origin_item_id`

function normalise(row: RowRecord): RowRecord {
  return {
    ...row,
    slot_at: instant(row.slot_at),
    marked_at: instantOrNull(row.marked_at),
    stated_occurred_at: instantOrNull(row.stated_occurred_at),
    cancelled_at: instantOrNull(row.cancelled_at),
    created_at: instant(row.created_at),
    hub_publication_id:
      row.hub_publication_id === null ? null : Number(row.hub_publication_id as unknown as string),
    hub_status_at: instantOrNull(row.hub_status_at),
    hub_updated_at: instantOrNull(row.hub_updated_at),
    hub_prepared_at: instantOrNull(row.hub_prepared_at),
    hub_sent_at: instantOrNull(row.hub_sent_at),
  }
}

/** Plan rows of the model narrowed by `where` (columns of `r`, `a`, `s`, `i`). */
export async function loadRows(
  q: Queryable,
  model: ModelScope,
  where: SQL = sql``,
  lock = false,
): Promise<RowRecord[]> {
  const { rows } = await q.execute<RowRecord & Record<string, unknown>>(sql`
    SELECT ${ROW_COLUMNS} ${ROW_JOINS}
     WHERE r.model_id = ${model.id}::uuid ${where}
     ORDER BY r.slot_at, r.slot_time NULLS FIRST, a.position, r.created_at, r.id
     ${lock ? sql`FOR UPDATE OF r` : sql``}`)
  return rows.map(normalise)
}

/** One row by id; an unknown or foreign id is a 404 inside the model. */
export async function rowById(
  q: Queryable,
  model: ModelScope,
  id: string,
  lock = false,
): Promise<RowRecord> {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const [row] = UUID.test(id) ? await loadRows(q, model, sql`AND r.id = ${id}::uuid`, lock) : []
  if (!row) throw new ApiProblem('not_found', 'Такой строки плана нет', { row: id })
  return row
}

// ---------------------------------------------------------------------------
// Placements and evidence
// ---------------------------------------------------------------------------

export interface PlacementRecord {
  id: string
  account: string
  account_id: string
  surface: DbSurface
  surface_id: string
  item_id: string | null
  item_type: DbItemType | null
  item_number: number | null
  plan_row_id: string | null
  planned_at: string | null
  occurred_at: string | null
  event_precision: 'exact' | 'day' | 'unknown'
  origin: 'plan' | 'hub' | 'manual' | 'import'
  caption: string | null
  views: string | null
  stats_at: string | null
  out_of_catalog: boolean
  manual_key: string | null
  external_post_ref: string | null
  external_album_ref: string | null
  external_media_ref: string | null
  surface_source: string
  likes: string | null
}

export interface EvidenceRecord {
  id: string
  placement_id: string
  source: 'hub' | 'manual' | 'import'
  kind:
    | 'observed'
    | 'manual_confirm'
    | 'reused_pair'
    | 'manual_reject'
    | 'legacy_claim'
    | 'outside_catalog'
    | 'retract'
  strength: 'claim' | 'candidate' | 'exact' | null
  payload: Record<string, unknown>
  event_at: string | null
  recorded_at: string
  recorded_by: string | null
  corrects_id: string | null
  legacy_fragment: string | null
  external_ref: string | null
  matched_version_id: string | null
}

export async function loadPlacements(
  q: Queryable,
  model: ModelScope,
  where: SQL = sql``,
): Promise<PlacementRecord[]> {
  const { rows } = await q.execute<PlacementRecord & Record<string, unknown>>(sql`
    SELECT p.id, a.code AS account, p.account_id, s.kind AS surface, p.surface_id, p.item_id,
           i.type AS item_type, i.number AS item_number, p.plan_row_id,
           p.planned_at::text AS planned_at, p.occurred_at::text AS occurred_at,
           p.event_precision, p.origin, p.caption, p.views::text AS views,
           p.stats_at::text AS stats_at, p.out_of_catalog, p.manual_key, p.external_post_ref,
           p.external_album_ref, p.external_media_ref, p.surface_source, p.likes::text AS likes
      FROM placements p
      JOIN accounts a ON a.model_id = p.model_id AND a.id = p.account_id
      JOIN surfaces s ON s.model_id = p.model_id AND s.id = p.surface_id
      LEFT JOIN content_items i ON i.model_id = p.model_id AND i.id = p.item_id
     WHERE p.model_id = ${model.id}::uuid ${where}
     ORDER BY p.created_at, p.id`)
  return rows.map((row) => ({
    ...row,
    planned_at: instantOrNull(row.planned_at),
    occurred_at: instantOrNull(row.occurred_at),
    stats_at: instantOrNull(row.stats_at),
  }))
}

export async function loadEvidence(
  q: Queryable,
  model: ModelScope,
  placementIds: readonly string[],
): Promise<EvidenceRecord[]> {
  if (placementIds.length === 0) return []
  const { rows } = await q.execute<EvidenceRecord & Record<string, unknown>>(sql`
    SELECT e.id, e.placement_id, e.source, e.kind, e.strength, e.payload,
           e.event_at::text AS event_at, e.recorded_at::text AS recorded_at, e.recorded_by,
           e.corrects_id, c.raw_fragment AS legacy_fragment, e.external_ref, e.matched_version_id
      FROM placement_evidence e
      LEFT JOIN legacy_claims c ON c.model_id = e.model_id AND c.id = e.legacy_claim_id
     WHERE e.model_id = ${model.id}::uuid
       AND e.placement_id = ANY(${sql.param([...placementIds])}::uuid[])
     ORDER BY e.recorded_at, e.id`)
  return rows.map((row) => ({
    ...row,
    event_at: instantOrNull(row.event_at),
    recorded_at: instant(row.recorded_at),
  }))
}

/**
 * Evidence that still stands: a retraction takes back the row it corrects, and itself; a «Не
 * то» takes back the candidate it answers while it is not retracted itself («Отменить»).
 */
export function standingEvidence<
  T extends {
    id: string
    kind: string
    corrects_id: string | null
    payload?: Record<string, unknown>
  },
>(evidence: readonly T[]): T[] {
  const retracted = new Set(
    evidence.flatMap((row) => (row.kind === 'retract' && row.corrects_id ? [row.corrects_id] : [])),
  )
  const effective = evidence.filter((row) => row.kind !== 'retract' && !retracted.has(row.id))
  const corrected = new Set(
    effective.flatMap((row) => {
      const rejects = row.kind === 'manual_reject' ? row.payload?.rejects : undefined
      return [
        ...(row.corrects_id ? [row.corrects_id] : []),
        ...(typeof rejects === 'string' ? [rejects] : []),
      ]
    }),
  )
  return effective.filter((row) => !corrected.has(row.id))
}

// ---------------------------------------------------------------------------
// People and pages
// ---------------------------------------------------------------------------

export interface PersonRecord {
  id: string
  name: string
  gender: Gender | null
  kind: 'human' | 'agent'
}

export type People = Map<string, PersonRecord>

export async function loadPeople(q: Queryable): Promise<People> {
  const { rows } = await q.execute<PersonRecord & Record<string, unknown>>(sql`
    SELECT id, display_name AS name, gender, kind FROM principals`)
  return new Map(rows.map((row) => [row.id, row]))
}

const SYSTEM: ActorRef = { type: 'system', id: null, name: 'Система', gender: null }

export function actorRef(people: People, id: string | null): ActorRef {
  const person = id ? people.get(id) : undefined
  if (!person) return SYSTEM
  return {
    type: person.kind === 'agent' ? 'agent' : 'person',
    id: person.id,
    name: person.name,
    gender: person.gender,
  }
}

export function personName(people: People, id: string | null) {
  const person = id ? people.get(id) : undefined
  return person ? { name: person.name, gender: person.gender } : { name: 'Система', gender: null }
}

export async function modelView(q: Queryable, model: ModelScope): Promise<Model> {
  const [view] = await modelViews(q, [model.code])
  if (!view) throw new ApiProblem('not_found', 'Такой модели нет')
  return view
}

export function accountOf(view: Model, code: string): Account {
  const account = view.accounts.find((candidate) => candidate.code === code)
  if (!account) {
    throw new ApiProblem('invalid_request', 'Такой страницы у модели нет', { account: code })
  }
  return account
}
