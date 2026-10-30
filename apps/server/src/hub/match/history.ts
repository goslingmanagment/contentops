import type { Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import {
  type HubPostFacts,
  loadPlacements,
  loadPosts,
  loadVault,
  type Page,
  publicationLinks,
} from './load'
import { sameSize } from './names'
import { hintSurface, hubSurface } from './rules'
import type { MatchSettings } from './settings'
import { addEvidence, claimPlacement, lockPage, publicationPlacement, surfaceIdOf } from './write'

/**
 * The history pass of a Fansly page (SPEC §7, PLAN 5): Hub's posts and vault files from before
 * the start of matching are matched once with the catalog, without a plan — by the old name of
 * the file, by duration and size. A single match is a candidate without plan
 * (`cand:hist:<asset>:<observation>`): it takes the object out of «ещё не залито» and gives a
 * date for «слишком рано»; disputed ones wait until the object is planned again; the rest stay
 * «неизвестно», their count is in the report. Photos by size alone are only a hint. It runs when
 * «Автосверка» is first switched on and again after each batch of the library. OnlyFans has no
 * names — no pass there.
 */

export interface HistoryReport {
  posts: number
  candidates: number
  unknown: number
  disputed: number
  photo_hints: number
  vault_files: number
  vault_candidates: number
  vault_unknown: number
}

interface Shape {
  assetId: string
  versionId: string
  itemId: string
  isVideo: boolean
  durationMs: number | null
  width: number | null
  height: number | null
}

/** Names of the catalog's files before ContentOps: legacy names and the names on the disk. */
async function oldNames(
  tx: Tx,
  page: Page,
  stems: readonly string[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  const wanted = [...new Set(stems.filter((stem) => stem && !stem.includes('?')))]
  if (wanted.length === 0) return out
  const { rows } = await tx.execute<{ stem: string; asset_id: string }>(sql`
    WITH names AS (
      SELECT value_raw AS name, asset_id FROM aliases
       WHERE model_id = ${page.modelId}::uuid AND kind IN ('legacy_name', 'legacy_path')
         AND asset_id IS NOT NULL
      UNION
      SELECT o.current_name, a.asset_id FROM aliases a
        JOIN source_objects o ON o.model_id = a.model_id AND o.id = a.source_object_id
       WHERE a.model_id = ${page.modelId}::uuid AND a.asset_id IS NOT NULL
    )
    SELECT DISTINCT lower(regexp_replace(regexp_replace(normalize(name, NFC), '^.*/', ''), '\\.[^./]*$', '')) AS stem,
           asset_id
      FROM names
     WHERE lower(regexp_replace(regexp_replace(normalize(name, NFC), '^.*/', ''), '\\.[^./]*$', ''))
           = ANY (${sql.param(wanted)}::text[])`)
  for (const row of rows) {
    const set = out.get(row.stem) ?? new Set<string>()
    set.add(row.asset_id)
    out.set(row.stem, set)
  }
  return out
}

/** Current versions of the model's live files with their length and size. */
async function shapes(tx: Tx, page: Page): Promise<Shape[]> {
  const { rows } = await tx.execute<{
    asset_id: string
    version_id: string
    item_id: string
    media_kind: 'video' | 'image'
    duration_ms: string | null
    width: number | null
    height: number | null
  }>(sql`
    SELECT a.id AS asset_id, v.id AS version_id, a.created_in_item_id AS item_id, a.media_kind,
           v.duration_ms::text AS duration_ms, v.width, v.height
      FROM assets a
      JOIN asset_versions v ON v.model_id = a.model_id AND v.id = a.current_version_id
      JOIN content_items i ON i.model_id = a.model_id AND i.id = a.created_in_item_id
     WHERE a.model_id = ${page.modelId}::uuid AND i.deleted_at IS NULL AND i.type <> 'RAW'`)
  return rows.map((row) => ({
    assetId: row.asset_id,
    versionId: row.version_id,
    itemId: row.item_id,
    isVideo: row.media_kind === 'video',
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    width: row.width,
    height: row.height,
  }))
}

const stemOf = (name: string | null) =>
  name
    ? name
        .normalize('NFC')
        .replace(/^.*\//, '')
        .replace(/\.[^./]*$/, '')
        .toLowerCase()
    : ''

interface FileFacts {
  filename: string | null
  isVideo: boolean
  durationMs: number | null
  width: number | null
  height: number | null
}

type Found = { kind: 'name' | 'shape'; assets: Shape[] } | { kind: 'photo_hint' } | null

/** What the catalog says about one platform file: by the old name, else by length and size. */
function findFile(
  file: FileFacts,
  names: ReadonlyMap<string, ReadonlySet<string>>,
  byAsset: ReadonlyMap<string, Shape>,
  all: readonly Shape[],
  durationMs: number | null,
): Found {
  const named = names.get(stemOf(file.filename))
  if (named && named.size > 0) {
    const assets = [...named].flatMap((id) => byAsset.get(id) ?? [])
    if (assets.length > 0) return { kind: 'name', assets }
  }
  if (file.isVideo) {
    if (durationMs === null || file.durationMs === null) return null
    const assets = all.filter(
      (shape) =>
        shape.isVideo &&
        shape.durationMs !== null &&
        Math.abs(shape.durationMs - (file.durationMs as number)) <= durationMs &&
        sameSize(shape, file) === true,
    )
    return assets.length > 0 ? { kind: 'shape', assets } : null
  }
  // A photo matching only by size is a hint, not a candidate (SPEC §7).
  return all.some((shape) => !shape.isVideo && sameSize(shape, file) === true)
    ? { kind: 'photo_hint' }
    : null
}

/** One object for every matched file: the post is that object's candidate; else disputed. */
function verdictOf(
  found: readonly Found[],
): { itemId: string; assets: Shape[] } | 'disputed' | null {
  const matched = found.filter(
    (entry): entry is { kind: 'name' | 'shape'; assets: Shape[] } =>
      entry !== null && entry.kind !== 'photo_hint',
  )
  if (matched.length === 0) return null
  const items = new Set(matched.flatMap((entry) => entry.assets.map((asset) => asset.itemId)))
  if (items.size !== 1) return 'disputed'
  const assets = new Map<string, Shape>()
  for (const entry of matched) {
    // One file — one asset; two assets of one object for one file stay a dispute.
    if (new Set(entry.assets.map((asset) => asset.assetId)).size !== 1) return 'disputed'
    const [asset] = entry.assets
    if (asset) assets.set(asset.assetId, asset)
  }
  return { itemId: [...items][0] as string, assets: [...assets.values()] }
}

export async function historyPass(
  tx: Tx,
  page: Page,
  options: { liveFrom: string; settings: MatchSettings; workId?: string | null },
): Promise<HistoryReport> {
  const report: HistoryReport = {
    posts: 0,
    candidates: 0,
    unknown: 0,
    disputed: 0,
    photo_hints: 0,
    vault_files: 0,
    vault_candidates: 0,
    vault_unknown: 0,
  }
  if (page.platform !== 'fansly') return report
  await lockPage(tx, page.accountId)
  const links = await publicationLinks(tx, page)
  const placements = await loadPlacements(tx, page)
  const linkedPosts = new Set(
    placements.flatMap((placement) => (placement.postRef ? [placement.postRef] : [])),
  )
  const linkedMembers = new Set(
    placements.flatMap((placement) =>
      placement.albumRef && placement.mediaRef
        ? [`${placement.albumRef}|${placement.mediaRef}`]
        : [],
    ),
  )
  const posts = (
    await loadPosts(tx, page, sql`p.published_at < ${options.liveFrom}::timestamptz`)
  ).filter((post) => !linkedPosts.has(post.ref) && !links.refs.has(post.ref))
  const { members } = await loadVault(tx, page)
  const vault = members.filter(
    (member) =>
      member.mediaRef !== null &&
      member.missingSince === null &&
      !links.albums.has(member.albumRef) &&
      (member.membershipAt === null || member.membershipAt < options.liveFrom) &&
      !linkedMembers.has(`${member.albumRef}|${member.mediaRef}`),
  )
  const all = await shapes(tx, page)
  const byAsset = new Map(all.map((shape) => [shape.assetId, shape]))
  const names = await oldNames(tx, page, [
    ...posts.flatMap((post) => post.mains.map((file) => stemOf(file.filename))),
    ...vault.map((member) => stemOf(member.filename)),
  ])
  const durationMs = options.settings.durationMs

  for (const post of posts) {
    report.posts += 1
    const found = post.mains.map((file) => findFile(file, names, byAsset, all, durationMs))
    const verdict = verdictOf(found)
    if (verdict === 'disputed') {
      report.disputed += 1
      report.unknown += 1
      continue
    }
    if (!verdict) {
      if (found.some((entry) => entry?.kind === 'photo_hint')) report.photo_hints += 1
      report.unknown += 1
      continue
    }
    report.candidates += 1
    await writeCandidate(tx, page, post, verdict, found)
  }

  for (const member of vault) {
    report.vault_files += 1
    const found = findFile(member, names, byAsset, all, durationMs)
    const verdict = verdictOf([found])
    if (!verdict || verdict === 'disputed') {
      report.vault_unknown += 1
      continue
    }
    report.vault_candidates += 1
    const asset = verdict.assets[0] as Shape
    const placementId = await publicationPlacement(tx, page, {
      surface: 'vault',
      surfaceSource: 'hub',
      refs: { kind: 'vault', albumRef: member.albumRef, mediaRef: member.mediaRef as string },
      itemId: verdict.itemId,
      planRowId: null,
      occurredAt: member.membershipAt,
      origin: 'hub',
    })
    await addEvidence(tx, page, {
      placementId,
      source: 'hub',
      kind: 'observed',
      strength: 'candidate',
      observationId: member.observationId,
      externalRef: member.mediaRef,
      matchedAssetId: asset.assetId,
      matchedVersionId: asset.versionId,
      payload: {
        kind: 'history',
        by: found?.kind === 'name' ? 'name' : 'shape',
        album_ref: member.albumRef,
        album_title: member.albumTitle,
        file_name: member.filename,
        published_at: member.membershipAt,
      },
      eventAt: member.membershipAt,
      dedupKey: `cand:hist:${asset.assetId}:${member.observationId}`,
    })
  }
  return report
}

async function writeCandidate(
  tx: Tx,
  page: Page,
  post: HubPostFacts,
  verdict: { itemId: string; assets: Shape[] },
  found: readonly Found[],
): Promise<void> {
  const proven = hubSurface(post, page.platform)
  const surface = proven ?? hintSurface(post)
  const surfaceId = await surfaceIdOf(tx, page, surface)
  const day = new Date(post.publishedAt).toLocaleDateString('sv-SE', { timeZone: page.timezone })
  // A legacy claim of the object on this page, surface and day takes the candidate into its
  // history; the external ID is written only by an exact match or a confirmed pair (SPEC §7).
  const claim = await claimPlacement(tx, page, { itemId: verdict.itemId, surfaceId, day })
  const placementId =
    claim ??
    (await publicationPlacement(tx, page, {
      surface,
      surfaceSource: proven ? 'hub' : 'hub_hint',
      refs: { kind: 'post', postRef: post.ref },
      itemId: verdict.itemId,
      planRowId: null,
      occurredAt: post.publishedAt,
      origin: 'hub',
    }))
  const matched = found.filter((entry) => entry && entry.kind !== 'photo_hint').length
  for (const [index, file] of post.mains.entries()) {
    const entry = found[index]
    if (!entry || entry.kind === 'photo_hint') continue
    const asset = entry.assets[0] as Shape
    await addEvidence(tx, page, {
      placementId,
      source: 'hub',
      kind: 'observed',
      strength: 'candidate',
      observationId: file.observationId,
      externalRef: post.ref,
      matchedAssetId: asset.assetId,
      matchedVersionId: asset.versionId,
      payload: {
        kind: 'history',
        by: entry.kind,
        post_ref: post.ref,
        post_id: post.id,
        published_at: post.publishedAt,
        file_name: file.filename,
        matched,
        total: post.mains.length,
      },
      eventAt: post.publishedAt,
      dedupKey: `cand:hist:${asset.assetId}:${file.observationId}`,
    })
  }
}
