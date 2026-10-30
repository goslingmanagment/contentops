import type { CatalogEntry } from '@contentops/contracts/domain/catalog'
import type { ItemPagePlacement, PlacementAction } from '@contentops/contracts/domain/item'
import type { ItemId } from '@contentops/contracts/domain/item-type'
import type { PageSummaryEntry, PlacementVerdict } from '@contentops/contracts/domain/placement'
import type { NotUploadedPage } from '@contentops/contracts/domain/search'
import { NOT_UPLOADED_TYPES, notUploadedStatus } from '@contentops/contracts/not-uploaded'
import { type SurfaceVerdict, summarizePage } from '@contentops/contracts/page-summary'
import { isInPlanLevel, isPlacedLevel } from '@contentops/contracts/placement'
import { vaultAlbumName } from '@contentops/contracts/vault-album'
import { publicIdOf } from '../catalog/ids'
import type { PlacementRecord, RowRecord } from './records'
import { surfaceOfDb } from './records'
import { evaluatePlacementRecord, evaluateRow, type PlanState } from './state'

/**
 * Where an object stands on each page (DESIGN §4.4, §10.2): every plan row and every placement
 * without a row gives the verdict of its surface; the pair «объект × страница» folds them with
 * `summarizePage`. «Ещё не залито» of a page is `notUploadedStatus` over these summaries — the
 * same function in the browser index and in `objects.notUploaded` (SPEC §7).
 */

export interface PairSurfaces {
  item_id: ItemId
  item_uid: string
  account: string
  surfaces: (SurfaceVerdict & { row: RowRecord | null; placements: PlacementRecord[] })[]
}

/**
 * Views of a surface (SPEC §8.1): the sum over its placements from Hub, the date of the latest;
 * no placement with data — `null`, «нет данных», never 0.
 */
export function statsOf(
  placements: readonly PlacementRecord[],
): { views: number; on: string; caption: string | null } | null {
  const known = placements.filter((placement) => placement.views !== null && placement.stats_at)
  if (known.length === 0) return null
  return {
    views: known.reduce((sum, placement) => sum + Number(placement.views), 0),
    on: known
      .map((placement) => (placement.stats_at as string).slice(0, 10))
      .sort()
      .at(-1) as string,
    caption: placements.find((placement) => placement.caption)?.caption ?? null,
  }
}

export function collectPairs(state: PlanState, onlyItem: string | null = null): PairSurfaces[] {
  const pairs = new Map<string, PairSurfaces>()
  const add = (
    uid: string,
    id: ItemId,
    account: string,
    surface: SurfaceVerdict['surface'],
    verdict: PlacementVerdict,
    row: RowRecord | null,
    placements: PlacementRecord[],
  ) => {
    const key = `${uid}|${account}`
    const pair = pairs.get(key) ?? { item_id: id, item_uid: uid, account, surfaces: [] }
    pair.surfaces.push({ surface, verdict, row, placements })
    pairs.set(key, pair)
  }
  for (const row of state.rows) {
    if (!row.item_id || !row.item_type || row.item_number === null) continue
    if (onlyItem && row.item_id !== onlyItem) continue
    add(
      row.item_id,
      publicIdOf(row.item_type, row.item_number),
      row.account,
      surfaceOfDb(row.surface),
      evaluateRow(state, row),
      row,
      state.placements.filter((placement) => placement.plan_row_id === row.id),
    )
  }
  for (const placement of state.placements) {
    if (placement.plan_row_id || !placement.item_id || !placement.item_type) continue
    if (placement.item_number === null || (onlyItem && placement.item_id !== onlyItem)) continue
    add(
      placement.item_id,
      publicIdOf(placement.item_type, placement.item_number),
      placement.account,
      surfaceOfDb(placement.surface),
      evaluatePlacementRecord(state, placement),
      null,
      [placement],
    )
  }
  return [...pairs.values()]
}

export function summaryOf(pair: PairSurfaces): PageSummaryEntry {
  const hasFypVersion = pair.surfaces.some(
    (surface) => surface.row?.uniq_variant_no != null && !surface.row.cancelled_at,
  )
  const stats = statsOf(pair.surfaces.flatMap((surface) => surface.placements))
  return summarizePage(pair.item_id, pair.account, pair.surfaces, {
    hasFypVersion,
    stats: stats ? { views: stats.views, on: stats.on } : null,
  })
}

/** The second index resource: the summary of every pair with facts. */
export function pageSummaries(state: PlanState): PageSummaryEntry[] {
  return collectPairs(state).map(summaryOf)
}

const pairKey = (item: string, account: string) => `${item}|${account}`

/** «Ещё не залито» of one page with the tab counts of every page (DESIGN §4.3). */
export function notUploadedPage(
  state: PlanState,
  entries: readonly CatalogEntry[],
  code: string,
): NotUploadedPage {
  const page = state.view.accounts.find((account) => account.code === code)
  const summaries = new Map(
    pageSummaries(state).map((entry) => [pairKey(entry.item_id, entry.account), entry]),
  )
  const sorted = [...entries].sort((left, right) => right.arrived_on.localeCompare(left.arrived_on))
  const statusOn = (account: string, entry: CatalogEntry) => {
    const target = state.view.accounts.find((candidate) => candidate.code === account)
    return target
      ? notUploadedStatus(entry, summaries.get(pairKey(entry.id, account)), target.platform)
      : 'not_applicable'
  }
  const tabs = state.view.accounts.map((candidate) => ({
    account: candidate.code,
    count: sorted.filter(
      (entry) => entry.type !== 'fyp' && statusOn(candidate.code, entry) === 'not_uploaded',
    ).length,
  }))
  const groups = NOT_UPLOADED_TYPES.flatMap((type) => {
    const ids = sorted
      .filter((entry) => entry.type === type && statusOn(code, entry) === 'not_uploaded')
      .map((entry) => entry.id)
    return ids.length > 0 ? [{ type, item_ids: ids, count: ids.length }] : []
  })
  const note = !page
    ? null
    : page.platform === 'onlyfans'
      ? 'vault OnlyFans Hub не видит — здесь всё, что не отмечено залитым'
      : `vault ${page.label} Hub ещё не обходит — здесь всё, что не отмечено залитым`
  return {
    account: code,
    tabs,
    groups,
    planned_hidden: sorted.filter((entry) => statusOn(code, entry) === 'in_plan').length,
    coverage_note: note,
    integration: null,
  }
}

// ---------------------------------------------------------------------------
// «Где залито» on the object page (DESIGN §4.4)
// ---------------------------------------------------------------------------

const UPLOAD_NOW_TYPES: readonly CatalogEntry['type'][] = ['ppv', 'sexting', 'life', 'set']

/** The one button of a page: «Сверить», «Залить сейчас» or «В план». */
function actionFor(
  entry: CatalogEntry,
  platform: 'fansly' | 'onlyfans',
  surfaces: readonly SurfaceVerdict[],
): PlacementAction | null {
  if (surfaces.some((surface) => surface.verdict.sign === 'turn')) return 'Сверить'
  if (surfaces.some((surface) => isPlacedLevel(surface.verdict.level))) return null
  // Already in this page's plan: a second «Залить сейчас» would put a second row.
  if (surfaces.some((surface) => isInPlanLevel(surface.verdict.level))) return null
  if (entry.second_person && platform === 'onlyfans') return null
  if (entry.type === 'fyp') return platform === 'fansly' ? 'В план' : null
  return UPLOAD_NOW_TYPES.includes(entry.type) ? 'Залить сейчас' : null
}

/** Every page of the model for one object: summary, surfaces and the button. */
export function itemPages(state: PlanState, entry: CatalogEntry, uid: string): ItemPagePlacement[] {
  const pairs = collectPairs(state, uid)
  return state.view.accounts.map((account) => {
    const pair = pairs.find((candidate) => candidate.account === account.code)
    const surfaces = (pair?.surfaces ?? []).filter(
      (surface) => surface.verdict.level !== 'cancelled',
    )
    return {
      account: account.code,
      summary: pair ? summaryOf({ ...pair, surfaces }) : summarizePage(entry.id, account.code, []),
      surfaces: surfaces.map((surface) => ({
        surface: surface.surface,
        verdict: surface.verdict,
        plan_row_id: surface.row?.id ?? null,
        album:
          surface.row?.album_name ?? (surface.surface === 'vault' ? vaultAlbumName(entry) : null),
        caption:
          statsOf(surface.placements)?.caption ??
          surface.placements.find((one) => one.caption)?.caption ??
          null,
        views: statsOf(surface.placements)?.views ?? null,
        stats_on: statsOf(surface.placements)?.on ?? null,
      })),
      action: actionFor(entry, account.platform, surfaces),
    }
  })
}

/** Where each unique FYP version stands: pages with a placed row of that version. */
export function versionPlacements(
  state: PlanState,
  uid: string,
): Map<number, { account: string; on: string | null }[]> {
  const placed = new Map<number, { account: string; on: string | null }[]>()
  for (const row of state.rows) {
    if (row.item_id !== uid || row.uniq_variant_no === null || row.cancelled_at) continue
    const verdict = evaluateRow(state, row)
    const list = placed.get(row.uniq_variant_no) ?? []
    list.push({ account: row.account, on: isPlacedLevel(verdict.level) ? verdict.date : null })
    placed.set(row.uniq_variant_no, list)
  }
  return placed
}
