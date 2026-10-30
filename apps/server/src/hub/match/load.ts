import type { Queryable } from '@contentops/db'
import { type SQL, sql } from 'drizzle-orm'
import { standingEvidence } from '../../plan/records'
import { type NameCore, nameCore } from './names'

/**
 * What the matching of one page reads (SPEC §7, schema §3.6, §9.6): the posts Hub saw with their
 * files, the plan rows of the page with their sealed files, the issued names, the vault, the
 * confirmed pairs and the placements already there. Read once per run; nothing is written here.
 */

export type Platform = 'fansly' | 'onlyfans'
export type PostSurface = 'wall' | 'fyp'
export type MatchSurface = PostSurface | 'vault'

export interface Page {
  modelId: string
  modelCode: string
  accountId: string
  accountCode: string
  platform: Platform
  timezone: string
}

/** One file of a post: a `main` row of an offer or a bundle member, or a preview. */
export interface HubFile {
  attachmentId: string
  observationId: string
  role: 'main' | 'offer_preview' | 'bundle_preview'
  linkState: string
  contentType: number | null
  mediaRef: string | null
  mediaOfferRef: string | null
  filename: string | null
  isVideo: boolean
  durationMs: number | null
  width: number | null
  height: number | null
  createdAtPlatform: string | null
  /** The projection the matching keeps (schema §9.6). */
  matchedVersionId: string | null
  receiptEntryId: string | null
  matchStrength: 'none' | 'candidate' | 'exact'
}

export interface HubPostFacts {
  id: string
  ref: string
  observationId: string
  publishedAt: string
  caption: string | null
  fypFlags: number | null
  /** Main files: distinct files of `main` rows of offers and bundle members (SPEC §7, V2). */
  mains: HubFile[]
  previews: HubFile[]
  hasVideo: boolean
  /** Views from For You over the files of the post (`creator_stats_media_daily`, source 0). */
  forYouViews: number
}

/** A sealed file of a plan row. */
export interface RowFile {
  assetId: string
  versionId: string
  role: string
  isVideo: boolean
  durationMs: number | null
  width: number | null
  height: number | null
}

export interface RowFacts {
  id: string
  itemId: string
  itemPublicId: string
  itemTitle: string | null
  surface: MatchSurface
  surfaceId: string
  manifestId: string
  slotAt: string
  slotTime: string | null
  /** The local day of the slot as instants: a row without time takes the whole day. */
  dayStart: string
  dayEnd: string
  marked: boolean
  markKind: 'posted' | 'scheduled' | null
  requiresNewUpload: boolean
  createdAt: string
  albumName: string | null
  /** Main files of the composition: no teaser, no preview (SPEC §7 «Кандидат»). */
  mains: RowFile[]
}

export interface ReceiptEntry {
  id: string
  core: NameCore
  assetId: string
  versionId: string
  itemId: string
  durationMs: number | null
  width: number | null
  height: number | null
}

export interface VaultMember {
  id: string
  observationId: string
  albumRef: string
  albumTitle: string
  albumWalkAt: string | null
  memberRef: string
  mediaRef: string | null
  mediaOfferRef: string | null
  filename: string | null
  isVideo: boolean
  durationMs: number | null
  width: number | null
  height: number | null
  createdAtPlatform: string | null
  membershipAt: string | null
  missingSince: string | null
}

export interface VaultAlbum {
  ref: string
  title: string
  lastFullWalkAt: string | null
}

/** A placement of the page as the matching needs it. */
export interface PlacementFact {
  id: string
  surface: MatchSurface | 'story' | 'mass_dm'
  surfaceId: string
  surfaceSource: string
  manualKey: string | null
  postRef: string | null
  albumRef: string | null
  mediaRef: string | null
  itemId: string | null
  planRowId: string | null
  occurredAt: string | null
  outOfCatalog: boolean
  /** Standing evidence kinds with their strength and keys. */
  evidence: EvidenceFact[]
}

export interface EvidenceFact {
  id: string
  source: 'hub' | 'manual' | 'import'
  kind: string
  strength: string | null
  dedupKey: string
  correctsId: string | null
  payload: Record<string, unknown>
  recordedAt: string
  recordedBy: string | null
}

/** A pair «версия — media ID» a person or an agent confirmed (SPEC §7 «Точное вручную»). */
export interface ConfirmedPair {
  versionId: string
  assetId: string
  /** The object of the placement the pair was confirmed on. */
  itemId: string | null
  mediaRef: string
  durationMs: number | null
  width: number | null
  height: number | null
  confirmedAt: string
  byAgent: boolean
}

/** Main rows that are files: offers and bundle members, not polls or tip goals (V2). */
const FILE_CONTENT_TYPES = new Set([1, 2])

export function isFileRow(file: Pick<HubFile, 'contentType' | 'linkState'>): boolean {
  if (file.linkState === 'non_media_attachment') return false
  return file.contentType === null || FILE_CONTENT_TYPES.has(file.contentType)
}

const iso = (value: string | null): string | null => (value ? new Date(value).toISOString() : null)

export async function pageOf(q: Queryable, accountId: string): Promise<Page | null> {
  const { rows } = await q.execute<{
    model_id: string
    model_code: string
    id: string
    code: string
    platform: Platform
    timezone: string
  }>(sql`
    SELECT a.model_id, m.code AS model_code, a.id, a.code, a.platform, m.timezone
      FROM accounts a JOIN models m ON m.id = a.model_id
     WHERE a.id = ${accountId}::uuid`)
  const row = rows[0]
  if (!row) return null
  return {
    modelId: row.model_id,
    modelCode: row.model_code,
    accountId: row.id,
    accountCode: row.code,
    platform: row.platform,
    timezone: row.timezone,
  }
}

interface AttachmentRow extends Record<string, unknown> {
  post_id: string
  id: string
  current_observation_id: string
  role: HubFile['role']
  link_state: string
  content_type: number | null
  media_ref: string | null
  media_offer_ref: string | null
  filename: string | null
  mime: string | null
  duration_ms: number | null
  width: number | null
  height: number | null
  created_at_platform: string | null
  matched_version_id: string | null
  receipt_entry_id: string | null
  match_strength: HubFile['matchStrength']
}

/** A ContentOps download name in Hub (naming §5): only such files can be exact by name. */
export const DOWNLOAD_NAME_SQL = `^(PPV|SET|SXT|CUS|FYP|LIFE|RAW|PRM)-[0-9]{3,6}_`

/**
 * Posts of the page with their files. `where` narrows `hub_posts p`. Sizes: the source size of
 * the attachment, else the source or the shown size of the platform file (Hub gives no source
 * size of photos, SPEC §7).
 */
export async function loadPosts(q: Queryable, page: Page, where: SQL): Promise<HubPostFacts[]> {
  const { rows: posts } = await q.execute<{
    id: string
    post_ref: string
    current_observation_id: string
    published_at: string | null
    caption: string | null
    fyp_flags: number | null
  }>(sql`
    SELECT p.id, p.post_ref, p.current_observation_id, p.published_at::text AS published_at,
           p.caption, p.fyp_flags
      FROM hub_posts p
     WHERE p.model_id = ${page.modelId}::uuid AND p.account_id = ${page.accountId}::uuid
       AND p.published_at IS NOT NULL AND (${where})
     ORDER BY p.published_at, p.id`)
  if (posts.length === 0) return []
  const ids = posts.map((post) => post.id)
  const { rows: files } = await q.execute<AttachmentRow>(sql`
    SELECT t.post_id, t.id, t.current_observation_id, t.role, t.link_state, t.content_type,
           t.media_ref, t.media_offer_ref, coalesce(t.filename, r.filename) AS filename,
           coalesce(t.mime, r.mime) AS mime, coalesce(t.duration_ms, r.duration_ms) AS duration_ms,
           coalesce(t.orig_width, r.orig_width, r.out_width) AS width,
           coalesce(t.orig_height, r.orig_height, r.out_height) AS height,
           r.created_at_platform::text AS created_at_platform,
           t.matched_version_id, t.receipt_entry_id, t.match_strength
      FROM hub_post_attachments t
      LEFT JOIN hub_raw_media r ON r.model_id = t.model_id AND r.account_id = ${page.accountId}::uuid
       AND r.media_ref = t.media_ref
     WHERE t.model_id = ${page.modelId}::uuid AND t.post_id = ANY (${sql.param(ids)}::uuid[])
     ORDER BY t.post_id, t.attachment_index NULLS LAST, t.member_index NULLS FIRST, t.position`)
  const offers = [
    ...new Set(files.flatMap((file) => (file.media_offer_ref ? [file.media_offer_ref] : []))),
  ]
  const forYou = await forYouViews(q, page, offers)
  const byPost = new Map<string, AttachmentRow[]>()
  for (const file of files) {
    const list = byPost.get(file.post_id) ?? []
    list.push(file)
    byPost.set(file.post_id, list)
  }
  return posts.map((post) => {
    const own = (byPost.get(post.id) ?? []).map(fileOf)
    const mains: HubFile[] = []
    const seen = new Set<string>()
    for (const file of own) {
      if (file.role !== 'main' || !isFileRow(file)) continue
      // One file twice in a post is one file (V2 № 29); a member without a file is one file.
      if (file.mediaRef) {
        if (seen.has(file.mediaRef)) continue
        seen.add(file.mediaRef)
      }
      mains.push(file)
    }
    const previews = own.filter((file) => file.role !== 'main')
    const offersOfPost = own.flatMap((file) => (file.mediaOfferRef ? [file.mediaOfferRef] : []))
    return {
      id: post.id,
      ref: post.post_ref,
      observationId: post.current_observation_id,
      publishedAt: iso(post.published_at) as string,
      caption: post.caption,
      fypFlags: post.fyp_flags,
      mains,
      previews,
      hasVideo: own.some((file) => file.isVideo),
      forYouViews: offersOfPost.reduce((sum, offer) => sum + (forYou.get(offer) ?? 0), 0),
    }
  })
}

function fileOf(row: AttachmentRow): HubFile {
  return {
    attachmentId: row.id,
    observationId: row.current_observation_id,
    role: row.role,
    linkState: row.link_state,
    contentType: row.content_type,
    mediaRef: row.media_ref,
    mediaOfferRef: row.media_offer_ref,
    filename: row.filename,
    isVideo: isVideo(row.mime, row.duration_ms),
    durationMs: row.duration_ms,
    width: row.width,
    height: row.height,
    createdAtPlatform: iso(row.created_at_platform),
    matchedVersionId: row.matched_version_id,
    receiptEntryId: row.receipt_entry_id,
    matchStrength: row.match_strength,
  }
}

export function isVideo(mime: string | null, durationMs: number | null): boolean {
  if (mime) return mime.toLowerCase().startsWith('video/')
  return durationMs !== null && durationMs > 0
}

/** Statistics are observations; the current value of a key is its last one (schema §3.6). */
const LATEST_STATS = (dataset: string, page: Page) => sql`
  SELECT DISTINCT ON (o.external_key) o.payload
    FROM hub_observations o
   WHERE o.model_id = ${page.modelId}::uuid AND o.account_id = ${page.accountId}::uuid
     AND o.dataset = ${dataset}
   ORDER BY o.external_key, o.sequence_no DESC`

async function forYouViews(
  q: Queryable,
  page: Page,
  offers: readonly string[],
): Promise<Map<string, number>> {
  if (offers.length === 0 || page.platform !== 'fansly') return new Map()
  const { rows } = await q.execute<{ offer: string; views: number }>(sql`
    WITH latest AS (${LATEST_STATS('creator_stats_media_daily', page)})
    SELECT payload ->> 'mediaOfferId' AS offer,
           sum(coalesce((payload ->> 'views')::bigint, 0))::float8 AS views
      FROM latest
     WHERE payload ->> 'mediaOfferId' = ANY (${sql.param([...offers])}::text[])
       AND (payload ->> 'source')::int = 0
     GROUP BY 1`)
  return new Map(rows.map((row) => [row.offer, Number(row.views)]))
}

/** Views and likes of files by offer over all days and sources; no row — no data. */
export async function statsByOffer(
  q: Queryable,
  page: Page,
): Promise<Map<string, { views: number | null; likes: number | null }>> {
  const out = new Map<string, { views: number | null; likes: number | null }>()
  if (page.platform !== 'fansly') return out
  const { rows: views } = await q.execute<{ offer: string; views: number }>(sql`
    WITH latest AS (${LATEST_STATS('creator_stats_media_daily', page)})
    SELECT payload ->> 'mediaOfferId' AS offer,
           sum(coalesce((payload ->> 'views')::bigint, 0))::float8 AS views
      FROM latest WHERE payload ->> 'mediaOfferId' IS NOT NULL GROUP BY 1`)
  const { rows: likes } = await q.execute<{ offer: string; likes: number }>(sql`
    WITH latest AS (${LATEST_STATS('creator_stats_media_likes', page)})
    SELECT payload ->> 'mediaOfferId' AS offer,
           sum(coalesce((payload ->> 'likes')::bigint, 0)
               - coalesce((payload ->> 'unlikes')::bigint, 0))::float8 AS likes
      FROM latest WHERE payload ->> 'mediaOfferId' IS NOT NULL GROUP BY 1`)
  for (const row of views) out.set(row.offer, { views: Number(row.views), likes: null })
  for (const row of likes) {
    const entry = out.get(row.offer) ?? { views: null, likes: null }
    entry.likes = Math.max(0, Number(row.likes))
    out.set(row.offer, entry)
  }
  return out
}

/** Roles that are no main file of a post: the teaser goes as a preview (SPEC §7). */
const NOT_MAIN_ROLES = new Set(['teaser', 'preview', 'thumb', 'cap'])

export async function loadRows(
  q: Queryable,
  page: Page,
  where: SQL = sql`true`,
): Promise<RowFacts[]> {
  const { rows } = await q.execute<{
    id: string
    item_id: string
    item_type: string
    item_number: number
    item_title: string | null
    surface: MatchSurface
    surface_id: string
    manifest_id: string
    slot_at: string
    slot_time: string | null
    day_start: string
    day_end: string
    marked_at: string | null
    mark_kind: 'posted' | 'scheduled' | null
    requires_new_upload: boolean
    created_at: string
    album_name: string | null
  }>(sql`
    SELECT r.id, r.item_id, i.type AS item_type, i.number AS item_number, i.title AS item_title,
           s.kind AS surface, r.surface_id, r.manifest_id, r.slot_at::text AS slot_at,
           to_char(r.slot_time, 'HH24:MI') AS slot_time,
           ((r.slot_date)::timestamp AT TIME ZONE r.slot_tz)::text AS day_start,
           ((r.slot_date + 1)::timestamp AT TIME ZONE r.slot_tz)::text AS day_end,
           r.marked_at::text AS marked_at, r.mark_kind, r.requires_new_upload,
           r.created_at::text AS created_at, r.album_name
      FROM posting_plan_rows r
      JOIN surfaces s ON s.model_id = r.model_id AND s.id = r.surface_id
      JOIN content_items i ON i.model_id = r.model_id AND i.id = r.item_id
     WHERE r.model_id = ${page.modelId}::uuid AND r.account_id = ${page.accountId}::uuid
       AND s.kind IN ('wall', 'fyp', 'vault') AND r.cancelled_at IS NULL
       AND r.manifest_id IS NOT NULL AND (${where})
     ORDER BY r.slot_at, r.id`)
  if (rows.length === 0) return []
  const manifests = [...new Set(rows.map((row) => row.manifest_id))]
  const { rows: files } = await q.execute<{
    manifest_id: string
    asset_id: string
    version_id: string
    role: string | null
    media_kind: 'video' | 'image'
    duration_ms: string | null
    width: number | null
    height: number | null
  }>(sql`
    SELECT e.manifest_id, e.asset_id, e.asset_version_id AS version_id, m.role, a.media_kind,
           v.duration_ms::text AS duration_ms, v.width, v.height
      FROM asset_manifest_entries e
      JOIN assets a ON a.model_id = e.model_id AND a.id = e.asset_id
      JOIN asset_versions v ON v.model_id = e.model_id AND v.id = e.asset_version_id
      LEFT JOIN item_memberships m ON m.model_id = e.model_id AND m.id = e.membership_id
     WHERE e.model_id = ${page.modelId}::uuid AND e.manifest_id = ANY (${sql.param(manifests)}::uuid[])
     ORDER BY e.manifest_id, e.position`)
  const byManifest = new Map<string, RowFile[]>()
  for (const file of files) {
    if (NOT_MAIN_ROLES.has(file.role ?? 'pic')) continue
    const list = byManifest.get(file.manifest_id) ?? []
    list.push({
      assetId: file.asset_id,
      versionId: file.version_id,
      role: file.role ?? 'pic',
      isVideo: file.media_kind === 'video',
      durationMs: file.duration_ms === null ? null : Number(file.duration_ms),
      width: file.width,
      height: file.height,
    })
    byManifest.set(file.manifest_id, list)
  }
  return rows.map((row) => ({
    id: row.id,
    itemId: row.item_id,
    itemPublicId: publicId(row.item_type, row.item_number),
    itemTitle: row.item_title,
    surface: row.surface,
    surfaceId: row.surface_id,
    manifestId: row.manifest_id,
    slotAt: iso(row.slot_at) as string,
    slotTime: row.slot_time,
    dayStart: iso(row.day_start) as string,
    dayEnd: iso(row.day_end) as string,
    marked: row.marked_at !== null,
    markKind: row.mark_kind,
    requiresNewUpload: row.requires_new_upload,
    createdAt: iso(row.created_at) as string,
    albumName: row.album_name,
    mains: byManifest.get(row.manifest_id) ?? [],
  }))
}

export function publicId(type: string, number: number): string {
  const padding = type === 'FYP' || type === 'RAW' ? 4 : 3
  return `${type}-${String(number).padStart(padding, '0')}`
}

/** Issued files whose names have one of the cores (both forms of the name, any extension). */
export async function receiptsFor(
  q: Queryable,
  page: Page,
  cores: readonly NameCore[],
): Promise<Map<string, ReceiptEntry[]>> {
  const out = new Map<string, ReceiptEntry[]>()
  const ids = [...new Set(cores.map((core) => core.id.toLowerCase()))]
  if (ids.length === 0) return out
  const { rows } = await q.execute<{
    id: string
    file_name: string
    asset_id: string
    asset_version_id: string
    item_id: string
    duration_ms: string | null
    width: number | null
    height: number | null
  }>(sql`
    SELECT e.id, e.file_name, e.asset_id, e.asset_version_id, s.created_in_item_id AS item_id,
           e.duration_ms::text AS duration_ms, e.width, e.height
      FROM download_receipt_entries e
      JOIN assets s ON s.model_id = e.model_id AND s.id = e.asset_id
     WHERE e.model_id = ${page.modelId}::uuid
       AND e.file_name_norm LIKE ANY (${sql.param(ids.map((id) => `${id}\\_%`))}::text[])`)
  const wanted = new Set(cores.map((core) => core.key))
  for (const row of rows) {
    const core = nameCore(row.file_name)
    if (!core || !wanted.has(core.key)) continue
    const list = out.get(core.key) ?? []
    list.push({
      id: row.id,
      core,
      assetId: row.asset_id,
      versionId: row.asset_version_id,
      itemId: row.item_id,
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      width: row.width,
      height: row.height,
    })
    out.set(core.key, list)
  }
  return out
}

/** Members of the creator's named albums; system albums (All, Posts, Messages) have no title. */
export async function loadVault(
  q: Queryable,
  page: Page,
): Promise<{ albums: VaultAlbum[]; members: VaultMember[] }> {
  const { rows: albums } = await q.execute<{
    album_ref: string
    title: string
    last_full_walk_at: string | null
  }>(sql`
    SELECT album_ref, title, last_full_walk_at::text AS last_full_walk_at FROM hub_vault_albums
     WHERE model_id = ${page.modelId}::uuid AND account_id = ${page.accountId}::uuid
       AND nullif(trim(title), '') IS NOT NULL`)
  const { rows } = await q.execute<{
    id: string
    current_observation_id: string
    album_ref: string
    album_title: string
    walk_at: string | null
    member_ref: string
    media_ref: string | null
    media_offer_ref: string | null
    filename: string | null
    mime: string | null
    duration_ms: number | null
    width: number | null
    height: number | null
    created_at_platform: string | null
    membership_at: string | null
    missing_since: string | null
  }>(sql`
    SELECT m.id, m.current_observation_id, a.album_ref, a.title AS album_title,
           a.last_full_walk_at::text AS walk_at, m.member_ref, m.media_ref, m.media_offer_ref,
           coalesce(m.custom_filename, m.filename) AS filename, m.mime, m.duration_ms,
           coalesce(m.orig_width, r.orig_width, r.out_width) AS width,
           coalesce(m.orig_height, r.orig_height, r.out_height) AS height,
           coalesce(m.created_at_platform, r.created_at_platform)::text AS created_at_platform,
           m.membership_at::text AS membership_at, m.missing_since::text AS missing_since
      FROM hub_vault_media m
      JOIN hub_vault_albums a ON a.model_id = m.model_id AND a.id = m.album_id
      LEFT JOIN hub_raw_media r ON r.model_id = m.model_id AND r.account_id = m.account_id
       AND r.media_ref = m.media_ref
     WHERE m.model_id = ${page.modelId}::uuid AND m.account_id = ${page.accountId}::uuid
       AND nullif(trim(a.title), '') IS NOT NULL
     ORDER BY a.album_ref, m.membership_at NULLS LAST, m.member_ref`)
  return {
    albums: albums.map((row) => ({
      ref: row.album_ref,
      title: row.title,
      lastFullWalkAt: iso(row.last_full_walk_at),
    })),
    members: rows.map((row) => ({
      id: row.id,
      observationId: row.current_observation_id,
      albumRef: row.album_ref,
      albumTitle: row.album_title,
      albumWalkAt: iso(row.walk_at),
      memberRef: row.member_ref,
      mediaRef: row.media_ref,
      mediaOfferRef: row.media_offer_ref,
      filename: row.filename,
      isVideo: isVideo(row.mime, row.duration_ms),
      durationMs: row.duration_ms,
      width: row.width,
      height: row.height,
      createdAtPlatform: iso(row.created_at_platform),
      membershipAt: iso(row.membership_at),
      missingSince: iso(row.missing_since),
    })),
  }
}

export async function loadPlacements(q: Queryable, page: Page): Promise<PlacementFact[]> {
  const { rows } = await q.execute<{
    id: string
    surface: PlacementFact['surface']
    surface_id: string
    surface_source: string
    manual_key: string | null
    external_post_ref: string | null
    external_album_ref: string | null
    external_media_ref: string | null
    item_id: string | null
    plan_row_id: string | null
    occurred_at: string | null
    out_of_catalog: boolean
  }>(sql`
    SELECT p.id, s.kind AS surface, p.surface_id, p.surface_source, p.manual_key,
           p.external_post_ref, p.external_album_ref, p.external_media_ref, p.item_id,
           p.plan_row_id, p.occurred_at::text AS occurred_at, p.out_of_catalog
      FROM placements p JOIN surfaces s ON s.model_id = p.model_id AND s.id = p.surface_id
     WHERE p.model_id = ${page.modelId}::uuid AND p.account_id = ${page.accountId}::uuid`)
  if (rows.length === 0) return []
  const { rows: evidence } = await q.execute<{
    id: string
    placement_id: string
    source: EvidenceFact['source']
    kind: string
    strength: string | null
    dedup_key: string
    corrects_id: string | null
    payload: Record<string, unknown>
    recorded_at: string
    recorded_by: string | null
  }>(sql`
    SELECT e.id, e.placement_id, e.source, e.kind, e.strength, e.dedup_key, e.corrects_id,
           e.payload, e.recorded_at::text AS recorded_at, e.recorded_by
      FROM placement_evidence e
     WHERE e.model_id = ${page.modelId}::uuid
       AND e.placement_id = ANY (${sql.param(rows.map((row) => row.id))}::uuid[])
     ORDER BY e.recorded_at, e.id`)
  const standingIds = new Set(standingEvidence(evidence).map((row) => row.id))
  const byPlacement = new Map<string, EvidenceFact[]>()
  for (const row of evidence) {
    const list = byPlacement.get(row.placement_id) ?? []
    list.push({
      id: row.id,
      source: row.source,
      kind: row.kind,
      strength: row.strength,
      dedupKey: row.dedup_key,
      correctsId: row.corrects_id,
      payload: row.payload,
      recordedAt: iso(row.recorded_at) as string,
      recordedBy: row.recorded_by,
    })
    byPlacement.set(row.placement_id, list)
  }
  return rows.map((row) => ({
    id: row.id,
    surface: row.surface,
    surfaceId: row.surface_id,
    surfaceSource: row.surface_source,
    manualKey: row.manual_key,
    postRef: row.external_post_ref,
    albumRef: row.external_album_ref,
    mediaRef: row.external_media_ref,
    itemId: row.item_id,
    planRowId: row.plan_row_id,
    occurredAt: iso(row.occurred_at),
    outOfCatalog: row.out_of_catalog,
    // Every row is kept for dedup; `standing` filters for decisions.
    evidence: (byPlacement.get(row.id) ?? []).map((entry) => ({
      ...entry,
      payload: { ...entry.payload, standing: standingIds.has(entry.id) },
    })),
  }))
}

/** Evidence still in force: a retraction takes back the row it corrects, and itself. */
export function standing(evidence: readonly EvidenceFact[]): EvidenceFact[] {
  return evidence.filter((entry) => entry.payload.standing === true)
}

/** Confirmed pairs «версия — media ID» on the page (SPEC §7): manual and reused, not retracted. */
export function confirmedPairs(
  placements: readonly PlacementFact[],
  agents: ReadonlySet<string>,
): Map<string, ConfirmedPair> {
  const out = new Map<string, ConfirmedPair>()
  for (const placement of placements) {
    for (const entry of standing(placement.evidence)) {
      if (entry.kind !== 'manual_confirm' && entry.kind !== 'reused_pair') continue
      const pairs = entry.payload.pairs
      if (!Array.isArray(pairs)) continue
      const byAgent =
        entry.kind === 'reused_pair'
          ? entry.payload.by_agent === true
          : agents.has(entry.recordedBy ?? '')
      for (const pair of pairs as Record<string, unknown>[]) {
        const mediaRef = typeof pair.media_ref === 'string' ? pair.media_ref : null
        const versionId = typeof pair.version_id === 'string' ? pair.version_id : null
        const assetId = typeof pair.asset_id === 'string' ? pair.asset_id : null
        if (!mediaRef || !versionId || !assetId) continue
        if (out.has(mediaRef)) continue
        out.set(mediaRef, {
          versionId,
          assetId,
          itemId: placement.itemId,
          mediaRef,
          durationMs: typeof pair.duration_ms === 'number' ? pair.duration_ms : null,
          width: typeof pair.width === 'number' ? pair.width : null,
          height: typeof pair.height === 'number' ? pair.height : null,
          confirmedAt: entry.recordedAt,
          byAgent,
        })
      }
    }
  }
  return out
}

/**
 * Plan rows, posts and vault albums linked exactly through a Hub publication (stage 5б, SPEC §7,
 * `0009_publications`): such a row and such a post are never matched — the publication links
 * them (`linkPublished`).
 */
export async function publicationLinks(
  q: Queryable,
  page: Page,
): Promise<{ rows: Set<string>; refs: Set<string>; albums: Set<string> }> {
  const { rows } = await q.execute<{ id: string; post: string | null; album: string | null }>(sql`
    SELECT r.id, r.platform_post_ref AS post, r.vault_album_ref AS album FROM posting_plan_rows r
     WHERE r.model_id = ${page.modelId}::uuid AND r.account_id = ${page.accountId}::uuid
       AND (r.hub_publication_id IS NOT NULL OR r.platform_post_ref IS NOT NULL
            OR r.vault_album_ref IS NOT NULL)`)
  // The same sets `is_publication_post` / `is_publication_album` (0009) answer, read once a run.
  return {
    rows: new Set(rows.map((row) => row.id)),
    refs: new Set(rows.flatMap((row) => (row.post ? [row.post] : []))),
    albums: new Set(rows.flatMap((row) => (row.album ? [row.album] : []))),
  }
}

/** Principals that are agents: their confirmations read «подтверждено агентом» (§11.1). */
export async function agentIds(q: Queryable): Promise<Set<string>> {
  const { rows } = await q.execute<{ id: string }>(
    sql`SELECT id FROM principals WHERE kind = 'agent'`,
  )
  return new Set(rows.map((row) => row.id))
}
