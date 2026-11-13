import type { Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import {
  buildCatalog,
  type Catalog,
  type CatalogFile,
  type CheckOptions,
  type Found,
  findFile,
  isMatched,
  localDay,
  type PlatformFile,
  verdictOf,
} from './history-rules'
import {
  type EvidenceFact,
  type HubFile,
  type HubPostFacts,
  loadPlacements,
  loadPosts,
  loadVault,
  type Page,
  type PlacementFact,
  publicationLinks,
  type VaultMember,
} from './load'
import { handleKey } from './names'
import { hintSurface, hubSurface } from './rules'
import type { MatchSettings } from './settings'
import {
  addEvidence,
  claimPlacement,
  lockPage,
  type PlacementTarget,
  placementByRefs,
  publicationPlacement,
  type Refs,
  setPlacementItem,
  surfaceIdOf,
} from './write'

/**
 * The history pass of a Fansly page (SPEC §7, PLAN 5): Hub's posts and vault files from before
 * the start of matching are matched with the catalog without a plan, by the name of the file
 * (`history-rules.ts`). A single match is a candidate without plan
 * (`cand:hist:<asset>`): it takes the object out of «ещё не залито» and gives a
 * date for «слишком рано»; disputed ones wait until the object is planned again; the rest stay
 * «неизвестно», their count is in the report. It runs when «Автосверка» is first switched on and
 * again after each batch of the library, and every run reviews the pass's own earlier
 * candidates: one the rules no longer give is taken back (`retract`), the post is free again.
 * A placement with anything else on it — a person's decision, an exact match, a plan row — is
 * not the pass's to touch. OnlyFans has no names — no pass there.
 */

export interface HistoryReport {
  posts: number
  candidates: number
  unknown: number
  disputed: number
  photo_hints: number
  /** Posts with a video of the same length and size and no name: a hint, no candidate. */
  shape_hints: number
  /** Files whose name matched only files of the catalog that cannot be them. */
  rejected: { kind: number; date: number; duration: number }
  vault_files: number
  vault_candidates: number
  vault_unknown: number
  /** The pass's own earlier candidates taken back by this run. */
  retracted: number
  /** Placements of the pass left without an object: nothing of the pass stands on them. */
  released: number
}

const HISTORY_KEY = 'cand:hist:'

/** The current files of the model's live objects, RAW too, with their names and handles. */
async function loadCatalog(tx: Tx, page: Page): Promise<Catalog> {
  const tz = page.timezone
  const { rows } = await tx.execute<{
    asset_id: string
    version_id: string
    item_id: string
    item_type: string
    item_number: number
    role: string
    ordinal: number | null
    variant_no: number
    media_kind: 'video' | 'image'
    duration_ms: string | null
    width: number | null
    height: number | null
    master: string
    source: string | null
    shot_day: string | null
  }>(sql`
    SELECT m.asset_id, v.id AS version_id, m.item_id, i.type AS item_type,
           i.number AS item_number, m.role, m.ordinal, m.variant_no, a.media_kind,
           v.duration_ms::text AS duration_ms, v.width, v.height,
           encode(v.master_sha256, 'hex') AS master, encode(v.source_sha256, 'hex') AS source,
           coalesce(
             (SELECT min(coalesce(p.shot_at_local::date, (p.shot_at AT TIME ZONE ${tz}::text)::date))
                FROM blob_probes p
               WHERE p.sha256 = coalesce(v.source_sha256, v.master_sha256)
                 AND coalesce(p.shot_at_local, p.shot_at AT TIME ZONE ${tz}::text)
                     BETWEEN timestamp '2015-01-01'
                         AND (now() AT TIME ZONE ${tz}::text) + interval '1 day'),
             (SELECT (r.remote_shot_at AT TIME ZONE ${tz}::text)::date FROM source_revisions r
               WHERE r.model_id = v.model_id AND r.id = v.source_revision_id
                 AND r.remote_shot_at BETWEEN timestamptz '2015-01-01' AND now() + interval '1 day'),
             i.shot_on)::text AS shot_day
      FROM item_memberships m
      JOIN content_items i ON i.model_id = m.model_id AND i.id = m.item_id AND i.deleted_at IS NULL
      JOIN assets a ON a.model_id = m.model_id AND a.id = m.asset_id AND a.retired_at IS NULL
      JOIN asset_versions v ON v.model_id = a.model_id AND v.id = a.current_version_id
     WHERE m.model_id = ${page.modelId}::uuid AND m.kind = 'owned' AND m.removed_at IS NULL`)
  const files: CatalogFile[] = rows.map((row) => ({
    assetId: row.asset_id,
    versionId: row.version_id,
    itemId: row.item_id,
    itemType: row.item_type,
    blobs: [...new Set([row.master, ...(row.source ? [row.source] : [])])],
    isVideo: row.media_kind === 'video',
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    width: row.width,
    height: row.height,
    shotDay: row.shot_day,
  }))
  const { rows: names } = await tx.execute<{ asset_id: string; name: string }>(sql`
    SELECT asset_id, value_raw AS name FROM aliases
     WHERE model_id = ${page.modelId}::uuid AND kind IN ('legacy_name', 'legacy_path')
       AND asset_id IS NOT NULL
    UNION
    SELECT a.asset_id, o.current_name FROM aliases a
      JOIN source_objects o ON o.model_id = a.model_id AND o.id = a.source_object_id
     WHERE a.model_id = ${page.modelId}::uuid AND a.asset_id IS NOT NULL`)
  // A moved file keeps the handle it had (`sub_handle` `SXT-010/clip07`): old names point there.
  const { rows: moved } = await tx.execute<{ asset_id: string; value: string }>(sql`
    SELECT asset_id, value_raw AS value FROM aliases
     WHERE model_id = ${page.modelId}::uuid AND kind = 'sub_handle' AND asset_id IS NOT NULL`)
  const handles = [
    ...rows.map((row) => ({
      key: handleKey(`${row.item_type}-${row.item_number}`, row.role, row.ordinal, row.variant_no),
      assetId: row.asset_id,
    })),
    ...moved.map((row) => {
      const [, id, handle] = /^([A-Za-z]+-\d+)\/([a-z]+\d*)$/.exec(row.value) ?? []
      const parsed = handle ? /^([a-z]+?)(\d*)$/.exec(handle) : null
      const variant = parsed?.[1] === 'u' ? parsed[2] : null
      return {
        key:
          id && parsed
            ? handleKey(id, parsed[1] as string, parsed[2] ? Number(parsed[2]) : null, variant)
            : null,
        assetId: row.asset_id,
      }
    }),
  ].flatMap((entry) => (entry.key ? [{ key: entry.key, assetId: entry.assetId }] : []))
  return buildCatalog(
    files,
    names.map((row) => ({ assetId: row.asset_id, name: row.name })),
    handles,
  )
}

const earliest = (...moments: (string | null)[]) =>
  moments
    .filter((at): at is string => at !== null)
    .sort()
    .at(0) ?? null

function postFile(post: HubPostFacts, file: HubFile): PlatformFile {
  return {
    names: [file.filename],
    isVideo: file.isVideo,
    durationMs: file.durationMs,
    width: file.width,
    height: file.height,
    seenAt: earliest(post.publishedAt, file.createdAtPlatform),
  }
}

/**
 * A file of a named album: the card's caption and the uploaded file's name; the platform had it
 * from its upload (`createdAt` on Fansly) — the album membership is only Hub's first walk.
 */
function memberFile(member: VaultMember): PlatformFile {
  return {
    names: [member.filename, member.uploadName],
    isVideo: member.isVideo,
    durationMs: member.durationMs,
    width: member.width,
    height: member.height,
    seenAt: earliest(member.createdAtPlatform, member.membershipAt),
  }
}

/** Evidence the pass writes or reads as its own. */
function isPassEvidence(entry: EvidenceFact): boolean {
  if (entry.kind === 'observed') return entry.dedupKey.startsWith(HISTORY_KEY)
  if (entry.kind === 'retract') return entry.payload.kind === 'history_retract'
  return entry.kind === 'legacy_claim'
}

/** A placement only the pass and legacy import wrote: the pass may review it. */
function isOwn(placement: PlacementFact): boolean {
  return placement.planRowId === null && placement.evidence.every(isPassEvidence)
}

interface Prior {
  id: string
  placementId: string
  subject: string
  assetId: string | null
  observationId: string | null
}

/** The pass's earlier candidates on the page, by the post or the vault file they are about. */
async function priorCandidates(tx: Tx, page: Page): Promise<Prior[]> {
  const { rows } = await tx.execute<{
    id: string
    placement_id: string
    external_ref: string | null
    matched_asset_id: string | null
    hub_observation_id: string | null
    post_ref: string | null
    album_ref: string | null
  }>(sql`
    SELECT e.id, e.placement_id, e.external_ref, e.matched_asset_id, e.hub_observation_id,
           e.payload ->> 'post_ref' AS post_ref, e.payload ->> 'album_ref' AS album_ref
      FROM placement_evidence e
      JOIN placements p ON p.model_id = e.model_id AND p.id = e.placement_id
     WHERE e.model_id = ${page.modelId}::uuid AND p.account_id = ${page.accountId}::uuid
       AND e.kind = 'observed' AND e.dedup_key LIKE ${`${HISTORY_KEY}%`}`)
  return rows.flatMap((row) => {
    const subject = row.post_ref
      ? `post:${row.post_ref}`
      : row.album_ref && row.external_ref
        ? `vault:${row.album_ref}|${row.external_ref}`
        : null
    return subject
      ? [
          {
            id: row.id,
            placementId: row.placement_id,
            subject,
            assetId: row.matched_asset_id,
            observationId: row.hub_observation_id,
          },
        ]
      : []
  })
}

/** A candidate the pass wants on a placement: one evidence per matched platform file. */
interface Wanted {
  itemId: string
  /** A legacy claim of the object takes the candidate into its history (SPEC §7). */
  claimId: string | null
  /** The placement of the publication already there. */
  existingId: string | null
  target: PlacementTarget & { refs: Refs }
  evidence: {
    asset: CatalogFile
    observationId: string
    externalRef: string | null
    eventAt: string | null
    payload: Record<string, unknown>
  }[]
}

const placementOf = (wanted: Wanted) => wanted.claimId ?? wanted.existingId

/**
 * The key of the candidate, one per placement and catalog file (`cand:hist:<asset>`; earlier
 * keys also named the Hub observation): a standing one of the file is kept, a retracted one is
 * followed by `:1`, `:2`…
 */
function freshKey(base: string, keys: readonly { key: string; standing: boolean }[]) {
  const same = keys.filter((entry) => entry.key === base || entry.key.startsWith(`${base}:`))
  if (same.some((entry) => entry.standing)) return null
  return same.length === 0 ? base : `${base}:${same.length}`
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
    shape_hints: 0,
    rejected: { kind: 0, date: 0, duration: 0 },
    vault_files: 0,
    vault_candidates: 0,
    vault_unknown: 0,
    retracted: 0,
    released: 0,
  }
  if (page.platform !== 'fansly') return report
  await lockPage(tx, page.accountId)
  const links = await publicationLinks(tx, page)
  const placements = await loadPlacements(tx, page)
  const byId = new Map(placements.map((placement) => [placement.id, placement]))
  const own = new Set(placements.filter(isOwn).map((placement) => placement.id))
  // A post or a vault file another kind of evidence holds is settled: the pass leaves it alone.
  const settled = new Set(
    placements
      .filter((placement) => !own.has(placement.id))
      .flatMap((placement) => [
        ...(placement.postRef ? [`post:${placement.postRef}`] : []),
        ...(placement.albumRef && placement.mediaRef
          ? [`vault:${placement.albumRef}|${placement.mediaRef}`]
          : []),
      ]),
  )
  const posts = (
    await loadPosts(tx, page, sql`p.published_at < ${options.liveFrom}::timestamptz`)
  ).filter((post) => !links.refs.has(post.ref) && !settled.has(`post:${post.ref}`))
  const { members } = await loadVault(tx, page)
  const vault = members.filter(
    (member) =>
      member.mediaRef !== null &&
      member.missingSince === null &&
      !links.albums.has(member.albumRef) &&
      (member.membershipAt === null || member.membershipAt < options.liveFrom) &&
      !settled.has(`vault:${member.albumRef}|${member.mediaRef}`),
  )
  const catalog = await loadCatalog(tx, page)
  const check: CheckOptions = { durationMs: options.settings.durationMs, timezone: page.timezone }
  const considered = new Set<string>()
  const wanted: Wanted[] = []
  const surfaceIds = new Map<string, string>()
  const surfaceId = async (surface: 'wall' | 'fyp' | 'vault') => {
    const known = surfaceIds.get(surface)
    if (known) return known
    const id = await surfaceIdOf(tx, page, surface)
    surfaceIds.set(surface, id)
    return id
  }
  const rejected = (found: readonly Found[]) => {
    for (const entry of found) if (entry?.kind === 'rejected') report.rejected[entry.reason] += 1
  }

  for (const post of posts) {
    const subject = `post:${post.ref}`
    considered.add(subject)
    report.posts += 1
    const found = post.mains.map((file) => findFile(postFile(post, file), catalog, check))
    rejected(found)
    const verdict = verdictOf(found)
    if (verdict === 'disputed') {
      report.disputed += 1
      report.unknown += 1
      continue
    }
    if (!verdict) {
      if (found.some((entry) => entry?.kind === 'photo_hint')) report.photo_hints += 1
      if (found.some((entry) => entry?.kind === 'shape_hint')) report.shape_hints += 1
      report.unknown += 1
      continue
    }
    report.candidates += 1
    const proven = hubSurface(post, page.platform)
    const surface = proven ?? hintSurface(post)
    const sid = await surfaceId(surface)
    const refs: Refs = { kind: 'post', postRef: post.ref }
    const claimId = await claimPlacement(tx, page, {
      itemId: verdict.itemId,
      surfaceId: sid,
      day: localDay(post.publishedAt, page.timezone),
    })
    const matched = found.filter(isMatched).length
    wanted.push({
      itemId: verdict.itemId,
      claimId,
      existingId: claimId ? null : await placementByRefs(tx, page, sid, refs),
      target: {
        surface,
        surfaceSource: proven ? 'hub' : 'hub_hint',
        refs,
        itemId: verdict.itemId,
        planRowId: null,
        occurredAt: post.publishedAt,
        origin: 'hub',
      },
      evidence: post.mains.flatMap((file, index) => {
        const entry = found[index]
        if (!entry || !isMatched(entry)) return []
        return [
          {
            asset: entry.assets[0] as CatalogFile,
            observationId: file.observationId,
            externalRef: post.ref,
            eventAt: post.publishedAt,
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
          },
        ]
      }),
    })
  }

  // One placement per file in a named album; a file added to the album again is the same file.
  const bySubject = new Map<string, VaultMember[]>()
  for (const member of vault) {
    const subject = `vault:${member.albumRef}|${member.mediaRef}`
    bySubject.set(subject, [...(bySubject.get(subject) ?? []), member])
  }
  for (const [subject, rows] of bySubject) {
    considered.add(subject)
    report.vault_files += rows.length
    const found = rows.map((member) => findFile(memberFile(member), catalog, check))
    rejected(found)
    const verdicts = found.map((entry) => verdictOf([entry]))
    const items = new Set(verdicts.map((one) => (one && one !== 'disputed' ? one.itemId : one)))
    const [first] = verdicts
    if (items.size !== 1 || !first || first === 'disputed') {
      report.vault_unknown += rows.length
      continue
    }
    report.vault_candidates += rows.length
    const member = rows[0] as VaultMember
    const refs: Refs = {
      kind: 'vault',
      albumRef: member.albumRef,
      mediaRef: member.mediaRef as string,
    }
    wanted.push({
      itemId: first.itemId,
      claimId: null,
      existingId: await placementByRefs(tx, page, await surfaceId('vault'), refs),
      target: {
        surface: 'vault',
        surfaceSource: 'hub',
        refs,
        itemId: first.itemId,
        planRowId: null,
        occurredAt: member.membershipAt,
        origin: 'hub',
      },
      evidence: rows.map((row, index) => ({
        asset: (verdicts[index] as { assets: CatalogFile[] }).assets[0] as CatalogFile,
        observationId: row.observationId,
        externalRef: row.mediaRef,
        eventAt: row.membershipAt,
        payload: {
          kind: 'history',
          by: (found[index] as { kind: string }).kind,
          album_ref: row.albumRef,
          album_title: row.albumTitle,
          file_name: row.filename,
          upload_name: row.uploadName,
          published_at: row.membershipAt,
        },
      })),
    })
  }

  // The pass's own earlier candidates the rules no longer give are taken back; a file Hub only
  // observed again (likes, stats) is the same candidate.
  const kept = new Set(
    wanted.flatMap((one) => {
      const id = placementOf(one)
      return id ? one.evidence.map((entry) => `${id}|${entry.asset.assetId}`) : []
    }),
  )
  const retracted = new Set<string>()
  for (const prior of await priorCandidates(tx, page)) {
    const placement = byId.get(prior.placementId)
    if (!placement || !own.has(placement.id) || !considered.has(prior.subject)) continue
    const standing = placement.evidence.find((entry) => entry.id === prior.id)?.payload.standing
    if (standing !== true) continue
    if (kept.has(`${prior.placementId}|${prior.assetId}`)) continue
    await addEvidence(tx, page, {
      placementId: prior.placementId,
      source: 'manual',
      kind: 'retract',
      strength: null,
      correctsId: prior.id,
      payload: { kind: 'history_retract', by: 'hub_history' },
      dedupKey: `retract:${prior.id}`,
    })
    retracted.add(prior.id)
    report.retracted += 1
  }
  // A placement of a post or a vault file with nothing of the pass standing goes without object;
  // one the pass wants again gets its object below.
  const again = new Set(wanted.flatMap((one) => placementOf(one) ?? []))
  const standingLeft = (placement: PlacementFact) =>
    placement.evidence.some((entry) => entry.payload.standing === true && !retracted.has(entry.id))
  for (const placement of placements) {
    if (!own.has(placement.id) || placement.manualKey !== null || !placement.itemId) continue
    if ((!placement.postRef && !placement.mediaRef) || again.has(placement.id)) continue
    if (!placement.evidence.some((entry) => retracted.has(entry.id))) continue
    if (standingLeft(placement)) continue
    if (await setPlacementItem(tx, page, placement.id, null)) report.released += 1
  }

  for (const one of wanted) {
    let placementId = one.claimId
    if (!placementId) {
      placementId = await publicationPlacement(tx, page, one.target)
      await setPlacementItem(tx, page, placementId, one.itemId)
    }
    const keys = (byId.get(placementId)?.evidence ?? []).map((entry) => ({
      key: entry.dedupKey,
      standing: entry.payload.standing === true && !retracted.has(entry.id),
    }))
    for (const entry of one.evidence) {
      const dedupKey = freshKey(`${HISTORY_KEY}${entry.asset.assetId}`, keys)
      if (!dedupKey) continue
      await addEvidence(tx, page, {
        placementId,
        source: 'hub',
        kind: 'observed',
        strength: 'candidate',
        observationId: entry.observationId,
        externalRef: entry.externalRef,
        matchedAssetId: entry.asset.assetId,
        matchedVersionId: entry.asset.versionId,
        payload: entry.payload,
        eventAt: entry.eventAt,
        dedupKey,
      })
    }
  }
  return report
}
