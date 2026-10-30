import type { Queryable } from '@contentops/db'
import { values } from '@contentops/db'
import type { DatasetRow, HubDataset, HubScalar } from '@contentops/hub'
import { sql } from 'drizzle-orm'
import { semanticHash } from './hash'

/**
 * Writes of the Hub mirror (schema §3.6, §9.6): every change of a Hub row is a new row of the
 * append-only log `hub_observations`, the typed tables keep the current row and point at its
 * observation. A repeat of the same row adds nothing to the log and only moves `last_seen_at`;
 * A→B→A is three observations. Each call runs inside the caller's transaction.
 */

/** Whose rows these are and which work saw them. */
export interface MirrorScope {
  modelId: string
  accountId: string
  workId: string
  attempt: number
}

/** A value of a Hub list the schema does not know: the poll of the page stops (SPEC §8.1). */
export class HubFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HubFormatError'
  }
}

export interface Observed {
  id: string
  /** A new observation was written: the row is new or its meaning changed. */
  changed: boolean
}

interface Incoming {
  key: string
  hash: Buffer
  payload: Readonly<Record<string, HubScalar>>
  rowUpdatedAt: string | null
}

function incoming<D extends HubDataset>(dataset: D, row: DatasetRow<D>): Incoming {
  const fields = row.fields as Readonly<Record<string, HubScalar>>
  const updated = fields.rowUpdatedAt
  return {
    key: row.key,
    hash: semanticHash(dataset, row),
    payload: fields,
    rowUpdatedAt: typeof updated === 'string' ? updated : null,
  }
}

/** The last row of each key wins: one Hub page may repeat a key only by mistake. */
function lastByKey<T>(rows: readonly T[], keyOf: (row: T) => string | null): Map<string, T> {
  const out = new Map<string, T>()
  for (const row of rows) {
    const key = keyOf(row)
    if (key !== null) out.set(key, row)
  }
  return out
}

/**
 * Appends an observation for each row that is new or changed its meaning; returns the latest
 * observation of every key of the batch.
 */
export async function observe<D extends HubDataset & values.HubObservedDataset>(
  q: Queryable,
  scope: MirrorScope,
  dataset: D,
  rows: readonly DatasetRow<D>[],
): Promise<Map<string, Observed>> {
  const batch = lastByKey(
    rows.map((row) => incoming(dataset, row)),
    (row) => row.key,
  )
  const result = new Map<string, Observed>()
  if (batch.size === 0) return result
  const { rows: latest } = await q.execute<{
    external_key: string
    id: string
    sequence_no: number
    semantic_hash: Buffer
  }>(sql`
    SELECT DISTINCT ON (external_key) external_key, id, sequence_no, semantic_hash
      FROM hub_observations
     WHERE model_id = ${scope.modelId}::uuid AND account_id = ${scope.accountId}::uuid
       AND dataset = ${dataset} AND external_key = ANY (${sql.param([...batch.keys()])}::text[])
     ORDER BY external_key, sequence_no DESC`)
  const previous = new Map(latest.map((row) => [row.external_key, row]))
  const inserts: Record<string, unknown>[] = []
  for (const [key, row] of batch) {
    const before = previous.get(key)
    if (before && Buffer.from(before.semantic_hash).equals(row.hash)) {
      result.set(key, { id: before.id, changed: false })
      continue
    }
    inserts.push({
      external_key: key,
      sequence_no: before ? Number(before.sequence_no) + 1 : 1,
      previous_id: before?.id ?? null,
      semantic_hash: row.hash.toString('hex'),
      payload: row.payload,
      row_updated_at: row.rowUpdatedAt,
    })
  }
  if (inserts.length > 0) {
    const { rows: added } = await q.execute<{ external_key: string; id: string }>(sql`
      INSERT INTO hub_observations (
        model_id, account_id, dataset, external_key, sequence_no, row_updated_at, semantic_hash,
        payload, run_id, run_attempt, previous_id
      )
      SELECT ${scope.modelId}::uuid, ${scope.accountId}::uuid, ${dataset}, x.external_key,
             x.sequence_no, x.row_updated_at, decode(x.semantic_hash, 'hex'), x.payload,
             ${scope.workId}::uuid, ${scope.attempt}, x.previous_id
        FROM jsonb_to_recordset(${JSON.stringify(inserts)}::jsonb) AS x(
          external_key text, sequence_no integer, row_updated_at timestamptz,
          semantic_hash text, payload jsonb, previous_id uuid)
      RETURNING external_key, id`)
    for (const row of added) result.set(row.external_key, { id: row.id, changed: true })
  }
  return result
}

export interface MirrorStats {
  rows: number
  changed: number
}

function count(observed: Map<string, Observed>): MirrorStats {
  let changed = 0
  for (const entry of observed.values()) if (entry.changed) changed += 1
  return { rows: observed.size, changed }
}

const str = (value: HubScalar | undefined): string | null =>
  typeof value === 'string' && value !== '' ? value : null
const int = (value: HubScalar | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null

// ---------------------------------------------------------------------------
// posts
// ---------------------------------------------------------------------------

/** Posts of the page: the log, then the current rows by `post_ref`. */
export async function mirrorPosts(
  q: Queryable,
  scope: MirrorScope,
  rows: readonly DatasetRow<'posts'>[],
): Promise<MirrorStats & { refs: string[] }> {
  const byRef = lastByKey(rows, (row) => str(row.fields.postRef))
  const kept = [...byRef.values()]
  const observed = await observe(q, scope, 'posts', kept)
  const data = kept.map((row) => ({
    post_ref: row.fields.postRef,
    observation_id: observed.get(row.key)?.id,
    published_at: row.fields.publishedAt,
    caption: row.fields.postText,
    attachment_count: int(row.fields.attachmentCount),
    fyp_flags: int(row.fields.fypFlags),
    wall_refs: row.fields.wallRefs ?? [],
    first_observed_at: row.fields.firstObservedAt,
    last_observed_at: row.fields.lastObservedAt,
    row_updated_at: row.fields.rowUpdatedAt,
  }))
  if (data.length > 0) {
    await q.execute(sql`
      INSERT INTO hub_posts (
        model_id, account_id, post_ref, current_observation_id, published_at, caption,
        attachment_count, fyp_flags, wall_refs, first_observed_at, last_observed_at,
        row_updated_at, last_seen_at
      )
      SELECT ${scope.modelId}::uuid, ${scope.accountId}::uuid, x.post_ref, x.observation_id,
             x.published_at, x.caption, x.attachment_count, x.fyp_flags, x.wall_refs,
             x.first_observed_at, x.last_observed_at, x.row_updated_at, now()
        FROM jsonb_to_recordset(${JSON.stringify(data)}::jsonb) AS x(
          post_ref text, observation_id uuid, published_at timestamptz, caption text,
          attachment_count integer, fyp_flags integer, wall_refs jsonb,
          first_observed_at timestamptz, last_observed_at timestamptz, row_updated_at timestamptz)
      ON CONFLICT ON CONSTRAINT hub_posts_ref DO UPDATE
         SET current_observation_id = excluded.current_observation_id,
             published_at = excluded.published_at,
             caption = excluded.caption,
             attachment_count = excluded.attachment_count,
             fyp_flags = excluded.fyp_flags,
             wall_refs = excluded.wall_refs,
             first_observed_at = excluded.first_observed_at,
             last_observed_at = excluded.last_observed_at,
             row_updated_at = excluded.row_updated_at,
             last_seen_at = excluded.last_seen_at`)
  }
  return { ...count(observed), refs: [...byRef.keys()] }
}

/** Refs of the page's posts that the mirror already holds. */
export async function knownPosts(
  q: Queryable,
  scope: MirrorScope,
  refs: readonly string[],
): Promise<Set<string>> {
  if (refs.length === 0) return new Set()
  const { rows } = await q.execute<{ post_ref: string }>(sql`
    SELECT post_ref FROM hub_posts
     WHERE model_id = ${scope.modelId}::uuid AND account_id = ${scope.accountId}::uuid
       AND post_ref = ANY (${sql.param([...refs])}::text[])`)
  return new Set(rows.map((row) => row.post_ref))
}

// ---------------------------------------------------------------------------
// post_attachments: the set of an affected post is replaced whole
// ---------------------------------------------------------------------------

const ROLES = new Set<string>(values.hubAttachmentRoles)
const LINK_STATES = new Set<string>(values.hubLinkStates)

function slotOf(row: {
  attachment_index: number | null
  member_index: number | null
  role: string | null
}): string {
  return `${row.attachment_index ?? ''}:${row.member_index ?? ''}:${row.role}`
}

export interface ReplaceStats extends MirrorStats {
  posts: number
  removed: number
  /** Posts Hub gave attachments for, but not the post itself: their sets wait. */
  missingPosts: string[]
  /** Two Hub rows in one slot of a post: the first stays, the count goes to the report. */
  slotConflicts: number
}

/**
 * Replaces the attachment sets of the given posts whole: rows Hub no longer gives go, an empty
 * set empties the post (SPEC §8.1). A row that keeps its key and slot keeps its match columns
 * while its meaning holds; a changed row drops them — the matching rebuilds the projection.
 */
export async function replaceAttachments(
  q: Queryable,
  scope: MirrorScope,
  sets: ReadonlyMap<string, readonly DatasetRow<'post_attachments'>[]>,
): Promise<ReplaceStats> {
  const stats: ReplaceStats = {
    rows: 0,
    changed: 0,
    posts: 0,
    removed: 0,
    missingPosts: [],
    slotConflicts: 0,
  }
  if (sets.size === 0) return stats
  // One writer per set: the posts are locked for the replacement.
  const { rows: posts } = await q.execute<{ id: string; post_ref: string }>(sql`
    SELECT id, post_ref FROM hub_posts
     WHERE model_id = ${scope.modelId}::uuid AND account_id = ${scope.accountId}::uuid
       AND post_ref = ANY (${sql.param([...sets.keys()])}::text[])
     ORDER BY id
       FOR UPDATE`)
  const postId = new Map(posts.map((row) => [row.post_ref, row.id]))
  stats.missingPosts = [...sets.keys()].filter((ref) => !postId.has(ref))
  stats.posts = postId.size
  if (postId.size === 0) return stats

  const kept: { postId: string; row: DatasetRow<'post_attachments'> }[] = []
  for (const [ref, rows] of sets) {
    const id = postId.get(ref)
    if (!id) continue
    const slots = new Set<string>()
    const keys = new Set<string>()
    for (const row of rows) {
      const f = row.fields
      const role = f.role ?? ''
      if (!ROLES.has(role)) {
        throw new HubFormatError(
          `в наборе post_attachments новое значение role: ${role || 'пусто'}`,
        )
      }
      const state = f.linkState ?? ''
      if (!LINK_STATES.has(state)) {
        throw new HubFormatError(
          `в наборе post_attachments новое значение linkState: ${state || 'пусто'}`,
        )
      }
      const slot = slotOf({
        attachment_index: int(f.attachmentIndex),
        member_index: int(f.memberIndex),
        role,
      })
      if (keys.has(row.key)) continue
      if (slots.has(slot)) {
        stats.slotConflicts += 1
        continue
      }
      keys.add(row.key)
      slots.add(slot)
      kept.push({ postId: id, row })
    }
  }
  const observed = await observe(
    q,
    scope,
    'post_attachments',
    kept.map((entry) => entry.row),
  )
  Object.assign(stats, count(observed))

  const data = kept.map(({ postId: id, row }) => {
    const f = row.fields
    return {
      post_id: id,
      hub_key: row.key,
      observation_id: observed.get(row.key)?.id,
      attachment_index: int(f.attachmentIndex),
      member_index: int(f.memberIndex),
      position: int(f.pos),
      role: f.role,
      content_type: int(f.contentType),
      content_ref: str(f.contentRef),
      bundle_ref: str(f.bundleRef),
      media_offer_ref: str(f.mediaOfferRef),
      preview_ref: str(f.previewRef),
      media_ref: str(f.mediaRef),
      link_state: f.linkState,
      filename: f.filename,
      mime: f.mimeType,
      duration_ms: int(f.durationMs),
      orig_width: int(f.originalWidth),
      orig_height: int(f.originalHeight),
    }
  })
  const wanted = new Map(data.map((row) => [`${row.post_id}:${row.hub_key}`, slotOf(row)]))
  const { rows: existing } = await q.execute<{
    id: string
    post_id: string
    hub_key: string
    attachment_index: number | null
    member_index: number | null
    role: string
  }>(sql`
    SELECT id, post_id, hub_key, attachment_index, member_index, role FROM hub_post_attachments
     WHERE model_id = ${scope.modelId}::uuid
       AND post_id = ANY (${sql.param([...postId.values()])}::uuid[])`)
  // Gone rows and rows that moved to another slot leave first: a slot is never held twice.
  const gone = existing
    .filter((row) => wanted.get(`${row.post_id}:${row.hub_key}`) !== slotOf(row))
    .map((row) => row.id)
  if (gone.length > 0) {
    await q.execute(sql`
      DELETE FROM hub_post_attachments
       WHERE model_id = ${scope.modelId}::uuid AND id = ANY (${sql.param(gone)}::uuid[])`)
  }
  stats.removed = gone.length
  if (data.length > 0) {
    await q.execute(sql`
      INSERT INTO hub_post_attachments (
        model_id, post_id, hub_key, current_observation_id, attachment_index, member_index,
        position, role, content_type, content_ref, bundle_ref, media_offer_ref, preview_ref,
        media_ref, link_state, filename, mime, duration_ms, orig_width, orig_height, last_seen_at
      )
      SELECT ${scope.modelId}::uuid, x.post_id, x.hub_key, x.observation_id, x.attachment_index,
             x.member_index, x.position, x.role, x.content_type, x.content_ref, x.bundle_ref,
             x.media_offer_ref, x.preview_ref, x.media_ref, x.link_state, x.filename, x.mime,
             x.duration_ms, x.orig_width, x.orig_height, now()
        FROM jsonb_to_recordset(${JSON.stringify(data)}::jsonb) AS x(
          post_id uuid, hub_key text, observation_id uuid, attachment_index integer,
          member_index integer, position integer, role text, content_type integer,
          content_ref text, bundle_ref text, media_offer_ref text, preview_ref text,
          media_ref text, link_state text, filename text, mime text, duration_ms integer,
          orig_width integer, orig_height integer)
      ON CONFLICT ON CONSTRAINT hub_post_attachments_key DO UPDATE
         SET current_observation_id = excluded.current_observation_id,
             position = excluded.position,
             content_type = excluded.content_type,
             content_ref = excluded.content_ref,
             bundle_ref = excluded.bundle_ref,
             media_offer_ref = excluded.media_offer_ref,
             preview_ref = excluded.preview_ref,
             media_ref = excluded.media_ref,
             link_state = excluded.link_state,
             filename = excluded.filename,
             mime = excluded.mime,
             duration_ms = excluded.duration_ms,
             orig_width = excluded.orig_width,
             orig_height = excluded.orig_height,
             last_seen_at = excluded.last_seen_at,
             matched_asset_id = CASE WHEN hub_post_attachments.current_observation_id
                                          = excluded.current_observation_id
                                     THEN hub_post_attachments.matched_asset_id END,
             matched_version_id = CASE WHEN hub_post_attachments.current_observation_id
                                            = excluded.current_observation_id
                                       THEN hub_post_attachments.matched_version_id END,
             receipt_entry_id = CASE WHEN hub_post_attachments.current_observation_id
                                          = excluded.current_observation_id
                                     THEN hub_post_attachments.receipt_entry_id END,
             matched_at = CASE WHEN hub_post_attachments.current_observation_id
                                    = excluded.current_observation_id
                               THEN hub_post_attachments.matched_at END,
             match_strength = CASE WHEN hub_post_attachments.current_observation_id
                                        = excluded.current_observation_id
                                   THEN hub_post_attachments.match_strength ELSE 'none' END`)
  }
  return stats
}

// ---------------------------------------------------------------------------
// raw_media
// ---------------------------------------------------------------------------

export async function mirrorRawMedia(
  q: Queryable,
  scope: MirrorScope,
  rows: readonly DatasetRow<'raw_media'>[],
): Promise<MirrorStats> {
  const kept = [...lastByKey(rows, (row) => str(row.fields.mediaRef)).values()]
  const observed = await observe(q, scope, 'raw_media', kept)
  const data = kept.map((row) => {
    const f = row.fields
    return {
      media_ref: f.mediaRef,
      observation_id: observed.get(row.key)?.id,
      filename: f.filename,
      mime: f.mimeType,
      media_type: int(f.mediaType),
      duration_ms: int(f.durationMs),
      out_width: int(f.width),
      out_height: int(f.height),
      orig_width: int(f.originalWidth),
      orig_height: int(f.originalHeight),
      fps_milli: int(f.frameRateMilli),
      created_at_platform: f.createdAtPlatform,
      origin: f.firstOrigin,
      first_observed_at: f.firstObservedAt,
      row_updated_at: f.rowUpdatedAt,
    }
  })
  if (data.length > 0) {
    await q.execute(sql`
      INSERT INTO hub_raw_media (
        model_id, account_id, media_ref, current_observation_id, filename, mime, media_type,
        duration_ms, out_width, out_height, orig_width, orig_height, fps_milli,
        created_at_platform, origin, first_observed_at, row_updated_at, last_seen_at
      )
      SELECT ${scope.modelId}::uuid, ${scope.accountId}::uuid, x.media_ref, x.observation_id,
             x.filename, x.mime, x.media_type, x.duration_ms, x.out_width, x.out_height,
             x.orig_width, x.orig_height, x.fps_milli, x.created_at_platform, x.origin,
             x.first_observed_at, x.row_updated_at, now()
        FROM jsonb_to_recordset(${JSON.stringify(data)}::jsonb) AS x(
          media_ref text, observation_id uuid, filename text, mime text, media_type integer,
          duration_ms integer, out_width integer, out_height integer, orig_width integer,
          orig_height integer, fps_milli integer, created_at_platform timestamptz, origin text,
          first_observed_at timestamptz, row_updated_at timestamptz)
      ON CONFLICT ON CONSTRAINT hub_raw_media_ref DO UPDATE
         SET current_observation_id = excluded.current_observation_id,
             filename = excluded.filename,
             mime = excluded.mime,
             media_type = excluded.media_type,
             duration_ms = excluded.duration_ms,
             out_width = excluded.out_width,
             out_height = excluded.out_height,
             orig_width = excluded.orig_width,
             orig_height = excluded.orig_height,
             fps_milli = excluded.fps_milli,
             created_at_platform = excluded.created_at_platform,
             origin = excluded.origin,
             first_observed_at = excluded.first_observed_at,
             row_updated_at = excluded.row_updated_at,
             last_seen_at = excluded.last_seen_at`)
  }
  return count(observed)
}

// ---------------------------------------------------------------------------
// vault_media: albums and their members
// ---------------------------------------------------------------------------

export async function mirrorVault(
  q: Queryable,
  scope: MirrorScope,
  rows: readonly DatasetRow<'vault_media'>[],
): Promise<MirrorStats & { albums: number }> {
  // The user vault holds other creators' likes and purchases: never mirrored.
  const own = rows.filter(
    (row) =>
      row.fields.vaultKind !== 'user' && str(row.fields.albumRef) && str(row.fields.memberRef),
  )
  const albums = lastByKey(own, (row) => str(row.fields.albumRef))
  const albumData = [...albums.values()].map((row) => ({
    album_ref: row.fields.albumRef,
    title: row.fields.albumTitle,
    last_full_walk_at: row.fields.lastFullWalkAt,
    full_walk_ref: row.fields.fullWalkRef,
    member_count: int(row.fields.fullWalkObservedCount),
  }))
  if (albumData.length === 0) return { rows: 0, changed: 0, albums: 0 }
  const { rows: albumRows } = await q.execute<{ id: string; album_ref: string }>(sql`
    INSERT INTO hub_vault_albums (
      model_id, account_id, album_ref, title, last_full_walk_at, full_walk_ref, member_count,
      last_seen_at
    )
    SELECT ${scope.modelId}::uuid, ${scope.accountId}::uuid, x.album_ref, x.title,
           x.last_full_walk_at, x.full_walk_ref, x.member_count, now()
      FROM jsonb_to_recordset(${JSON.stringify(albumData)}::jsonb) AS x(
        album_ref text, title text, last_full_walk_at timestamptz, full_walk_ref text,
        member_count integer)
    ON CONFLICT ON CONSTRAINT hub_vault_albums_ref DO UPDATE
       SET title = excluded.title,
           last_full_walk_at = excluded.last_full_walk_at,
           full_walk_ref = excluded.full_walk_ref,
           member_count = excluded.member_count,
           last_seen_at = excluded.last_seen_at
    RETURNING id, album_ref`)
  const albumId = new Map(albumRows.map((row) => [row.album_ref, row.id]))
  const members = [
    ...lastByKey(own, (row) => `${row.fields.albumRef}\u0000${row.fields.memberRef}`).values(),
  ]
  const observed = await observe(q, scope, 'vault_media', members)
  const data = members.map((row) => {
    const f = row.fields
    return {
      album_id: albumId.get(f.albumRef ?? ''),
      member_ref: f.memberRef,
      observation_id: observed.get(row.key)?.id,
      media_ref: str(f.mediaRef),
      media_offer_ref: str(f.mediaOfferRef),
      custom_filename: f.customFilename,
      filename: f.filename,
      mime: f.mimeType,
      media_type: int(f.mediaType),
      duration_ms: int(f.durationMs),
      orig_width: int(f.originalWidth),
      orig_height: int(f.originalHeight),
      created_at_platform: f.createdAtPlatform,
      // Hub's event time of a membership row is its first sighting in the album.
      membership_at: row.occurredAt ?? f.firstObservedAt,
      missing_since: f.missingSince,
      first_observed_at: f.firstObservedAt,
      last_observed_at: f.lastObservedAt,
      row_updated_at: f.rowUpdatedAt,
    }
  })
  await q.execute(sql`
    INSERT INTO hub_vault_media (
      model_id, account_id, album_id, member_ref, current_observation_id, media_ref,
      media_offer_ref, custom_filename, filename, mime, media_type, duration_ms, orig_width,
      orig_height, created_at_platform, membership_at, missing_since, first_observed_at,
      last_observed_at, row_updated_at, last_seen_at
    )
    SELECT ${scope.modelId}::uuid, ${scope.accountId}::uuid, x.album_id, x.member_ref,
           x.observation_id, x.media_ref, x.media_offer_ref, x.custom_filename, x.filename,
           x.mime, x.media_type, x.duration_ms, x.orig_width, x.orig_height,
           x.created_at_platform, x.membership_at, x.missing_since, x.first_observed_at,
           x.last_observed_at, x.row_updated_at, now()
      FROM jsonb_to_recordset(${JSON.stringify(data)}::jsonb) AS x(
        album_id uuid, member_ref text, observation_id uuid, media_ref text,
        media_offer_ref text, custom_filename text, filename text, mime text,
        media_type integer, duration_ms integer, orig_width integer, orig_height integer,
        created_at_platform timestamptz, membership_at timestamptz, missing_since timestamptz,
        first_observed_at timestamptz, last_observed_at timestamptz, row_updated_at timestamptz)
    ON CONFLICT ON CONSTRAINT hub_vault_media_member DO UPDATE
       SET current_observation_id = excluded.current_observation_id,
           media_ref = excluded.media_ref,
           media_offer_ref = excluded.media_offer_ref,
           custom_filename = excluded.custom_filename,
           filename = excluded.filename,
           mime = excluded.mime,
           media_type = excluded.media_type,
           duration_ms = excluded.duration_ms,
           orig_width = excluded.orig_width,
           orig_height = excluded.orig_height,
           created_at_platform = excluded.created_at_platform,
           membership_at = excluded.membership_at,
           missing_since = excluded.missing_since,
           first_observed_at = excluded.first_observed_at,
           last_observed_at = excluded.last_observed_at,
           row_updated_at = excluded.row_updated_at,
           last_seen_at = excluded.last_seen_at`)
  return { ...count(observed), albums: albumId.size }
}
