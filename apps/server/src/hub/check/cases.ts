import { instantMs, mskDate } from '@contentops/contracts/clock'
import type { CatalogEntry } from '@contentops/contracts/domain/catalog'
import {
  CHECK_KIND_BY_LEVEL,
  type CheckCase,
  type CheckList,
  type HubPost,
  type ResolvedCase,
  type UnverifiedRow,
} from '@contentops/contracts/domain/check'
import type { Evidence, PlacementVerdict } from '@contentops/contracts/domain/placement'
import { thresholdFor } from '@contentops/contracts/domain/system'
import { formatClock, formatDuration } from '@contentops/contracts/format'
import { evaluatePlacement } from '@contentops/contracts/placement'
import { describeEvidence, signedMinutes } from '@contentops/contracts/placement/texts'
import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { catalogEntries } from '../../catalog/entries'
import { publicIdOf } from '../../catalog/ids'
import { ApiProblem } from '../../errors'
import {
  actorRef,
  type EvidenceRecord,
  type RowRecord,
  standingEvidence,
  surfaceOfDb,
} from '../../plan/records'
import {
  contractEvidence,
  evaluateRow,
  hubCoverage,
  type PlanState,
  rowEvidence,
  rowFacts,
} from '../../plan/state'
import { liveFromOf } from '../match/auto'
import { type HubPostFacts, loadPosts, type Page, pageOf, publicationLinks } from '../match/load'
import { albumFits, isAdPost, modelShapes, rowAlbum } from '../match/match'
import { hintSurface, hubSurface, summaryOf } from '../match/rules'
import { matchSettings } from '../match/settings'

/**
 * «Сверить» (DESIGN §4.15, SPEC §7): every ◆ of the placement function as a case — a plan row
 * whose candidates, variants, «совпало k из n», a length that differs, «стена или фуп?» or the
 * vault ask a person (`r-<row>`), and a post Hub saw without plan or with an exact file and no
 * surface (`p-<post>`). Nothing is stored for a case: it is read from the plan, the evidence and
 * the mirror every time, so a decision anywhere closes it everywhere.
 */

export type CaseRef = { kind: 'row'; id: string } | { kind: 'post'; id: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseCase(id: string): CaseRef {
  const kind = id.startsWith('r-') ? 'row' : id.startsWith('p-') ? 'post' : null
  const rest = id.slice(2)
  if (!kind || !UUID.test(rest)) throw new ApiProblem('not_found', 'Такого случая сверки нет')
  return { kind, id: rest }
}

export const rowCaseId = (rowId: string) => `r-${rowId}`
export const postCaseId = (postId: string) => `p-${postId}`

/** Pages where matching works: Hub on, matching on (SPEC §8: switched off it finds nothing). */
function works(state: PlanState, account: string, surface = 'wall'): boolean {
  const coverage = hubCoverage(state, account, surface).state
  return coverage !== 'off' && coverage !== 'unset'
}

/** Rows Hub checks itself: the wall and FYP, the vault of Fansly (SPEC §7). */
function checkable(row: RowRecord): boolean {
  if (row.surface === 'wall') return true
  return row.platform === 'fansly' && (row.surface === 'fyp' || row.surface === 'vault')
}

export interface PostCase {
  post: HubPostFacts
  page: Page
  kind: 'unplanned' | 'surface'
  itemId: string | null
}

export interface CheckModel {
  state: PlanState
  entries: Map<string, CatalogEntry & { uid: string }>
  posts: Map<string, HubPostFacts & { account: string }>
  postCases: PostCase[]
  handles: Map<string, string>
}

async function postsById(
  q: Queryable,
  state: PlanState,
  ids: readonly string[],
): Promise<Map<string, HubPostFacts & { account: string }>> {
  const out = new Map<string, HubPostFacts & { account: string }>()
  if (ids.length === 0) return out
  for (const account of state.view.accounts) {
    const pageHub = state.hub.pages.get(account.code)
    if (!pageHub) continue
    const page = await pageOf(q, pageHub.accountId)
    if (!page) continue
    for (const post of await loadPosts(q, page, sql`p.id = ANY (${sql.param([...ids])}::uuid[])`)) {
      out.set(post.id, { ...post, account: account.code })
    }
  }
  return out
}

/** Posts without plan older than this stay out of the list (the history pass knows them). */
const LOOSE_DAYS = 30

export interface PostWindow {
  from: string
  to: string
}

/**
 * Posts after the start of matching that no placement holds: «пост без плана» — or, when every
 * main file is exact by name and Hub does not prove the surface, «стена или фуп?». Posts of open
 * candidates belong to their rows; ads of other pages and posts sent through Hub are not shown.
 */
export async function loosePosts(
  q: Queryable,
  state: PlanState,
  window: PostWindow | null,
): Promise<PostCase[]> {
  const out: PostCase[] = []
  for (const account of state.view.accounts) {
    if (!works(state, account.code)) continue
    const pageHub = state.hub.pages.get(account.code)
    const page = pageHub ? await pageOf(q, pageHub.accountId) : null
    if (!page) continue
    const liveFrom = await liveFromOf(q, page)
    if (!liveFrom) continue
    const links = await publicationLinks(q, page)
    const settings = await matchSettings(q, page)
    const shapes = settings.ads ? await modelShapes(q, page, settings) : null
    const posts = await loadPosts(
      q,
      page,
      sql`p.published_at >= greatest(${liveFrom}::timestamptz,
                                     ${window?.from ?? null}::timestamptz,
                                     ${state.now}::timestamptz - make_interval(days => ${LOOSE_DAYS}))
          AND (${window?.to ?? null}::timestamptz IS NULL OR p.published_at < ${window?.to ?? null}::timestamptz)
          AND NOT EXISTS (
            SELECT 1 FROM placements x
             WHERE x.model_id = p.model_id AND x.account_id = p.account_id
               AND x.external_post_ref = p.post_ref
               AND (x.item_id IS NOT NULL OR x.out_of_catalog))
          AND NOT EXISTS (
            SELECT 1 FROM placement_evidence e
              JOIN placements x ON x.model_id = e.model_id AND x.id = e.placement_id
             WHERE e.model_id = p.model_id AND x.account_id = p.account_id
               AND e.kind = 'observed' AND e.strength = 'candidate'
               AND e.payload ->> 'post_ref' = p.post_ref
               -- A row settled by another post holds no candidate any more.
               AND NOT EXISTS (
                 SELECT 1 FROM placement_evidence f
                  WHERE f.model_id = x.model_id AND f.placement_id = x.id AND f.strength = 'exact'
                    AND NOT EXISTS (SELECT 1 FROM placement_evidence t
                                     WHERE t.model_id = f.model_id AND t.corrects_id = f.id
                                       AND t.kind = 'retract'))
               AND NOT EXISTS (SELECT 1 FROM placement_evidence r
                                WHERE r.model_id = e.model_id
                                  AND (r.corrects_id = e.id
                                       OR (r.kind = 'manual_reject' AND r.payload ->> 'rejects' = e.id::text))
                                  AND NOT EXISTS (SELECT 1 FROM placement_evidence t
                                                   WHERE t.model_id = r.model_id
                                                     AND t.corrects_id = r.id)))`,
    )
    for (const post of posts) {
      if (links.refs.has(post.ref)) continue
      const exact =
        post.mains.length > 0 && post.mains.every((file) => file.matchStrength === 'exact')
      if (exact) {
        if (hubSurface(post, page.platform) !== null) continue
        const itemId = post.mains[0]?.matchedVersionId ? await itemOfVersion(q, page, post) : null
        out.push({ post, page, kind: 'surface', itemId })
        continue
      }
      if (shapes && isAdPost(post, settings, shapes)) continue
      out.push({ post, page, kind: 'unplanned', itemId: null })
    }
  }
  return out
}

async function itemOfVersion(q: Queryable, page: Page, post: HubPostFacts): Promise<string | null> {
  const version = post.mains[0]?.matchedVersionId
  if (!version) return null
  const { rows } = await q.execute<{ item_id: string }>(sql`
    SELECT a.created_in_item_id AS item_id FROM asset_versions v
      JOIN assets a ON a.model_id = v.model_id AND a.id = v.asset_id
     WHERE v.model_id = ${page.modelId}::uuid AND v.id = ${version}::uuid`)
  return rows[0]?.item_id ?? null
}

/** `window` narrows the posts without plan to a period: the day view counts only its day. */
export async function checkModel(
  q: Queryable,
  state: PlanState,
  window: PostWindow | null = null,
): Promise<CheckModel> {
  const postCases = await loosePosts(q, state, window)
  const evidencePosts = [...state.evidence.values()]
    .flat()
    .flatMap((row) => (typeof row.payload.post_id === 'string' ? [row.payload.post_id] : []))
  const posts = await postsById(q, state, [...new Set(evidencePosts)])
  for (const one of postCases)
    posts.set(one.post.id, { ...one.post, account: one.page.accountCode })
  const itemIds = new Set<string>([
    ...state.rows.flatMap((row) => (row.item_id ? [row.item_id] : [])),
    ...postCases.flatMap((one) => (one.itemId ? [one.itemId] : [])),
    ...state.placements.flatMap((placement) => (placement.item_id ? [placement.item_id] : [])),
  ])
  const list =
    itemIds.size > 0
      ? await catalogEntries(
          q,
          state.model,
          sql`AND c.item_id = ANY(${sql.param([...itemIds])}::uuid[])`,
          sql``,
        )
      : []
  return {
    state,
    entries: new Map(list.map((entry) => [entry.uid, entry])),
    posts,
    postCases,
    handles: new Map(state.view.accounts.map((account) => [account.code, account.handle])),
  }
}

function postUrl(model: CheckModel, account: string, ref: string): string {
  const platform = model.state.view.accounts.find((one) => one.code === account)?.platform
  return platform === 'onlyfans'
    ? `https://onlyfans.com/${ref}/${model.handles.get(account) ?? ''}`
    : `https://fansly.com/post/${ref}`
}

function hubPost(
  model: CheckModel,
  evidenceId: string,
  post: (HubPostFacts & { account: string }) | undefined,
  payload: Record<string, unknown>,
): HubPost | null {
  const publishedAt =
    post?.publishedAt ?? (typeof payload.published_at === 'string' ? payload.published_at : null)
  if (!publishedAt) return null
  const files = post?.mains ?? []
  const video = files.find((file) => file.isVideo)
  return {
    evidence_id: evidenceId,
    post_at: publishedAt,
    offset_min: typeof payload.dt_minutes === 'number' ? payload.dt_minutes : null,
    summary: post ? summaryOf(files) : String(payload.post_summary ?? ''),
    duration_s: video?.durationMs != null ? Math.round(video.durationMs / 1000) : null,
    photo_count: post ? files.filter((file) => !file.isVideo).length : null,
    caption: post?.caption ?? (typeof payload.caption === 'string' ? payload.caption : null),
    platform_file_name: files[0]?.filename ?? null,
    url: post ? postUrl(model, post.account, post.ref) : '',
  }
}

/** Open questions of a row (standing candidates on its placements), newest last. */
export function openQuestions(state: PlanState, rowId: string): EvidenceRecord[] {
  return standingEvidence(rowEvidence(state, rowId)).filter(
    (row) =>
      row.kind === 'observed' && row.strength === 'candidate' && row.payload.kind !== 'history',
  )
}

function pairPhrase(post: HubPost, payload: Record<string, unknown>) {
  const offset = post.offset_min === null ? '' : ` (${signedMinutes(post.offset_min)})`
  const duration = payload.duration as { ours?: number; theirs?: number } | null | undefined
  if (duration?.ours != null && duration.theirs != null) {
    const ours = formatDuration(duration.ours / 1000)
    const theirs = formatDuration(duration.theirs / 1000)
    const same = Math.abs(duration.ours - duration.theirs) < 1000
    return {
      phrase: `Пост ${formatClock(post.post_at)}${offset} · ${same ? post.summary : `видео ${ours} и ${theirs}`} — ${same ? 'совпадает' : 'не совпадает'}`,
      matches: same,
    }
  }
  return { phrase: `Пост ${formatClock(post.post_at)}${offset} · ${post.summary}`, matches: null }
}

async function issued(q: Queryable, state: PlanState, rowId: string) {
  const { rows } = await q.execute<{ file_name: string; by: string }>(sql`
    SELECT e.file_name, p.display_name AS by FROM download_receipts r
      JOIN download_receipt_entries e ON e.model_id = r.model_id AND e.receipt_id = r.id
      JOIN principals p ON p.id = r.principal_id
     WHERE r.model_id = ${state.model.id}::uuid AND r.plan_row_id = ${rowId}::uuid
     ORDER BY r.issued_at DESC, e.position LIMIT 1`)
  return rows[0] ?? null
}

function thumbOf(entry: (CatalogEntry & { uid: string }) | undefined) {
  return entry?.cover ?? null
}

export async function rowCase(
  q: Queryable,
  model: CheckModel,
  row: RowRecord,
): Promise<CheckCase | null> {
  const { state } = model
  if (row.cancelled_at || !checkable(row) || !works(state, row.account, row.surface)) return null
  // A row sent through Hub is linked to its post exactly (5б): nothing to check here.
  if (row.hub_publication_id) return null
  const verdict = evaluateRow(state, row)
  const kind = CHECK_KIND_BY_LEVEL[verdict.level]
  if (!kind) return null
  const open = openQuestions(state, row.id)
  const posts = open.flatMap((evidence) => {
    if (typeof evidence.payload.post_id !== 'string') return []
    const post = hubPost(
      model,
      evidence.id,
      model.posts.get(evidence.payload.post_id),
      evidence.payload,
    )
    return post ? [post] : []
  })
  const entry = row.item_id ? model.entries.get(row.item_id) : undefined
  const single = posts.length === 1 ? posts[0] : undefined
  const pair = single ? pairPhrase(single, open[0]?.payload ?? {}) : { phrase: null, matches: null }
  const facts = rowFacts(state, row)
  const today = mskDate(state.now)
  const receipt = await issued(q, state, row.id)
  const first = open[0]
  const unambiguous =
    kind === 'candidate' &&
    open.length === 1 &&
    row.platform === 'fansly' &&
    first?.payload.unambiguous === true
  return {
    id: rowCaseId(row.id),
    kind,
    account: row.account,
    surface: surfaceOfDb(row.surface),
    plan_row_id: row.id,
    item_id: entry?.id ?? null,
    title: entry?.title ?? row.item_title ?? '',
    version_label: entry
      ? row.uniq_variant_no
        ? `${entry.id} версия ${row.uniq_variant_no}`
        : entry.id
      : null,
    thumb: thumbOf(entry),
    slot: { date: row.slot_date, time: row.slot_time },
    verdict,
    pair_phrase: pair.phrase,
    pair_matches: pair.matches,
    posts,
    attachments: await attachmentsOf(q, state, row, open),
    album:
      row.surface === 'vault' && entry
        ? rowAlbum({ albumName: row.album_name, itemPublicId: entry.id, itemTitle: entry.title })
        : null,
    unambiguous,
    details: {
      issued_name: receipt?.file_name ?? null,
      issued_to: receipt?.by ?? null,
      sizes: await sizesOf(q, state, row),
      how_checked: facts.evidence.map((item) => describeEvidence(item, today)),
    },
    hint: hintOf(model, row, posts),
  }
}

/** «в 23:40 был похожий пост»: a post of the same day outside the window (SPEC §7). */
function hintOf(model: CheckModel, row: RowRecord, shown: readonly HubPost[]): string | null {
  const day = row.slot_date
  const near = [...model.posts.values()].filter(
    (post) =>
      post.account === row.account &&
      mskDate(post.publishedAt) === day &&
      !shown.some((one) => one.post_at === post.publishedAt),
  )
  const first = near.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))[0]
  return first ? `в ${formatClock(first.publishedAt)} был похожий пост` : null
}

async function sizesOf(q: Queryable, state: PlanState, row: RowRecord): Promise<string | null> {
  if (!row.manifest_id) return null
  const { rows } = await q.execute<{
    width: number | null
    height: number | null
    duration_ms: string | null
  }>(sql`
    SELECT v.width, v.height, v.duration_ms::text AS duration_ms
      FROM asset_manifest_entries e JOIN asset_versions v ON v.model_id = e.model_id AND v.id = e.asset_version_id
     WHERE e.model_id = ${state.model.id}::uuid AND e.manifest_id = ${row.manifest_id}::uuid
     ORDER BY e.position LIMIT 1`)
  const first = rows[0]
  if (!first?.width || !first.height) return null
  const duration = first.duration_ms ? ` · ${formatDuration(Number(first.duration_ms) / 1000)}` : ''
  return `${first.width}×${first.height}${duration}`
}

/** «совпало k из n»: the files of the row with ✓ where a file of the post matched by name. */
async function attachmentsOf(
  q: Queryable,
  state: PlanState,
  row: RowRecord,
  open: readonly EvidenceRecord[],
): Promise<CheckCase['attachments']> {
  const partial = open.find((evidence) => evidence.payload.kind === 'partial')
  if (!partial || !row.manifest_id || typeof partial.payload.post_id !== 'string') return []
  const { rows } = await q.execute<{
    version_id: string
    role: string | null
    ordinal: number | null
    ok: boolean
  }>(sql`
    SELECT e.asset_version_id AS version_id, m.role, m.ordinal,
           EXISTS (SELECT 1 FROM hub_post_attachments t
                    WHERE t.model_id = e.model_id AND t.post_id = ${partial.payload.post_id}::uuid
                      AND t.matched_version_id = e.asset_version_id) AS ok
      FROM asset_manifest_entries e
      LEFT JOIN item_memberships m ON m.model_id = e.model_id AND m.id = e.membership_id
     WHERE e.model_id = ${state.model.id}::uuid AND e.manifest_id = ${row.manifest_id}::uuid
       AND coalesce(m.role, 'pic') NOT IN ('teaser', 'preview', 'thumb', 'cap')
     ORDER BY e.position`)
  return rows.map((file, index) => ({
    no: index + 1,
    label: `${file.role ?? 'файл'}${file.ordinal ? ` ${file.ordinal}` : ''}`,
    ok: file.ok,
  }))
}

/** The placement function's verdict for a post that has no placement yet. */
export function postVerdict(model: CheckModel, one: PostCase): PlacementVerdict {
  const { state } = model
  const account = state.view.accounts.find((entry) => entry.code === one.page.accountCode)
  const surface = hubSurface(one.post, one.page.platform) ?? hintSurface(one.post)
  const evidence: Evidence =
    one.kind === 'surface'
      ? {
          id: `post:${one.post.id}`,
          recorded_at: one.post.publishedAt,
          kind: 'hub_surface_unknown',
          post_at: one.post.publishedAt,
        }
      : {
          id: `post:${one.post.id}`,
          recorded_at: one.post.publishedAt,
          kind: 'hub_unplanned',
          post_at: one.post.publishedAt,
          surface_seen: surface,
          summary: summaryOf(one.post.mains),
        }
  return evaluatePlacement({
    now: state.now,
    account: {
      code: one.page.accountCode,
      label: account?.label ?? one.page.accountCode,
      platform: one.page.platform,
    },
    surface,
    hub: hubCoverage(state, one.page.accountCode, surface),
    plan: null,
    evidence: [evidence],
    thresholds: { wait_hub_hours: 8, not_published_hours: null },
  })
}

export function postCase(model: CheckModel, one: PostCase): CheckCase | null {
  const verdict = postVerdict(model, one)
  const kind = CHECK_KIND_BY_LEVEL[verdict.level]
  if (!kind) return null
  const entry = one.itemId ? model.entries.get(one.itemId) : undefined
  const post = hubPost(
    model,
    `post-${one.post.id}`,
    { ...one.post, account: one.page.accountCode },
    {},
  )
  return {
    id: postCaseId(one.post.id),
    kind,
    account: one.page.accountCode,
    surface: hubSurface(one.post, one.page.platform) ?? hintSurface(one.post),
    plan_row_id: null,
    item_id: entry?.id ?? null,
    title: entry?.title ?? 'пост без плана',
    version_label: entry?.id ?? null,
    thumb: thumbOf(entry),
    slot: null,
    verdict,
    pair_phrase: post ? `Пост ${formatClock(post.post_at)} · ${post.summary}` : null,
    pair_matches: null,
    posts: post ? [post] : [],
    attachments: [],
    album: null,
    unambiguous: false,
    details: {
      issued_name: one.post.mains[0]?.filename ?? null,
      issued_to: null,
      sizes: null,
      how_checked: verdict.facts.hub ? [verdict.facts.hub] : [],
    },
    hint: null,
  }
}

export async function allCases(q: Queryable, model: CheckModel): Promise<CheckCase[]> {
  const order = new Map(model.state.view.accounts.map((account, index) => [account.code, index]))
  const out: CheckCase[] = []
  for (const row of model.state.rows) {
    const found = await rowCase(q, model, row)
    if (found) out.push(found)
  }
  for (const one of model.postCases) {
    const found = postCase(model, one)
    if (found) out.push(found)
  }
  return out.sort(
    (left, right) =>
      (order.get(left.account) ?? 0) - (order.get(right.account) ?? 0) ||
      (right.posts[0]?.post_at ?? right.slot?.date ?? '').localeCompare(
        left.posts[0]?.post_at ?? left.slot?.date ?? '',
      ),
  )
}

// ---------------------------------------------------------------------------
// «Hub не смог проверить», «Решённые за 14 дней», «Не наше»
// ---------------------------------------------------------------------------

export function unverifiedRows(model: CheckModel): UnverifiedRow[] {
  const { state } = model
  const out: UnverifiedRow[] = []
  for (const row of state.rows) {
    if (row.cancelled_at || !checkable(row) || !works(state, row.account, row.surface)) continue
    if (row.hub_publication_id) continue
    const verdict = evaluateRow(state, row)
    const stale = row.surface === 'vault' ? walkReminder(state, row) : null
    if (verdict.level !== 'cannot_verify' && !stale) continue
    if (verdict.sign === 'done') continue
    const entry = row.item_id ? model.entries.get(row.item_id) : undefined
    out.push({
      id: row.id,
      case_id: null,
      reason: stale ?? verdict.reason,
      item_id: entry?.id ?? null,
      title: entry?.title ?? row.item_title ?? '',
      thumb: thumbOf(entry),
      account: row.account,
      surface: surfaceOfDb(row.surface),
      slot: { date: row.slot_date, time: row.slot_time },
    })
  }
  return out.sort((left, right) =>
    `${right.slot?.date ?? ''} ${right.slot?.time ?? ''}`.localeCompare(
      `${left.slot?.date ?? ''} ${left.slot?.time ?? ''}`,
    ),
  )
}

/** «Hub не обходил альбом N дней» (DESIGN §4.15, `hub_vault_recheck`). */
function walkReminder(state: PlanState, row: RowRecord): string | null {
  const days = thresholdFor(state.thresholds, 'album_walk_reminder_days', {
    model: state.model.code,
    account: row.account,
  })
  if (days === null || !row.item_type || row.item_number === null) return null
  if (evaluateRow(state, row).sign === 'done') return null
  const page = state.hub.pages.get(row.account)
  const target = {
    albumName: row.album_name,
    itemPublicId: publicIdOf(row.item_type, row.item_number),
    itemTitle: row.item_title,
  }
  const walked = (page?.albums ?? [])
    .filter((album) => albumFits(album.title, target))
    .map((album) => album.walkedAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1)
  if (walked && instantMs(state.now) - instantMs(walked) < days * 86_400_000) return null
  return `Hub не обходил альбом ${days} дней`
}

export function unverifiedSummary(rows: readonly UnverifiedRow[]): CheckList['unverified'] {
  const groups = new Map<string, number>()
  for (const row of rows) groups.set(row.reason, (groups.get(row.reason) ?? 0) + 1)
  return {
    total: rows.length,
    groups: [...groups.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count),
  }
}

const RESOLVED_DAYS = 14
const DECISIONS = new Set(['manual_confirm', 'manual_reject', 'outside_catalog'])

export async function postIdsByRef(q: Queryable, state: PlanState, refs: readonly string[]) {
  if (refs.length === 0) return new Map<string, string>()
  const { rows } = await q.execute<{ id: string; ref: string; account_id: string }>(sql`
    SELECT id, post_ref AS ref, account_id FROM hub_posts
     WHERE model_id = ${state.model.id}::uuid AND post_ref = ANY (${sql.param([...refs])}::text[])`)
  return new Map(rows.map((row) => [`${row.account_id}|${row.ref}`, row.id]))
}

/** Decisions of «Сверить» within 14 days and «Не наше», newest first. */
export async function resolvedCases(
  q: Queryable,
  model: CheckModel,
  which: 'resolved' | 'not_ours',
): Promise<ResolvedCase[]> {
  const { state } = model
  const since = instantMs(state.now) - RESOLVED_DAYS * 86_400_000
  const refs = state.placements.flatMap((placement) =>
    placement.external_post_ref ? [placement.external_post_ref] : [],
  )
  const postIds = await postIdsByRef(q, state, refs)
  const out: ResolvedCase[] = []
  const today = mskDate(state.now)
  const seen = new Set<string>()
  for (const placement of [...state.placements].reverse()) {
    const evidence = state.evidence.get(placement.id) ?? []
    const decisions = evidence.filter(
      (row) =>
        DECISIONS.has(row.kind) &&
        (row.kind !== 'manual_confirm' || row.payload.basis === 'inspected_pair') &&
        typeof row.payload.decision_id === 'string',
    )
    const latest = decisions.at(-1)
    if (!latest) continue
    // One decision is one group: «Это оно» with the «Не то» it gave the other variants.
    const group = decisions.filter((row) => row.payload.decision_id === latest.payload.decision_id)
    const last =
      group.find((row) => row.kind === 'manual_confirm') ??
      group.find((row) => row.kind === 'outside_catalog') ??
      latest
    const outside = last.kind === 'outside_catalog'
    if ((which === 'not_ours') !== outside) continue
    if (which === 'resolved' && instantMs(last.recorded_at) < since) continue
    const postId = placement.external_post_ref
      ? postIds.get(`${placement.account_id}|${placement.external_post_ref}`)
      : typeof last.payload.post_id === 'string'
        ? last.payload.post_id
        : undefined
    const caseId = placement.plan_row_id
      ? rowCaseId(placement.plan_row_id)
      : postId
        ? postCaseId(postId)
        : null
    if (!caseId || seen.has(caseId)) continue
    seen.add(caseId)
    const row = placement.plan_row_id
      ? state.rows.find((one) => one.id === placement.plan_row_id)
      : undefined
    const entry = placement.item_id ? model.entries.get(placement.item_id) : undefined
    const decidedPost =
      typeof last.payload.post_id === 'string'
        ? model.posts.get(last.payload.post_id)
        : postId
          ? model.posts.get(postId)
          : undefined
    const facts = contractEvidence(state, evidence)
    out.push({
      case_id: caseId,
      item_id: entry?.id ?? null,
      title: entry?.title ?? 'пост без плана',
      account: placement.account,
      version_label: entry?.id ?? null,
      surface: surfaceOfDb(placement.surface),
      slot: row ? { date: row.slot_date, time: row.slot_time } : null,
      post: hubPost(model, last.id, decidedPost, last.payload),
      by: actorRef(state.people, last.recorded_by),
      at: last.recorded_at,
      how:
        last.kind === 'manual_confirm'
          ? 'осмотренная пара'
          : last.kind === 'manual_reject'
            ? 'Не то'
            : 'Не наше',
      how_checked: facts.map((item) => describeEvidence(item, today)),
    })
  }
  return out.sort((left, right) => right.at.localeCompare(left.at))
}

/** Posts without plan of a page on a date: «пост без плана» in the day's group (DESIGN §4.11). */
export function unplannedOn(posts: readonly PostCase[], account: string, date: string): number {
  return posts.filter(
    (one) =>
      one.kind === 'unplanned' &&
      one.page.accountCode === account &&
      mskDate(one.post.publishedAt) === date,
  ).length
}
