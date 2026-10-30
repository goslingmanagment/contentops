import { instantMs, mskDate } from '@contentops/contracts/clock'
import type {
  CheckCase,
  CheckList,
  HubPost,
  ResolvedCase,
} from '@contentops/contracts/domain/check'
import { CHECK_KIND_BY_LEVEL } from '@contentops/contracts/domain/check'
import type { Evidence } from '@contentops/contracts/domain/placement'
import { thresholdFor } from '@contentops/contracts/domain/system'
import { formatClock, formatDuration } from '@contentops/contracts/format'
import { describeEvidence, signedMinutes } from '@contentops/contracts/placement/texts'
import { notFound } from '../domain-error'
import { accountOf, evaluateTrack, type FactsContext } from '../fixtures/facts'
import { actorOf } from '../fixtures/people'
import type { PlacementTrack } from '../fixtures/world-types'
import { unverifiedRows, unverifiedSummary } from './check-unverified'

/** «Сверить» (DESIGN §4.15): every ◆ of the placement function, with the pair to look at. */

const QUESTION_KINDS = new Set<Evidence['kind']>([
  'hub_candidate',
  'hub_partial',
  'hub_mismatch',
  'hub_conflict',
  'hub_surface_unknown',
  'hub_unplanned',
  'vault_missing',
  'vault_stale',
])
const DECISION_KINDS = new Set<Evidence['kind']>([
  'manual_confirm',
  'manual_reject',
  'outside_catalog',
])
const RESOLVED_WINDOW_DAYS = 14

function postUrl(context: FactsContext, track: PlacementTrack, evidenceId: string): string {
  const account = accountOf(context.model, track.account)
  const host = account.platform === 'fansly' ? 'https://fansly.com/post' : 'https://onlyfans.com'
  return `${host}/${account.handle}/${evidenceId}`
}

/** «22 фото» → 22, «видео 0:09» → 0; a summary without composition («альбом …») → `null`. */
function photosIn(summary: string): number | null {
  const photos = /(\d+)\s*фото/.exec(summary)?.[1]
  if (photos) return Number(photos)
  return /видео/.test(summary) ? 0 : null
}

function postsOf(context: FactsContext, track: PlacementTrack): HubPost[] {
  const extras = track.extras
  return track.evidence.flatMap((evidence): HubPost[] => {
    if (
      evidence.kind !== 'hub_candidate' &&
      evidence.kind !== 'hub_mismatch' &&
      evidence.kind !== 'hub_surface_unknown' &&
      evidence.kind !== 'hub_unplanned' &&
      evidence.kind !== 'hub_conflict'
    ) {
      return []
    }
    // The platform side on its own; the comparison lives in the verdict («0:09 = 0:09»).
    const summary =
      extras?.post_summary || (evidence.kind === 'hub_candidate' ? evidence.summary : '')
    return [
      {
        evidence_id: evidence.id,
        post_at: evidence.post_at,
        offset_min: evidence.kind === 'hub_candidate' ? evidence.offset_min : null,
        summary,
        duration_s: extras?.theirs_duration_s ?? null,
        photo_count: photosIn(summary),
        caption: extras?.caption ?? null,
        platform_file_name: extras?.platform_file_name ?? null,
        url: postUrl(context, track, evidence.id),
      },
    ]
  })
}

/** «Пост 03:06 (+6 мин) · видео 0:09 — совпадает». */
function pairPhrase(
  track: PlacementTrack,
  posts: readonly HubPost[],
): { phrase: string | null; matches: boolean | null } {
  const post = posts[0]
  const extras = track.extras
  if (!post || posts.length > 1) return { phrase: null, matches: null }
  const offset = post.offset_min === null ? '' : ` (${signedMinutes(post.offset_min)})`
  const ours = extras?.ours_duration_s ?? null
  const theirs = extras?.theirs_duration_s ?? null
  const mismatch = track.evidence.find((evidence) => evidence.kind === 'hub_mismatch')
  if (mismatch?.kind === 'hub_mismatch') {
    return {
      phrase: `Пост ${formatClock(post.post_at)}${offset} · видео ${mismatch.ours} и ${mismatch.theirs} — не совпадает`,
      matches: false,
    }
  }
  if (ours !== null && theirs !== null) {
    const same = ours === theirs
    // Equal durations: the post's own composition, so OnlyFans shows photos too («и 2 фото»).
    const media = same
      ? extras?.post_summary || `видео ${formatDuration(ours)}`
      : `видео ${formatDuration(ours)} и ${formatDuration(theirs)}`
    return {
      phrase: `Пост ${formatClock(post.post_at)}${offset} · ${media} — ${same ? 'совпадает' : 'не совпадает'}`,
      matches: same,
    }
  }
  return { phrase: `Пост ${formatClock(post.post_at)}${offset} · ${post.summary}`, matches: null }
}

function isUnambiguous(
  context: FactsContext,
  track: PlacementTrack,
  level: string,
  posts: readonly HubPost[],
): boolean {
  const account = accountOf(context.model, track.account)
  const tolerance =
    thresholdFor(context.world.thresholds, 'time_tolerance_min', {
      model: context.model.model.code,
      account: track.account,
    }) ?? 30
  const post = posts[0]
  return (
    account.platform === 'fansly' &&
    level === 'candidate' &&
    posts.length === 1 &&
    post !== undefined &&
    Math.abs(post.offset_min ?? Number.POSITIVE_INFINITY) <= tolerance &&
    track.extras?.ours_duration_s !== undefined &&
    track.extras?.ours_duration_s === track.extras?.theirs_duration_s
  )
}

function rowOf(context: FactsContext, track: PlacementTrack) {
  return track.plan_row_id ? context.model.plan_rows.get(track.plan_row_id) : undefined
}

/** «FYP-0801 версия 1»; a post without plan has no label. */
function versionLabel(context: FactsContext, track: PlacementTrack): string | null {
  if (!track.item_id) return null
  const version = rowOf(context, track)?.fyp_version
  return version ? `${track.item_id} версия ${version.no}` : track.item_id
}

function slotOf(context: FactsContext, track: PlacementTrack) {
  const row = rowOf(context, track)
  return row ? { date: row.date, time: row.time } : null
}

export function checkCase(context: FactsContext, track: PlacementTrack): CheckCase | null {
  const verdict = evaluateTrack(context, track)
  const kind = CHECK_KIND_BY_LEVEL[verdict.level]
  if (!kind) return null
  const record = track.item_id ? context.model.items.get(track.item_id) : undefined
  const posts = postsOf(context, track)
  const pair = pairPhrase(track, posts)
  return {
    id: track.id,
    kind,
    account: track.account,
    surface: track.surface,
    plan_row_id: track.plan_row_id,
    item_id: track.item_id,
    title: record?.entry.title ?? 'пост без плана',
    version_label: versionLabel(context, track),
    thumb: record?.entry.cover ?? null,
    slot: slotOf(context, track),
    verdict,
    pair_phrase: pair.phrase,
    pair_matches: pair.matches,
    posts,
    attachments: track.extras?.attachments ?? [],
    album: track.album,
    unambiguous: isUnambiguous(context, track, verdict.level, posts),
    details: {
      issued_name: track.extras?.issued_name ?? null,
      issued_to: track.extras?.issued_to ?? null,
      sizes: track.extras?.sizes ?? null,
      how_checked: track.evidence.map((item) => describeEvidence(item, mskDate(context.now))),
    },
    hint: track.extras?.hint ?? null,
  }
}

export function trackOf(context: FactsContext, caseId: string): PlacementTrack {
  const track = context.model.tracks.find((candidate) => candidate.id === caseId)
  if (!track) throw notFound('Такого случая сверки нет')
  return track
}

function lastDecision(track: PlacementTrack) {
  return track.evidence
    .filter((evidence) => DECISION_KINDS.has(evidence.kind))
    .sort((left, right) => instantMs(right.recorded_at) - instantMs(left.recorded_at))[0]
}

/** The post a decision answers: the rejected one for «Не то», else the one left standing. */
function decidedPost(
  context: FactsContext,
  track: PlacementTrack,
  decision: Evidence,
): HubPost | null {
  const posts = postsOf(context, track)
  if (decision.kind === 'manual_reject' && decision.rejects) {
    return posts.find((post) => post.evidence_id === decision.rejects) ?? posts[0] ?? null
  }
  const rejected = new Set(
    track.evidence.flatMap((evidence) =>
      evidence.kind === 'manual_reject' && evidence.rejects ? [evidence.rejects] : [],
    ),
  )
  return posts.find((post) => !rejected.has(post.evidence_id)) ?? posts[0] ?? null
}

function resolvedView(context: FactsContext, track: PlacementTrack): ResolvedCase | null {
  const decision = lastDecision(track)
  if (!decision || !('by' in decision)) return null
  const how =
    decision.kind === 'manual_confirm'
      ? decision.basis === 'pair'
        ? 'осмотренная пара'
        : 'отчёт о выполнении'
      : decision.kind === 'manual_reject'
        ? 'Не то'
        : 'Не наше'
  const person = context.world.people.find((candidate) => candidate.name === decision.by.name)
  return {
    case_id: track.id,
    item_id: track.item_id,
    title: track.item_id
      ? (context.model.items.get(track.item_id)?.entry.title ?? track.item_id)
      : 'пост без плана',
    account: track.account,
    version_label: versionLabel(context, track),
    surface: track.surface,
    slot: slotOf(context, track),
    post: decidedPost(context, track, decision),
    by: person
      ? actorOf(person.id, context.world.people)
      : { type: 'person', id: null, name: decision.by.name, gender: decision.by.gender },
    at: decision.recorded_at,
    how,
    how_checked: track.evidence.map((item) => describeEvidence(item, mskDate(context.now))),
  }
}

/** Decisions of a person on a case that Hub raised, within the last 14 days. */
export function resolvedCases(context: FactsContext): ResolvedCase[] {
  const since = instantMs(context.now) - RESOLVED_WINDOW_DAYS * 86_400_000
  return context.model.tracks
    .filter((track) => track.evidence.some((evidence) => QUESTION_KINDS.has(evidence.kind)))
    .filter((track) => !track.evidence.some((evidence) => evidence.kind === 'outside_catalog'))
    .filter((track) => {
      const decision = lastDecision(track)
      return decision !== undefined && instantMs(decision.recorded_at) >= since
    })
    .flatMap((track) => resolvedView(context, track) ?? [])
    .sort((left, right) => right.at.localeCompare(left.at))
}

export function notOursCases(context: FactsContext): ResolvedCase[] {
  return context.model.tracks
    .filter((track) => track.evidence.some((evidence) => evidence.kind === 'outside_catalog'))
    .flatMap((track) => resolvedView(context, track) ?? [])
}

export function checkList(context: FactsContext): CheckList {
  const order = new Map(context.model.model.accounts.map((account, index) => [account.code, index]))
  const cases = context.model.tracks
    .flatMap((track) => checkCase(context, track) ?? [])
    .sort(
      (left, right) =>
        (order.get(left.account) ?? 0) - (order.get(right.account) ?? 0) ||
        (right.posts[0]?.post_at ?? '').localeCompare(left.posts[0]?.post_at ?? ''),
    )
  return {
    items: cases,
    next_cursor: null,
    unverified: unverifiedSummary(unverifiedRows(context)),
    resolved_count: resolvedCases(context).length,
    not_ours_count: notOursCases(context).length,
    unambiguous_ids: cases.filter((entry) => entry.unambiguous).map((entry) => entry.id),
  }
}
