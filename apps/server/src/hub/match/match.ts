import { logAction, type Queryable, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import {
  agentIds,
  type ConfirmedPair,
  confirmedPairs,
  DOWNLOAD_NAME_SQL,
  type HubFile,
  type HubPostFacts,
  loadPlacements,
  loadPosts,
  loadRows,
  loadVault,
  type Page,
  type PlacementFact,
  type PostSurface,
  publicationLinks,
  type RowFacts,
  receiptsFor,
  standing,
  statsByOffer,
  type VaultMember,
} from './load'
import { nameCore, sameSize } from './names'
import {
  type FileMatch,
  fileExact,
  hubSurface,
  inWindow,
  isUnambiguous,
  judgePair,
  looksLikeAd,
  MISMATCH_MS,
  offsetMinutes,
  type PairJudgement,
  summaryOf,
  surfaceFits,
} from './rules'
import type { MatchSettings } from './settings'
import {
  addEvidence,
  attachRefs,
  bindAssets,
  claimPlacement,
  lockPage,
  publicationPlacement,
  rowPlacement,
  type SurfaceSource,
  setProjection,
  setStats,
  surfaceIdOf,
} from './write'

/**
 * Matching of one page (SPEC §7, schema §9.6), after every `hub_sync` of the page while
 * «Автосверка» is on: Hub's posts and vault files against the plan rows of the page and the
 * issued names. Idempotent — every piece of evidence has its key, a repeat writes nothing.
 *
 * - exact by name: the download grammar, an issued file of that name, size and duration;
 * - the surface: For You views, flag 4 or no video; otherwise the KM mark of the row or
 *   «стена или фуп?»;
 * - a row ↔ a post in the window with the count of main files: one pair — a candidate, several —
 *   variants on the row, a post fitting two rows — on both;
 * - a confirmed pair «версия — media ID» seen again — «подтверждено ранее»;
 * - vault: a file of the row in its album, exact or by duration and size;
 * - a post without plan after the start of matching — «пост без плана», an ad of another page
 *   hidden with one event a day;
 * - views and likes per file summed onto the placements.
 */

export interface MatchReport {
  posts: number
  files_exact: number
  projection_changed: number
  pairs: Record<string, number>
  linked: number
  evidence_added: number
  surface_unknown: number
  unplanned: number
  ads_hidden: number
  vault: { exact: number; candidate: number; stale: number }
  stats_updated: number
}

export interface MatchOptions {
  now: Date
  settings: MatchSettings
  /** Posts from this moment on without plan are «пост без плана»; before — the history pass. */
  liveFrom: string | null
  /** Plan rows from this many days back are matched. */
  rowDays?: number
}

const DAY_MS = 86_400_000
const ROW_DAYS = 60

type Pair = {
  row: RowFacts
  post: HubPostFacts
  judgement: PairJudgement
  offsetMin: number
}

/** A file is the version of a confirmed pair while its length and size still hold (SPEC §7). */
function stillPair(pair: ConfirmedPair, file: HubFile): boolean {
  if (pair.durationMs !== null && file.durationMs !== null) {
    if (Math.abs(pair.durationMs - file.durationMs) > MISMATCH_MS) return false
  }
  const sized = sameSize(pair, file)
  return sized !== false
}

function mskDay(at: string, timezone: string): string {
  return new Date(at).toLocaleDateString('sv-SE', { timeZone: timezone })
}

export async function matchPage(tx: Tx, page: Page, options: MatchOptions): Promise<MatchReport> {
  await lockPage(tx, page.accountId)
  const { settings, now } = options
  const report: MatchReport = {
    posts: 0,
    files_exact: 0,
    projection_changed: 0,
    pairs: {},
    linked: 0,
    evidence_added: 0,
    surface_unknown: 0,
    unplanned: 0,
    ads_hidden: 0,
    vault: { exact: 0, candidate: 0, stale: 0 },
    stats_updated: 0,
  }
  const added = (id: string | null) => {
    if (id) report.evidence_added += 1
  }
  const links = await publicationLinks(tx, page)
  const rowsFromAt = new Date(now.getTime() - (options.rowDays ?? ROW_DAYS) * DAY_MS)
  const rows = (
    await loadRows(tx, page, sql`r.slot_at >= ${rowsFromAt.toISOString()}::timestamptz`)
  ).filter((row) => !links.rows.has(row.id))
  const toleranceMs = (settings.toleranceMin ?? 0) * 60_000
  const earliestRow = rows.reduce(
    (min, row) => Math.min(min, Date.parse(row.dayStart) - toleranceMs),
    Number.POSITIVE_INFINITY,
  )
  const liveAt = options.liveFrom ? Date.parse(options.liveFrom) : now.getTime()
  const postsFrom = new Date(Math.min(earliestRow, liveAt) - DAY_MS)
  const posts = (
    await loadPosts(
      tx,
      page,
      sql`p.published_at >= ${postsFrom.toISOString()}::timestamptz OR EXISTS (
            SELECT 1 FROM hub_post_attachments t
             WHERE t.model_id = p.model_id AND t.post_id = p.id AND t.role = 'main'
               AND t.filename ~* ${DOWNLOAD_NAME_SQL})`,
    )
  ).filter((post) => !links.refs.has(post.ref))
  report.posts = posts.length

  // Exact by name, file by file; the projection of every file of the posts read.
  const cores = posts.flatMap((post) => post.mains.flatMap((file) => nameCore(file.filename) ?? []))
  const receipts = await receiptsFor(tx, page, cores)
  const exact = new Map<string, FileMatch>()
  for (const post of posts) {
    for (const file of [...post.mains, ...post.previews]) {
      const match = fileExact(file, receipts, settings.durationMs, page.platform)
      exact.set(file.attachmentId, match)
      if (match.strength === 'exact') report.files_exact += 1
      if (await setProjection(tx, page, file.attachmentId, match)) report.projection_changed += 1
    }
  }

  const agents = await agentIds(tx)
  let placements = await loadPlacements(tx, page)
  const pairs = confirmedPairs(placements, agents)
  const reused = new Map<string, ConfirmedPair>()
  for (const post of posts) {
    for (const file of post.mains) {
      const pair = file.mediaRef ? pairs.get(file.mediaRef) : undefined
      if (pair && stillPair(pair, file)) reused.set(file.mediaRef as string, pair)
    }
  }

  const state = decisions(placements)
  const surfaceIds = new Map<string, string>()
  const surfaceId = async (surface: 'wall' | 'fyp' | 'vault') => {
    const known = surfaceIds.get(surface)
    if (known) return known
    const id = await surfaceIdOf(tx, page, surface)
    surfaceIds.set(surface, id)
    return id
  }

  // Rows ↔ posts in the window.
  const postRows = rows.filter((row) => row.surface !== 'vault' && !state.settledRows.has(row.id))
  const found: Pair[] = []
  for (const row of postRows) {
    for (const post of posts) {
      if (!inWindow(row, post.publishedAt, settings.toleranceMin)) continue
      const proven = hubSurface(post, page.platform)
      if (!surfaceFits(row.surface as PostSurface, proven)) continue
      if (state.taken.get(post.ref)?.has(row.surface)) continue
      if (state.rejected.has(`${row.id}|${post.ref}`)) continue
      const judgement = judgePair(row, post, exact, reused, page.platform)
      if (!judgement) continue
      found.push({ row, post, judgement, offsetMin: offsetMinutes(row, post.publishedAt) })
    }
  }
  const byRow = groupBy(found, (pair) => pair.row.id)
  const byPost = groupBy(found, (pair) => pair.post.ref)
  const certain = (pair: Pair) => {
    if (pair.judgement.kind !== 'exact' && pair.judgement.kind !== 'reused') return false
    const strong = (list: Pair[] | undefined) =>
      (list ?? []).filter(
        (one) => one.judgement.kind === 'exact' || one.judgement.kind === 'reused',
      )
    return (
      strong(byRow.get(pair.row.id)).length === 1 && strong(byPost.get(pair.post.ref)).length === 1
    )
  }

  for (const pair of found) {
    const { row, post, judgement } = pair
    const kind = certain(pair)
      ? judgement.kind
      : judgement.kind === 'exact' || judgement.kind === 'reused'
        ? 'candidate'
        : judgement.kind
    const surfaceSource = surfaceOf(row, post, page, placements)
    if ((kind === 'exact' || kind === 'reused') && surfaceSource) {
      const placementId = await rowPlacement(tx, page, row, {
        surfaceSource,
        refs: { kind: 'post', postRef: post.ref },
        occurredAt: post.publishedAt,
        origin: 'hub',
      })
      await certainEvidence(tx, page, placementId, row, post, exact, reused, added)
      report.linked += 1
      count(report.pairs, kind)
      continue
    }
    const shown = kind === 'exact' || kind === 'reused' ? 'surface' : kind
    if (shown === 'surface') report.surface_unknown += 1
    count(report.pairs, shown)
    const placementId = await rowPlacement(tx, page, row, {
      surfaceSource: row.marked ? 'km_mark' : 'plan',
      refs: null,
      occurredAt: null,
      origin: 'hub',
    })
    added(
      await addEvidence(tx, page, {
        placementId,
        source: 'hub',
        kind: 'observed',
        strength: 'candidate',
        observationId: post.observationId,
        externalRef: post.ref,
        payload: candidatePayload(pair, shown, byRow, byPost, settings, page),
        eventAt: post.publishedAt,
        dedupKey: `cand:${row.id}:${row.manifestId}:${post.observationId}`,
      }),
    )
  }

  // Exact or reused posts without a row: a placement without plan with a known object, once the
  // surface is proven; until then only the projection holds the match (SPEC §7).
  // A post on a wall row with For You views is two placements with one ref (SPEC §7, V3 № 29).
  placements = await loadPlacements(tx, page)
  const after = decisions(placements)
  const rowLinked = new Set(
    placements.flatMap((placement) =>
      placement.postRef && placement.planRowId ? [`${placement.postRef}|${placement.surface}`] : [],
    ),
  )
  for (const post of posts) {
    const items = exactItems(post, exact, reused)
    if (!items) continue
    const proven = hubSurface(post, page.platform)
    const known = proven ?? after.surfaceOf.get(post.ref) ?? null
    const pending = (byPost.get(post.ref) ?? []).filter((pair) => !certain(pair))
    if (!known) {
      if (pending.length === 0 && !byPost.has(post.ref)) report.surface_unknown += 1
      continue
    }
    // A row still asks about this post on this surface: the person answers first.
    if (pending.some((pair) => pair.row.surface === known)) continue
    if (rowLinked.has(`${post.ref}|${known}`)) continue
    const sid = await surfaceId(known)
    const claim = await claimPlacement(tx, page, {
      itemId: items.itemId,
      surfaceId: sid,
      day: mskDay(post.publishedAt, page.timezone),
    })
    let placementId: string
    if (claim) {
      await attachRefs(tx, page, claim, { kind: 'post', postRef: post.ref }, post.publishedAt)
      placementId = claim
    } else {
      placementId = await publicationPlacement(tx, page, {
        surface: known,
        surfaceSource: proven ? 'hub' : 'km',
        refs: { kind: 'post', postRef: post.ref },
        itemId: items.itemId,
        planRowId: null,
        occurredAt: post.publishedAt,
        origin: 'hub',
      })
    }
    await certainEvidence(tx, page, placementId, null, post, exact, reused, added)
    report.linked += 1
    count(report.pairs, `${items.kind}_without_plan`)
  }

  if (page.platform === 'fansly') {
    await matchVault(tx, page, rows, settings, receipts, added, report)
  }

  // Posts without plan after the start of matching; ads of other pages are hidden (SPEC §7).
  placements = await loadPlacements(tx, page)
  const linkedRefs = new Set(
    placements.flatMap((placement) => (placement.postRef ? [placement.postRef] : [])),
  )
  const hidden = new Map<string, number>()
  for (const post of posts) {
    if (Date.parse(post.publishedAt) < liveAt || byPost.has(post.ref) || linkedRefs.has(post.ref))
      continue
    if (exactItems(post, exact, reused)) continue
    if (await isAdPost(tx, page, post, settings)) {
      const day = mskDay(post.publishedAt, page.timezone)
      hidden.set(day, (hidden.get(day) ?? 0) + 1)
      continue
    }
    report.unplanned += 1
  }
  report.ads_hidden = await logHiddenAds(tx, page, hidden, now)

  await placeCaptions(tx, page)
  report.stats_updated = await placeStats(tx, page, placements)
  return report
}

function count(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1
}

function groupBy<T>(list: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of list) {
    const k = key(item)
    const group = out.get(k)
    if (group) group.push(item)
    else out.set(k, [item])
  }
  return out
}

/** What the page's placements already decide: settled rows, taken posts, rejected pairs. */
export function decisions(placements: readonly PlacementFact[]) {
  const settledRows = new Set<string>()
  const taken = new Map<string, Set<string>>()
  const surfaceOf = new Map<string, PostSurface>()
  const rejected = new Set<string>()
  const candidates = new Map<string, { row: string | null; post: string | null }>()
  for (const placement of placements) {
    for (const entry of placement.evidence) {
      if (entry.kind === 'observed' && entry.strength === 'candidate') {
        candidates.set(entry.id, {
          row: typeof entry.payload.plan_row_id === 'string' ? entry.payload.plan_row_id : null,
          post: typeof entry.payload.post_ref === 'string' ? entry.payload.post_ref : null,
        })
      }
    }
  }
  for (const placement of placements) {
    const live = standing(placement.evidence)
    const firm = live.some(
      (entry) =>
        entry.strength === 'exact' &&
        (entry.kind === 'observed' ||
          entry.kind === 'manual_confirm' ||
          entry.kind === 'reused_pair'),
    )
    const outside = live.some((entry) => entry.kind === 'outside_catalog')
    if (placement.planRowId && firm) settledRows.add(placement.planRowId)
    if (placement.postRef && (firm || outside)) {
      const set = taken.get(placement.postRef) ?? new Set<string>()
      if (outside) {
        set.add('wall')
        set.add('fyp')
      } else set.add(placement.surface)
      taken.set(placement.postRef, set)
    }
    if (
      placement.postRef &&
      (placement.surface === 'wall' || placement.surface === 'fyp') &&
      ['hub', 'km', 'km_mark'].includes(placement.surfaceSource)
    ) {
      surfaceOf.set(placement.postRef, placement.surface)
    }
    for (const entry of live) {
      if (entry.kind !== 'manual_reject') continue
      const answered =
        entry.correctsId ??
        (typeof entry.payload.rejects === 'string' ? entry.payload.rejects : null)
      if (!answered) continue
      const target = candidates.get(answered)
      if (target?.row && target.post) rejected.add(`${target.row}|${target.post}`)
    }
  }
  return { settledRows, taken, surfaceOf, rejected }
}

/**
 * Where the surface of a row's post comes from (SPEC §7 «Поверхность»): Hub's proof of the same
 * surface, the KM mark on the row, a person's answer on the post; `null` — «стена или фуп?».
 */
function surfaceOf(
  row: RowFacts,
  post: HubPostFacts,
  page: Page,
  placements: readonly PlacementFact[],
): SurfaceSource | null {
  const proven = hubSurface(post, page.platform)
  if (proven === row.surface) return 'hub'
  if (row.marked) return 'km_mark'
  const answered = placements.find(
    (placement) =>
      placement.postRef === post.ref &&
      placement.surface === row.surface &&
      placement.surfaceSource === 'km',
  )
  return answered ? 'km' : null
}

/** The object of a post whose every main file is exact or a confirmed pair, one object only. */
function exactItems(
  post: HubPostFacts,
  exact: ReadonlyMap<string, FileMatch>,
  reused: ReadonlyMap<string, ConfirmedPair>,
): { itemId: string; kind: 'exact' | 'reused' } | null {
  if (post.mains.length === 0) return null
  const items = new Set<string>()
  let byPair = 0
  for (const file of post.mains) {
    const match = exact.get(file.attachmentId)
    if (match?.strength === 'exact' && match.itemId) {
      items.add(match.itemId)
      continue
    }
    const pair = file.mediaRef ? reused.get(file.mediaRef) : undefined
    if (!pair?.itemId) return null
    byPair += 1
    items.add(pair.itemId)
  }
  const [only] = items
  if (items.size !== 1 || !only) return null
  return { itemId: only, kind: byPair > 0 ? 'reused' : 'exact' }
}

async function certainEvidence(
  tx: Tx,
  page: Page,
  placementId: string,
  row: RowFacts | null,
  post: HubPostFacts,
  exact: ReadonlyMap<string, FileMatch>,
  reused: ReadonlyMap<string, ConfirmedPair>,
  added: (id: string | null) => void,
): Promise<void> {
  const bound: Parameters<typeof bindAssets>[3][number][] = []
  for (const file of post.mains) {
    const match = exact.get(file.attachmentId)
    if (match?.strength === 'exact' && match.versionId && match.assetId) {
      added(
        await addEvidence(tx, page, {
          placementId,
          source: 'hub',
          kind: 'observed',
          strength: 'exact',
          observationId: file.observationId,
          externalRef: file.mediaRef,
          matchedAssetId: match.assetId,
          matchedVersionId: match.versionId,
          payload: {
            match: 'file_name',
            post_ref: post.ref,
            post_id: post.id,
            published_at: post.publishedAt,
            plan_row_id: row?.id ?? null,
            file_name: file.filename,
            duration_ms: file.durationMs,
            ours_ms: match.issuedMs,
            receipt_entry_id: match.receiptEntryId,
          },
          eventAt: post.publishedAt,
          dedupKey: `exact:${file.mediaRef ?? file.attachmentId}:${file.observationId}`,
        }),
      )
      bound.push({
        assetId: match.assetId,
        versionId: match.versionId,
        strength: 'exact',
        mediaRef: file.mediaRef,
        receiptEntryId: match.receiptEntryId,
      })
      continue
    }
    const pair = file.mediaRef ? reused.get(file.mediaRef) : undefined
    if (!pair) continue
    added(
      await addEvidence(tx, page, {
        placementId,
        source: 'manual',
        kind: 'reused_pair',
        strength: 'exact',
        observationId: file.observationId,
        externalRef: file.mediaRef,
        matchedAssetId: pair.assetId,
        matchedVersionId: pair.versionId,
        payload: {
          post_ref: post.ref,
          post_id: post.id,
          plan_row_id: row?.id ?? null,
          confirmed_at: pair.confirmedAt,
          by_agent: pair.byAgent,
          pairs: [
            {
              version_id: pair.versionId,
              asset_id: pair.assetId,
              media_ref: pair.mediaRef,
              duration_ms: file.durationMs,
              width: file.width,
              height: file.height,
            },
          ],
        },
        eventAt: post.publishedAt,
        dedupKey: `reuse:${file.mediaRef}:${file.observationId}`,
      }),
    )
    bound.push({
      assetId: pair.assetId,
      versionId: pair.versionId,
      strength: 'exact',
      mediaRef: file.mediaRef,
    })
  }
  await bindAssets(tx, page, placementId, bound, null)
}

function candidatePayload(
  pair: Pair,
  kind: string,
  byRow: Map<string, Pair[]>,
  byPost: Map<string, Pair[]>,
  settings: MatchSettings,
  page: Page,
): Record<string, unknown> {
  const { row, post, judgement } = pair
  const variants = byRow.get(row.id)?.length ?? 1
  const rowsOfPost = byPost.get(post.ref)?.length ?? 1
  const nameOnly = post.mains.filter((file) => nameCore(file.filename) !== null).length
  return {
    kind,
    plan_row_id: row.id,
    manifest_id: row.manifestId,
    post_ref: post.ref,
    post_id: post.id,
    published_at: post.publishedAt,
    post_summary: summaryOf(post.mains),
    ours_summary: summaryOf(row.mains),
    caption: post.caption,
    dt_minutes: Math.round(pair.offsetMin * 10) / 10,
    count_match: judgement.rowFiles === judgement.postFiles,
    row_files: judgement.rowFiles,
    post_files: judgement.postFiles,
    matched: judgement.matched,
    duration: judgement.duration,
    variants,
    rows_of_post: rowsOfPost,
    unambiguous: isUnambiguous({
      platform: page.platform,
      kind: judgement.kind,
      variants,
      rowsOfPost,
      offsetMin: pair.offsetMin,
      toleranceMin: settings.toleranceMin,
      rowFiles: judgement.rowFiles,
      postFiles: judgement.postFiles,
      ours: row.mains,
      theirs: post.mains,
      durationMs: settings.durationMs,
    }),
    name_only_hits: nameOnly,
    caption_id_hit: post.caption ? post.caption.toUpperCase().includes(row.itemPublicId) : false,
    fyp_flags: post.fypFlags,
    surface_proven: hubSurface(post, page.platform),
  }
}

/** A post without plan is an ad of another page by its caption and none of the model's files. */
export async function isAdPost(
  tx: Queryable,
  page: Page,
  post: HubPostFacts,
  settings: MatchSettings,
): Promise<boolean> {
  if (!looksLikeAd(post.caption, settings.ads)) return false
  const tolerance = settings.durationMs ?? MISMATCH_MS
  for (const file of post.mains) {
    if (!file.width || !file.height) continue
    const { rows } = await tx.execute(sql`
      SELECT 1 FROM asset_versions v JOIN assets a ON a.model_id = v.model_id AND a.id = v.asset_id
       WHERE v.model_id = ${page.modelId}::uuid
         AND ((v.width = ${file.width} AND v.height = ${file.height})
              OR (v.width = ${file.height} AND v.height = ${file.width}))
         AND (${file.isVideo} = false OR (a.media_kind = 'video'
              AND abs(coalesce(v.duration_ms, -1) - ${file.durationMs ?? -1000000}) <= ${tolerance}))
       LIMIT 1`)
    if (rows.length > 0) return false
  }
  return true
}

/**
 * «Скрыто как реклама: N» — one system event per page and finished day (SPEC §7), written
 * once: the matcher looks at the last week every run.
 */
async function logHiddenAds(
  tx: Tx,
  page: Page,
  hidden: ReadonlyMap<string, number>,
  now: Date,
): Promise<number> {
  const today = mskDay(now.toISOString(), page.timezone)
  let total = 0
  for (const [day, n] of [...hidden.entries()].sort()) {
    total += n
    if (day >= today) continue
    const { rows } = await tx.execute(sql`
      SELECT 1 FROM action_log
       WHERE model_id = ${page.modelId}::uuid AND action = 'hub.ads_hidden'
         AND subject_id = ${page.accountId}::uuid AND after ->> 'день' = ${day}
       LIMIT 1`)
    if (rows.length > 0) continue
    await logAction(tx, {
      modelId: page.modelId,
      action: 'hub.ads_hidden',
      subjectKind: 'account',
      subjectId: page.accountId,
      subjectLabel: `Hub · ${page.accountCode}`,
      after: { день: day, 'скрыто как реклама': n },
    })
  }
  return total
}

/** The caption from the platform onto the placements of a post (SPEC §7 «сохраняется подпись»). */
async function placeCaptions(tx: Tx, page: Page): Promise<number> {
  const result = await tx.execute(sql`
    UPDATE placements p SET caption = h.caption, row_version = p.row_version + 1
      FROM hub_posts h
     WHERE p.model_id = ${page.modelId}::uuid AND p.account_id = ${page.accountId}::uuid
       AND h.model_id = p.model_id AND h.account_id = p.account_id
       AND h.post_ref = p.external_post_ref AND p.caption IS DISTINCT FROM h.caption`)
  return result.rowCount ?? 0
}

/** Views and likes of Fansly files summed onto each placement with a publication (SPEC §8.1). */
async function placeStats(
  tx: Tx,
  page: Page,
  placements: readonly PlacementFact[],
): Promise<number> {
  if (page.platform !== 'fansly') return 0
  const stats = await statsByOffer(tx, page)
  const refs = placements.flatMap((placement) => (placement.postRef ? [placement.postRef] : []))
  const offersByPost = new Map<string, string[]>()
  if (refs.length > 0) {
    const { rows } = await tx.execute<{ post_ref: string; offer: string }>(sql`
      SELECT DISTINCT p.post_ref, t.media_offer_ref AS offer
        FROM hub_posts p JOIN hub_post_attachments t ON t.model_id = p.model_id AND t.post_id = p.id
       WHERE p.model_id = ${page.modelId}::uuid AND p.account_id = ${page.accountId}::uuid
         AND p.post_ref = ANY (${sql.param([...new Set(refs)])}::text[])
         AND t.media_offer_ref IS NOT NULL`)
    for (const row of rows) {
      const list = offersByPost.get(row.post_ref) ?? []
      list.push(row.offer)
      offersByPost.set(row.post_ref, list)
    }
  }
  const { rows: members } = await tx.execute<{
    album_ref: string
    media_ref: string
    offer: string
  }>(sql`
    SELECT a.album_ref, m.media_ref, m.media_offer_ref AS offer
      FROM hub_vault_media m JOIN hub_vault_albums a ON a.model_id = m.model_id AND a.id = m.album_id
     WHERE m.model_id = ${page.modelId}::uuid AND m.account_id = ${page.accountId}::uuid
       AND m.media_offer_ref IS NOT NULL AND m.media_ref IS NOT NULL`)
  const memberOffer = new Map(
    members.map((row) => [`${row.album_ref}|${row.media_ref}`, row.offer]),
  )
  let changed = 0
  for (const placement of placements) {
    let offers: string[] = []
    if (placement.postRef) offers = offersByPost.get(placement.postRef) ?? []
    else if (placement.albumRef && placement.mediaRef) {
      const offer = memberOffer.get(`${placement.albumRef}|${placement.mediaRef}`)
      offers = offer ? [offer] : []
    } else continue
    let views: number | null = null
    let likes: number | null = null
    for (const offer of new Set(offers)) {
      const entry = stats.get(offer)
      if (!entry) continue
      if (entry.views !== null) views = (views ?? 0) + entry.views
      if (entry.likes !== null) likes = (likes ?? 0) + entry.likes
    }
    if (await setStats(tx, page, placement.id, { views, likes })) changed += 1
  }
  return changed
}

// ---------------------------------------------------------------------------
// Vault (SPEC §7: «запись в нужном альбоме», «заливка не найдена», «нужна новая заливка»)
// ---------------------------------------------------------------------------

const normTitle = (title: string) =>
  title.normalize('NFC').trim().toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ')

/** The album a vault row goes to (naming §7): its name, else «ID Название», life — Lifestyle. */
export function rowAlbum(row: Pick<RowFacts, 'albumName' | 'itemPublicId' | 'itemTitle'>): string {
  if (row.albumName) return row.albumName
  if (row.itemPublicId.startsWith('LIFE-')) return 'Lifestyle'
  if (row.itemPublicId.startsWith('CUS-')) return row.itemPublicId
  return `${row.itemPublicId} ${row.itemTitle ?? ''}`.trim()
}

/** The Hub album is the row's: the same name, or an object album titled with the row's ID. */
export function albumFits(
  albumTitle: string,
  row: Pick<RowFacts, 'albumName' | 'itemPublicId' | 'itemTitle'>,
): boolean {
  const title = normTitle(albumTitle)
  if (title === normTitle(rowAlbum(row))) return true
  const [type, number] = row.itemPublicId.split('-')
  const loose = new RegExp(`^${(type ?? '').toLowerCase()}[\\s_-]?0*${Number(number)}(?![0-9])`)
  return loose.test(title)
}

async function matchVault(
  tx: Tx,
  page: Page,
  rows: readonly RowFacts[],
  settings: MatchSettings,
  postReceipts: Awaited<ReturnType<typeof receiptsFor>>,
  added: (id: string | null) => void,
  report: MatchReport,
): Promise<void> {
  const { members } = await loadVault(tx, page)
  const published = (await publicationLinks(tx, page)).albums
  const present = members.filter(
    (member) => member.missingSince === null && !published.has(member.albumRef),
  )
  if (present.length === 0) return
  const cores = present.flatMap((member) => nameCore(member.filename) ?? [])
  const receipts = cores.length > 0 ? await receiptsFor(tx, page, cores) : postReceipts
  const placements = await loadPlacements(tx, page)
  const state = decisions(placements)
  const vaultRows = rows.filter((row) => row.surface === 'vault' && !state.settledRows.has(row.id))
  const used = new Set<string>()
  const memberKey = (member: VaultMember) => `${member.albumRef}|${member.mediaRef}`
  const linkedMembers = new Set(
    placements.flatMap((placement) =>
      placement.albumRef && placement.mediaRef
        ? [`${placement.albumRef}|${placement.mediaRef}`]
        : [],
    ),
  )
  for (const row of vaultRows) {
    for (const member of present) {
      if (!member.mediaRef) continue
      const match = fileExact(
        { ...member, role: 'main' },
        receipts,
        settings.durationMs,
        page.platform,
      )
      const version = row.mains.find((file) => file.versionId === match.versionId)
      let strength: 'exact' | 'candidate' | null = null
      let matched = version ?? null
      if (match.strength === 'exact') {
        if (!version) continue
        strength = 'exact'
      } else if (albumFits(member.albumTitle, row)) {
        matched =
          row.mains.find(
            (file) =>
              file.isVideo === member.isVideo &&
              sameSize(file, member) === true &&
              (!file.isVideo ||
                settings.durationMs === null ||
                (file.durationMs !== null &&
                  member.durationMs !== null &&
                  Math.abs(file.durationMs - member.durationMs) <= settings.durationMs)),
          ) ?? null
        if (matched) strength = 'candidate'
      }
      if (!strength || !matched) continue
      // «Нужна новая заливка»: only a file created on the platform after the row (SPEC §7).
      const fresh =
        member.createdAtPlatform !== null &&
        Date.parse(member.createdAtPlatform) > Date.parse(row.createdAt)
      const stale = row.requiresNewUpload && !fresh
      used.add(memberKey(member))
      const placementId = await publicationPlacement(tx, page, {
        surface: 'vault',
        surfaceSource: 'hub',
        refs: { kind: 'vault', albumRef: member.albumRef, mediaRef: member.mediaRef },
        itemId: row.itemId,
        planRowId: row.id,
        occurredAt: member.membershipAt,
        origin: 'hub',
      })
      await tx.execute(sql`
        UPDATE placements SET plan_row_id = ${row.id}::uuid, row_version = row_version + 1
         WHERE model_id = ${page.modelId}::uuid AND id = ${placementId}::uuid AND plan_row_id IS NULL`)
      const payload = {
        match: 'album',
        plan_row_id: row.id,
        album_ref: member.albumRef,
        album_title: member.albumTitle,
        member_ref: member.memberRef,
        file_name: member.filename,
        created_at_platform: member.createdAtPlatform,
        row_created_at: row.createdAt,
        reupload: row.requiresNewUpload && fresh,
        stale,
      }
      if (strength === 'exact' && !stale) {
        report.vault.exact += 1
        added(
          await addEvidence(tx, page, {
            placementId,
            source: 'hub',
            kind: 'observed',
            strength: 'exact',
            observationId: member.observationId,
            externalRef: member.mediaRef,
            matchedAssetId: matched.assetId,
            matchedVersionId: matched.versionId,
            payload,
            eventAt: member.membershipAt,
            dedupKey: `exact:${member.mediaRef}:${member.observationId}`,
          }),
        )
        await bindAssets(
          tx,
          page,
          placementId,
          [
            {
              assetId: matched.assetId,
              versionId: matched.versionId,
              strength: 'exact',
              mediaRef: member.mediaRef,
              receiptEntryId: match.receiptEntryId,
            },
          ],
          null,
        )
      } else {
        if (stale) report.vault.stale += 1
        else report.vault.candidate += 1
        added(
          await addEvidence(tx, page, {
            placementId,
            source: 'hub',
            kind: 'observed',
            strength: 'candidate',
            observationId: member.observationId,
            externalRef: member.mediaRef,
            payload: { ...payload, kind: stale ? 'stale' : 'vault' },
            eventAt: member.membershipAt,
            dedupKey: `cand:${row.id}:${row.manifestId}:${member.observationId}`,
          }),
        )
      }
    }
  }
  // An exact file in a named album without a row: a placement without plan, object known.
  for (const member of present) {
    if (!member.mediaRef || used.has(memberKey(member)) || linkedMembers.has(memberKey(member)))
      continue
    const match = fileExact(
      { ...member, role: 'main' },
      receipts,
      settings.durationMs,
      page.platform,
    )
    if (match.strength !== 'exact' || !match.itemId || !match.versionId || !match.assetId) continue
    const placementId = await publicationPlacement(tx, page, {
      surface: 'vault',
      surfaceSource: 'hub',
      refs: { kind: 'vault', albumRef: member.albumRef, mediaRef: member.mediaRef },
      itemId: match.itemId,
      planRowId: null,
      occurredAt: member.membershipAt,
      origin: 'hub',
    })
    report.vault.exact += 1
    added(
      await addEvidence(tx, page, {
        placementId,
        source: 'hub',
        kind: 'observed',
        strength: 'exact',
        observationId: member.observationId,
        externalRef: member.mediaRef,
        matchedAssetId: match.assetId,
        matchedVersionId: match.versionId,
        payload: {
          match: 'album',
          plan_row_id: null,
          album_ref: member.albumRef,
          album_title: member.albumTitle,
          member_ref: member.memberRef,
          file_name: member.filename,
        },
        eventAt: member.membershipAt,
        dedupKey: `exact:${member.mediaRef}:${member.observationId}`,
      }),
    )
  }
}
