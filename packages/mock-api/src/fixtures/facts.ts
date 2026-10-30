import type { AccountCode, Instant } from '@contentops/contracts/domain/common'
import type { Account } from '@contentops/contracts/domain/model'
import type {
  Evidence,
  EvidenceKind,
  HubCoverage,
  PageSummaryEntry,
  PlacementFacts,
  PlacementVerdict,
  PlanFacts,
  SurfaceKind,
} from '@contentops/contracts/domain/placement'
import { type ThresholdKey, thresholdFor } from '@contentops/contracts/domain/system'
import { type SurfaceVerdict, summarizePage } from '@contentops/contracts/page-summary'
import { evaluatePlacement } from '@contentops/contracts/placement'
import { nameOf } from './people'
import type { ModelWorld, PlacementTrack, PlanRowRecord, World } from './world-types'

/**
 * Builds placement facts from stored records, the way the server does before calling
 * `evaluatePlacement`. Fixtures use it to reach exact numbers, the mock to answer.
 */

export interface FactsContext {
  now: Instant
  world: World
  model: ModelWorld
}

export function accountOf(model: ModelWorld, code: AccountCode): Account {
  const account = model.model.accounts.find((candidate) => candidate.code === code)
  if (!account) throw new Error(`Нет страницы ${code}`)
  return account
}

export function hubCoverage(
  context: FactsContext,
  code: AccountCode,
  surface: SurfaceKind,
): HubCoverage {
  const integration = context.world.integrations.find(
    (candidate) => candidate.kind === 'hub' && candidate.account === code,
  )
  const coverage = context.model.coverage.get(code)
  const visibleFrom = coverage?.visible_from ?? null
  if (!integration || integration.state === 'unset') {
    return { state: 'unset', since: null, visible_from: visibleFrom }
  }
  if (integration.state === 'off') {
    return { state: 'off', since: integration.since, visible_from: visibleFrom }
  }
  if (integration.state === 'down') {
    return { state: 'down', since: integration.since, visible_from: visibleFrom }
  }
  const complete = surface === 'vault' ? coverage?.vault_complete : coverage?.posts_complete
  return { state: complete ? 'complete' : 'partial', since: null, visible_from: visibleFrom }
}

/** The threshold for the page: its exception wins over the model's and the common one. */
function thresholdValue(context: FactsContext, key: ThresholdKey, account: AccountCode) {
  return thresholdFor(context.world.thresholds, key, { model: context.model.model.code, account })
}

function planFacts(context: FactsContext, row: PlanRowRecord): PlanFacts {
  const people = context.world.people
  return {
    slot_date: row.date,
    slot_time: row.time,
    created_by: nameOf(row.created_by, people),
    created_at: row.created_at,
    mark: row.mark
      ? {
          kind: row.mark.kind,
          at: row.mark.at,
          by: nameOf(row.mark.by, people),
          stated_occurred_at: row.mark.stated_occurred_at,
          for_current_manifest: row.mark.for_current_manifest,
        }
      : null,
    cancelled: row.cancelled
      ? { at: row.cancelled.at, by: nameOf(row.cancelled.by, people), reason: row.cancelled.reason }
      : null,
    copy: row.copy,
    second_person_blocked: row.second_person_blocked,
    has_newer_version: row.has_newer_version,
    requires_new_upload: row.requires_new_upload,
    awaiting_montage_from: row.awaiting_montage?.from_item ?? null,
  }
}

function baseFacts(
  context: FactsContext,
  code: AccountCode,
  surface: SurfaceKind,
): Omit<PlacementFacts, 'plan' | 'evidence'> {
  const account = accountOf(context.model, code)
  return {
    now: context.now,
    account: { code, label: account.label, platform: account.platform },
    surface,
    hub: hubCoverage(context, code, surface),
    thresholds: {
      wait_hub_hours: thresholdValue(context, 'wait_hub_hours', code) ?? 8,
      not_published_hours: thresholdValue(context, 'not_published_hours', code),
    },
  }
}

export function trackOfRow(model: ModelWorld, rowId: string): PlacementTrack | undefined {
  return model.tracks.find((track) => track.plan_row_id === rowId)
}

/** What Hub reports by itself; a person's decisions and old names are not Hub's. */
const FROM_HUB: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>([
  'hub_exact',
  'hub_candidate',
  'hub_partial',
  'hub_mismatch',
  'hub_conflict',
  'hub_surface_unknown',
  'hub_unplanned',
  'vault_missing',
  'vault_stale',
  'vault_reupload',
  'walk_not_found',
])

/**
 * A page without Hub settings has no Hub findings (DESIGN §3.11): what Hub saw before the
 * settings were cleared does not reach the placement function, so the row says «не
 * проверено: Hub не настроен» instead of «Hub нашёл похожее» next to «Hub не настроен».
 */
function heardEvidence(hub: HubCoverage, evidence: Evidence[]): Evidence[] {
  return hub.state === 'unset' ? evidence.filter((item) => !FROM_HUB.has(item.kind)) : evidence
}

export function rowFacts(context: FactsContext, row: PlanRowRecord): PlacementFacts {
  const track = trackOfRow(context.model, row.id)
  const base = baseFacts(context, row.account, row.surface)
  return {
    ...base,
    plan: planFacts(context, row),
    evidence: heardEvidence(base.hub, track?.evidence ?? []),
  }
}

export function trackFacts(context: FactsContext, track: PlacementTrack): PlacementFacts {
  const row = track.plan_row_id ? context.model.plan_rows.get(track.plan_row_id) : undefined
  const base = baseFacts(context, track.account, track.surface)
  return {
    ...base,
    plan: row ? planFacts(context, row) : null,
    evidence: heardEvidence(base.hub, track.evidence),
  }
}

export function evaluateRow(context: FactsContext, row: PlanRowRecord): PlacementVerdict {
  return evaluatePlacement(rowFacts(context, row))
}

export function evaluateTrack(context: FactsContext, track: PlacementTrack): PlacementVerdict {
  return evaluatePlacement(trackFacts(context, track))
}

export interface PairSurfaces {
  item_id: string
  account: AccountCode
  surfaces: (SurfaceVerdict & { track: PlacementTrack | null; row: PlanRowRecord | null })[]
}

/** Every «object × page» pair that has facts, with the verdict of each surface. */
export function collectPairs(context: FactsContext): Map<string, PairSurfaces> {
  const pairs = new Map<string, PairSurfaces>()
  const add = (
    itemId: string,
    account: AccountCode,
    surface: SurfaceKind,
    verdict: PlacementVerdict,
    track: PlacementTrack | null,
    row: PlanRowRecord | null,
  ) => {
    const key = `${itemId}|${account}`
    const pair = pairs.get(key) ?? { item_id: itemId, account, surfaces: [] }
    pair.surfaces.push({ surface, verdict, track, row })
    pairs.set(key, pair)
  }
  const rowsWithTrack = new Set<string>()
  for (const track of context.model.tracks) {
    if (track.plan_row_id) rowsWithTrack.add(track.plan_row_id)
    if (!track.item_id) continue
    const row = track.plan_row_id ? (context.model.plan_rows.get(track.plan_row_id) ?? null) : null
    add(track.item_id, track.account, track.surface, evaluateTrack(context, track), track, row)
  }
  for (const row of context.model.plan_rows.values()) {
    if (!row.item_id || rowsWithTrack.has(row.id)) continue
    add(row.item_id, row.account, row.surface, evaluateRow(context, row), null, row)
  }
  return pairs
}

/** The second index resource: summary of every pair with facts. */
export function buildPageSummaries(context: FactsContext): PageSummaryEntry[] {
  const entries: PageSummaryEntry[] = []
  for (const pair of collectPairs(context).values()) {
    const record = context.model.items.get(pair.item_id)
    if (!record) continue
    const stats = pair.surfaces
      .map((surface) => surface.track?.stats ?? null)
      .filter((value) => value !== null)
      .sort((left, right) => right.views - left.views)[0]
    const hasFypVersion = record.fyp_versions.some((version) =>
      version.placed.some((placed) => placed.account === pair.account),
    )
    entries.push(
      summarizePage(record.entry.id, pair.account, pair.surfaces, {
        hasFypVersion,
        stats: stats ?? null,
      }),
    )
  }
  return entries
}
