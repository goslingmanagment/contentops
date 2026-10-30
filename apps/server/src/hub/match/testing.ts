import { randomBytes, randomUUID } from 'node:crypto'
import type { NewPlanRow } from '@contentops/contracts/commands/plan'
import { type PlanRow, PlanRowSchema } from '@contentops/contracts/domain/plan'
import { type Db, SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { fakeRow } from '@contentops/hub/testing'
import { sql } from 'drizzle-orm'
import { expect } from 'vitest'
import { call, newKey, type TestServer } from '../../testing/server'
import type { PageIds } from '../testing'

/**
 * Helpers of the matching tests: switches, thresholds, issued names and fake Hub rows. All refs,
 * names and captions are fictional.
 */

const tx = <T>(db: Db, fn: Parameters<typeof withActorTx<T>>[2]) =>
  withActorTx(db, { actor: SYSTEM_ACTOR('test'), action: 'test', requestId: randomUUID() }, fn)

export async function setSwitch(db: Db, page: PageIds, key: string, on: boolean): Promise<void> {
  await tx(db, (t) =>
    t.execute(sql`
      INSERT INTO policy_settings (model_id, account_id, key, value)
      VALUES (${page.modelId}::uuid, ${page.accountId}::uuid, ${key}, ${JSON.stringify(on)}::jsonb)
      ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE
         SET value = excluded.value, updated_at = now()`),
  )
}

/** A global setting of `policy_settings` (schema key), `null` removes it. */
export async function setPolicy(
  db: Db,
  key: string,
  value: unknown,
  page?: PageIds,
): Promise<void> {
  await tx(db, async (t) => {
    await t.execute(sql`
      DELETE FROM policy_settings
       WHERE key = ${key} AND item_type IS NULL
         AND model_id IS NOT DISTINCT FROM ${page?.modelId ?? null}::uuid
         AND account_id IS NOT DISTINCT FROM ${page?.accountId ?? null}::uuid`)
    if (value === null) return
    await t.execute(sql`
      INSERT INTO policy_settings (model_id, account_id, key, value)
      VALUES (${page?.modelId ?? null}::uuid, ${page?.accountId ?? null}::uuid, ${key},
              ${JSON.stringify(value)}::jsonb)`)
  })
}

export async function putRows(
  server: TestServer,
  as: string,
  rows: Partial<NewPlanRow>[],
): Promise<PlanRow[]> {
  const response = await call(server.app, {
    method: 'POST',
    url: '/api/v1/lora/plan/rows',
    as,
    key: newKey(),
    body: {
      rows: rows.map((patch) => ({
        item_id: 'SET-074',
        account: 'lora-1',
        surface: 'wall',
        date: '2026-10-29',
        time: '20:00',
        fyp_version: null,
        assignee: null,
        note: null,
        requires_new_upload: false,
        awaiting_montage: null,
        marked: null,
        ...patch,
      })),
    },
  })
  expect(response.statusCode, response.body).toBe(201)
  return response.json().rows.map((one: unknown) => PlanRowSchema.parse(one))
}

export interface ManifestFile {
  assetId: string
  versionId: string
  role: string
  ordinal: number | null
  durationMs: number | null
  width: number | null
  height: number | null
  manifestId: string
}

/** The sealed files of a plan row in their order. */
export async function rowFiles(db: Db, rowId: string): Promise<ManifestFile[]> {
  const { rows } = await db.execute<{
    asset_id: string
    version_id: string
    role: string
    ordinal: number | null
    duration_ms: string | null
    width: number | null
    height: number | null
    manifest_id: string
  }>(sql`
    SELECT e.asset_id, e.asset_version_id AS version_id, m.role, m.ordinal,
           v.duration_ms::text AS duration_ms, v.width, v.height, r.manifest_id
      FROM posting_plan_rows r
      JOIN asset_manifest_entries e ON e.model_id = r.model_id AND e.manifest_id = r.manifest_id
      JOIN asset_versions v ON v.model_id = e.model_id AND v.id = e.asset_version_id
      LEFT JOIN item_memberships m ON m.model_id = e.model_id AND m.id = e.membership_id
     WHERE r.id = ${rowId}::uuid
     ORDER BY e.position`)
  return rows.map((row) => ({
    assetId: row.asset_id,
    versionId: row.version_id,
    role: row.role,
    ordinal: row.ordinal,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    width: row.width,
    height: row.height,
    manifestId: row.manifest_id,
  }))
}

/**
 * A download receipt of files under the given names, as `media.download` writes it: the name of
 * the issued file and the length and size of what went out (schema §3.5).
 */
export async function issue(
  db: Db,
  input: {
    modelId: string
    principalId: string
    manifestId: string
    planRowId?: string | null
    files: {
      assetId: string
      versionId: string
      name: string
      durationMs: number | null
      width: number
      height: number
    }[]
  },
): Promise<string[]> {
  return tx(db, async (t) => {
    const { rows } = await t.execute<{ id: string }>(sql`
      INSERT INTO download_receipts (model_id, principal_id, kind, manifest_id, meta_stripped,
                                     entry_count, plan_row_id)
      VALUES (${input.modelId}::uuid, ${input.principalId}::uuid, 'platform',
              ${input.manifestId}::uuid, true, ${input.files.length}, ${input.planRowId ?? null}::uuid)
      RETURNING id`)
    const receipt = (rows[0] as { id: string }).id
    const ids: string[] = []
    for (const [index, file] of input.files.entries()) {
      const { rows: entry } = await t.execute<{ id: string }>(sql`
        INSERT INTO download_receipt_entries (model_id, receipt_id, position, asset_id,
                                              asset_version_id, issued_master, file_name,
                                              output_sha256, byte_size, duration_ms, width, height)
        VALUES (${input.modelId}::uuid, ${receipt}::uuid, ${index + 1}, ${file.assetId}::uuid,
                ${file.versionId}::uuid, true, ${file.name}, ${randomBytes(32)}, 1000,
                ${file.durationMs}, ${file.width}, ${file.height})
        RETURNING id`)
      ids.push((entry[0] as { id: string }).id)
    }
    return ids
  })
}

const HOUR = 3_600_000

/** A fictional post of a page. */
export function hubPost(
  ref: string,
  publishedAt: string,
  options: { caption?: string; files?: number; fypFlags?: number; platform?: string } = {},
) {
  return fakeRow('posts', ref, {
    platform: options.platform ?? 'fansly',
    postRef: ref,
    postText: options.caption ?? `Test caption ${ref}`,
    publishedAt,
    firstObservedAt: new Date(Date.parse(publishedAt) + 2 * HOUR).toISOString(),
    lastObservedAt: new Date(Date.parse(publishedAt) + 3 * HOUR).toISOString(),
    attachmentCount: options.files ?? 1,
    fypFlags: options.fypFlags ?? 0,
    wallRefs: [],
  })
}

export interface FakeFile {
  media: string
  name?: string | null
  video?: boolean
  durationMs?: number | null
  width?: number | null
  height?: number | null
  role?: 'main' | 'offer_preview'
  contentType?: number
  linkState?: string
  member?: number | null
}

/** Attachment rows of a post: one per file, a bundle when `member` is given. */
export function hubFiles(
  postRef: string,
  publishedAt: string,
  files: readonly FakeFile[],
  platform = 'fansly',
) {
  return files.map((file, index) => {
    const role = file.role ?? 'main'
    const attachmentIndex = file.member != null ? 0 : index
    return fakeRow(
      'post_attachments',
      `${postRef}:${attachmentIndex}:${file.member ?? ''}:${role}`,
      {
        platform,
        postRef,
        publishedAt,
        attachmentIndex,
        pos: index,
        contentType: file.contentType ?? (file.member != null ? 2 : 1),
        contentRef: `content-${postRef}-${attachmentIndex}`,
        role,
        memberIndex: file.member ?? null,
        bundleRef: file.member != null ? `bundle-${postRef}` : null,
        mediaOfferRef: `offer-${file.media}`,
        mediaRef: file.media,
        linkState: file.linkState ?? 'resolved',
        filename: file.name ?? null,
        mimeType: file.video === false ? 'image/jpeg' : 'video/mp4',
        durationMs: file.video === false ? null : (file.durationMs ?? 9_000),
        originalWidth: 'width' in file ? (file.width ?? null) : 1080,
        originalHeight: 'height' in file ? (file.height ?? null) : 1920,
      },
    )
  })
}

/** Views from For You of a file on a day (`creator_stats_media_daily`, source 0). */
export function forYou(media: string, day: string, views: number, source = 0) {
  return fakeRow('creator_stats_media_daily', `offer-${media}:${media}:${source}:${day}`, {
    platform: 'fansly',
    mediaOfferId: `offer-${media}`,
    mediaId: media,
    source,
    sourceLabel: source === 0 ? 'For You' : 'Feed',
    day,
    views,
    capturedAt: new Date().toISOString(),
  })
}

export function likes(media: string, day: string, n: number) {
  return fakeRow('creator_stats_media_likes', `offer-${media}:1:${day}`, {
    platform: 'fansly',
    mediaOfferId: `offer-${media}`,
    source: 1,
    day,
    likes: n,
    unlikes: 0,
    capturedAt: new Date().toISOString(),
  })
}

/** A file in a named album of the creator's vault. */
export function vaultFile(
  albumRef: string,
  title: string,
  memberRef: string,
  media: string,
  options: {
    name?: string | null
    walkedAt: string
    membershipAt?: string
    durationMs?: number | null
    width?: number
    height?: number
    video?: boolean
    createdAt?: string | null
    missingSince?: string | null
  },
) {
  return fakeRow('vault_media', `${albumRef}:${memberRef}`, {
    platform: 'fansly',
    vaultKind: 'creator',
    albumRef,
    albumTitle: title,
    lastFullWalkAt: options.walkedAt,
    fullWalkRef: `walk-${albumRef}`,
    fullWalkObservedCount: 1,
    customFilename: options.name ?? null,
    filename: options.name ?? `${media}.bin`,
    mimeType: options.video === false ? 'image/jpeg' : 'video/mp4',
    durationMs: options.video === false ? null : (options.durationMs ?? 9_000),
    originalWidth: options.width ?? 1080,
    originalHeight: options.height ?? 1920,
    mediaRef: media,
    mediaOfferRef: `offer-${media}`,
    memberRef,
    mediaType: options.video === false ? 1 : 2,
    createdAtPlatform: options.createdAt ?? null,
    missingSince: options.missingSince ?? null,
    firstObservedAt: options.membershipAt ?? options.walkedAt,
  })
}

export interface PlacementRow {
  id: string
  surface: string
  surface_source: string
  external_post_ref: string | null
  external_album_ref: string | null
  external_media_ref: string | null
  manual_key: string | null
  item_id: string | null
  plan_row_id: string | null
  out_of_catalog: boolean
  views: string | null
  likes: string | null
}

export async function placementsOf(db: Db, page: PageIds): Promise<PlacementRow[]> {
  const { rows } = await db.execute<PlacementRow & Record<string, unknown>>(sql`
    SELECT p.id, s.kind AS surface, p.surface_source, p.external_post_ref, p.external_album_ref,
           p.external_media_ref, p.manual_key, p.item_id, p.plan_row_id, p.out_of_catalog,
           p.views::text AS views, p.likes::text AS likes
      FROM placements p JOIN surfaces s ON s.model_id = p.model_id AND s.id = p.surface_id
     WHERE p.account_id = ${page.accountId}::uuid
     ORDER BY p.created_at, p.id`)
  return rows
}

export interface EvidenceRow {
  id: string
  placement_id: string
  source: string
  kind: string
  strength: string | null
  dedup_key: string
  corrects_id: string | null
  payload: Record<string, unknown>
}

export async function evidenceOf(db: Db, placementIds: readonly string[]): Promise<EvidenceRow[]> {
  if (placementIds.length === 0) return []
  const { rows } = await db.execute<EvidenceRow & Record<string, unknown>>(sql`
    SELECT id, placement_id, source, kind, strength, dedup_key, corrects_id, payload
      FROM placement_evidence WHERE placement_id = ANY (${sql.param([...placementIds])}::uuid[])
     ORDER BY recorded_at, id`)
  return rows
}
