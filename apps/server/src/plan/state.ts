import type { Instant, LocalDate } from '@contentops/contracts/domain/common'
import type { Model } from '@contentops/contracts/domain/model'
import type {
  Evidence,
  HubCoverage,
  PlacementFacts,
  PlacementVerdict,
  PlanFacts,
} from '@contentops/contracts/domain/placement'
import type { WeekNorm } from '@contentops/contracts/domain/plan'
import {
  type Threshold,
  type ThresholdKey,
  thresholdFor,
} from '@contentops/contracts/domain/system'
import { evaluatePlacement } from '@contentops/contracts/placement'
import type { Queryable } from '@contentops/db'
import type { SQL } from 'drizzle-orm'
import { itemTypeOfDb } from '../catalog/ids'
import type { ModelScope } from '../context'
import { pageNorms } from '../handlers/norm'
import { readThresholds } from '../handlers/thresholds'
import { hubEvidence, rowHubEvidence } from '../hub/match/evidence'
import { coverageOf, type HubFacts, loadHubFacts } from '../hub/match/facts'
import {
  accountOf,
  type EvidenceRecord,
  loadEvidence,
  loadPeople,
  loadPlacements,
  loadRows,
  modelView,
  type People,
  type PlacementRecord,
  personName,
  type RowRecord,
  standingEvidence,
  surfaceOfDb,
} from './records'

/**
 * Everything the placement function needs for a model, read once per request (SPEC §5, §7):
 * plan rows, placements with their standing evidence, people, pages, thresholds and the
 * Hub coverage of each page. The level of a row or a placement is computed here and only by
 * `evaluatePlacement` of the contracts — the same function the prototype used.
 */

export interface PlanState {
  model: ModelScope
  view: Model
  people: People
  now: Instant
  rows: RowRecord[]
  placements: PlacementRecord[]
  /** Standing evidence by placement (retracted confirmations dropped). */
  evidence: Map<string, EvidenceRecord[]>
  thresholds: Threshold[]
  /** Week norms of the pages (SPEC §4: JSON of the page). */
  norms: WeekNorm[]
  /** Hub on the pages: switches, the poll, coverage, vault albums (SPEC §7, §8). */
  hub: HubFacts
}

export interface LoadOptions {
  now?: Instant
  /** Narrows the rows read; placements of the model are read whole. */
  rows?: SQL
}

export async function loadState(
  q: Queryable,
  model: ModelScope,
  options: LoadOptions = {},
): Promise<PlanState> {
  const now = options.now ?? new Date().toISOString()
  const [view, people, rows, placements, thresholds, norms, hub] = await Promise.all([
    modelView(q, model),
    loadPeople(q),
    loadRows(q, model, options.rows),
    loadPlacements(q, model),
    readThresholds(q),
    pageNorms(q, model),
    loadHubFacts(q, model.id, new Date(now)),
  ])
  const evidence = new Map<string, EvidenceRecord[]>()
  for (const row of standingEvidence(
    await loadEvidence(
      q,
      model,
      placements.map((p) => p.id),
    ),
  )) {
    const list = evidence.get(row.placement_id) ?? []
    list.push(row)
    evidence.set(row.placement_id, list)
  }
  return {
    model,
    view,
    people,
    now,
    rows,
    placements,
    evidence,
    thresholds,
    norms,
    hub,
  }
}

/** Today in Europe/Moscow, the date of the model (SPEC §5: the local day). */
export function todayOf(state: Pick<PlanState, 'now'>): LocalDate {
  return new Date(state.now).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })
}

export function threshold(
  state: PlanState,
  key: ThresholdKey,
  target: { account?: string | null; type?: string | null },
): number | null {
  return thresholdFor(state.thresholds, key, { model: state.model.code, ...target })
}

/**
 * Hub coverage of a page and surface (SPEC §7, §8): without a Hub page or before its first poll
 * — «не настроено», which keeps «Отметить и подтвердить»; receiving or matching off —
 * «выключено»; the poll down or stale — «временно недоступно», the button does not come back;
 * working — `unproven` until entry E7 proves the coverage of posts.
 */
export function hubCoverage(
  state: PlanState,
  account: string,
  surface: string = 'wall',
): HubCoverage {
  return coverageOf(state.hub.pages.get(account), surface, state.now)
}

export function contractEvidence(state: PlanState, list: readonly EvidenceRecord[]): Evidence[] {
  return list.flatMap((row): Evidence[] => {
    const base = { id: row.id, recorded_at: row.recorded_at }
    const by = personName(state.people, row.recorded_by)
    const agent = state.people.get(row.recorded_by ?? '')?.kind === 'agent'
    switch (row.kind) {
      case 'manual_confirm':
        return [
          {
            ...base,
            kind: 'manual_confirm',
            by,
            basis: row.payload.basis === 'inspected_pair' ? 'pair' : 'report',
            ...(agent ? { by_agent: true } : {}),
          },
        ]
      case 'observed':
      case 'reused_pair':
        return hubEvidence(row, state.hub)
      case 'manual_reject':
        return [
          {
            ...base,
            kind: 'manual_reject',
            by,
            rejects:
              row.corrects_id ??
              (typeof row.payload.rejects === 'string' ? row.payload.rejects : null),
          },
        ]
      case 'outside_catalog':
        return [{ ...base, kind: 'outside_catalog', by }]
      case 'legacy_claim':
        return [
          {
            ...base,
            kind: 'legacy_claim',
            label: row.legacy_fragment ?? '',
            on: (row.event_at ?? row.recorded_at).slice(0, 10),
          },
        ]
      default:
        return []
    }
  })
}

/** Standing evidence of every placement that fulfils the row. */
export function rowEvidence(state: PlanState, rowId: string): EvidenceRecord[] {
  return state.placements
    .filter((placement) => placement.plan_row_id === rowId)
    .flatMap((placement) => state.evidence.get(placement.id) ?? [])
}

export interface RowExtras {
  copy?: PlanFacts['copy']
  hasNewerVersion?: boolean
}

export function planFacts(state: PlanState, row: RowRecord, extras: RowExtras = {}): PlanFacts {
  const people = state.people
  return {
    slot_date: row.slot_date,
    slot_time: row.slot_time,
    created_by: personName(people, row.created_by),
    created_at: row.created_at,
    mark:
      row.marked_at && row.mark_kind
        ? {
            kind: row.mark_kind,
            at: row.marked_at,
            by: personName(people, row.marked_by),
            stated_occurred_at: row.stated_occurred_at,
            for_current_manifest: row.marked_manifest_id === row.manifest_id,
          }
        : null,
    cancelled: row.cancelled_at
      ? {
          at: row.cancelled_at,
          by: personName(people, row.cancelled_by),
          reason: row.cancel_reason,
        }
      : null,
    copy: extras.copy ?? null,
    second_person_blocked: row.platform === 'onlyfans' && row.has_second_person === true,
    has_newer_version: extras.hasNewerVersion ?? false,
    requires_new_upload: row.requires_new_upload,
    awaiting_montage_from:
      row.input_item_type && row.input_item_number !== null
        ? formatPublicId(row.input_item_type, row.input_item_number)
        : null,
  }
}

function formatPublicId(type: string, number: number) {
  const padding = type === 'FYP' || type === 'RAW' ? 4 : 3
  return `${type}-${String(number).padStart(padding, '0')}` as PlanFacts['awaiting_montage_from']
}

function baseFacts(
  state: PlanState,
  account: string,
  surface: RowRecord['surface'],
): Omit<PlacementFacts, 'plan' | 'evidence'> {
  const page = accountOf(state.view, account)
  const hub = hubCoverage(state, account, surface)
  return {
    now: state.now,
    account: { code: account, label: page.label, platform: page.platform },
    surface: surfaceOfDb(surface),
    hub,
    thresholds: {
      wait_hub_hours: threshold(state, 'wait_hub_hours', { account }) ?? 8,
      // «Не вышло» by posts only with entry E7; the vault says «заливка не найдена» instead.
      not_published_hours:
        hub.state === 'complete' && surface !== 'vault'
          ? threshold(state, 'not_published_hours', { account })
          : null,
    },
  }
}

export function rowFacts(state: PlanState, row: RowRecord, extras: RowExtras = {}): PlacementFacts {
  const base = baseFacts(state, row.account, row.surface)
  const own = contractEvidence(state, rowEvidence(state, row.id))
  const vault = rowHubEvidence(state, row, own)
  return {
    ...base,
    hub: vault.reason ? { ...base.hub, reason: vault.reason } : base.hub,
    plan: planFacts(state, row, extras),
    evidence: [...own, ...vault.evidence],
  }
}

export function evaluateRow(
  state: PlanState,
  row: RowRecord,
  extras: RowExtras = {},
): PlacementVerdict {
  return evaluatePlacement(rowFacts(state, row, extras))
}

export function placementFacts(state: PlanState, placement: PlacementRecord): PlacementFacts {
  const row = placement.plan_row_id
    ? state.rows.find((candidate) => candidate.id === placement.plan_row_id)
    : undefined
  const own = contractEvidence(state, state.evidence.get(placement.id) ?? [])
  const missing =
    placement.external_album_ref && placement.external_media_ref
      ? state.hub.missing.get(`${placement.external_album_ref}|${placement.external_media_ref}`)
      : undefined
  return {
    ...baseFacts(state, placement.account, placement.surface),
    plan: row ? planFacts(state, row) : null,
    evidence: missing
      ? [
          // A file a full walk no longer finds holds no placement (SPEC §7, 30.10.2026).
          ...own.filter((entry) => entry.kind !== 'hub_exact'),
          {
            id: `walk:${placement.id}`,
            recorded_at: missing,
            kind: 'walk_not_found' as const,
            walked_from: missing.slice(0, 10),
          },
        ]
      : own,
  }
}

export function evaluatePlacementRecord(
  state: PlanState,
  placement: PlacementRecord,
): PlacementVerdict {
  return evaluatePlacement(placementFacts(state, placement))
}

export { itemTypeOfDb }
