import { addDays, mskInstant } from '../clock'
import type { CatalogEntry } from '../domain/catalog'
import type { AccountCode } from '../domain/common'
import type { ItemType } from '../domain/item-type'
import type { Account } from '../domain/model'
import type { Evidence, SurfaceKind } from '../domain/placement'
import { NOT_UPLOADED_TYPES, notUploadedStatus } from '../not-uploaded'
import type { EvidenceFactory } from './evidence'
import { buildPageSummaries, type FactsContext } from './facts'
import { NIKITA } from './lora-plan-week'
import type { createTrackBuilder } from './plan-builder'
import { createRandom } from './random'
import type { PlacementTrack } from './world-types'

/**
 * History before ContentOps: placements for older objects, so that «Ещё не залито»
 * shows exactly the numbers of DESIGN §9.3. The newest objects stay unplaced, the oldest
 * get a placement — as it happens on real pages.
 */

export type NotUploadedTargets = Record<AccountCode, Partial<Record<ItemType, number>>>

export const LORA_NOT_UPLOADED: NotUploadedTargets = {
  'lora-1': { ppv: 6, set: 11, life: 9, sexting: 0, fyp: 512 },
  'lora-2': { ppv: 4, set: 14, life: 12, sexting: 0, fyp: 488 },
  'lora-3': { ppv: 5, set: 14, life: 12, sexting: 0, fyp: 491 },
  'lora-vip-of': { ppv: 21, set: 30, sexting: 7 },
  'lora-of': { ppv: 38, set: 41, sexting: 12 },
}

/** Pairs that must stay «не видели» because the §9.3 table says so. */
const KEEP_UNPLACED = new Set(['PPV-075|lora-2', 'PPV-073|lora-of', 'PPV-073|lora-vip-of'])

const LAST_HISTORY_DAY = '2026-09-20'

function surfaceFor(type: ItemType): SurfaceKind {
  if (type === 'set') return 'wall'
  if (type === 'fyp') return 'fyp'
  return 'vault'
}

function placementEvidence(
  factory: EvidenceFactory,
  account: Account,
  surface: SurfaceKind,
  postAt: string,
): Evidence {
  if (account.platform === 'onlyfans') {
    return factory.manualConfirm(NIKITA, postAt, surface === 'wall' ? 'pair' : 'report')
  }
  return factory.hubExact(postAt, surface === 'vault' ? 'album' : 'file')
}

export interface FillTools {
  track: ReturnType<typeof createTrackBuilder>
  evidence: EvidenceFactory
}

/** Adds history tracks until every tab of «Ещё не залито» has its target count. */
export function fillHistoricalPlacements(
  context: FactsContext,
  targets: NotUploadedTargets,
  tools: FillTools,
): PlacementTrack[] {
  const random = createRandom(`fill:${context.model.model.code}`)
  const summaries = new Map(
    buildPageSummaries(context).map((entry) => [`${entry.item_id}|${entry.account}`, entry]),
  )
  const entries = [...context.model.items.values()].map((record) => record.entry)
  const added: PlacementTrack[] = []

  for (const account of context.model.model.accounts) {
    const pageTargets = targets[account.code]
    if (!pageTargets) continue
    for (const type of NOT_UPLOADED_TYPES) {
      const target = pageTargets[type]
      if (target === undefined) continue
      const shown = entries.filter(
        (entry) =>
          entry.type === type &&
          notUploadedStatus(
            entry,
            summaries.get(`${entry.id}|${account.code}`),
            account.platform,
          ) === 'not_uploaded',
      )
      const excess = shown.length - target
      if (excess < 0) {
        throw new Error(`${account.code} ${type}: нужно ${target} незалитых, есть ${shown.length}`)
      }
      const oldestFirst = shown
        .filter((entry) => !KEEP_UNPLACED.has(`${entry.id}|${account.code}`))
        .sort(
          (left, right) =>
            left.arrived_on.localeCompare(right.arrived_on) || left.id.localeCompare(right.id),
        )
      for (const entry of oldestFirst.slice(0, excess)) {
        added.push(...placeHistory(entry, account, tools, random.int(1, 25)))
      }
    }
  }
  return added
}

function placeHistory(
  entry: CatalogEntry,
  account: Account,
  tools: FillTools,
  daysAfterArrival: number,
): PlacementTrack[] {
  const candidate = addDays(entry.arrived_on, daysAfterArrival)
  const date = candidate > LAST_HISTORY_DAY ? LAST_HISTORY_DAY : candidate
  const surface = surfaceFor(entry.type)
  const time = surface === 'fyp' ? '03:00' : '20:00'
  const postAt = mskInstant(date, time)
  const stats =
    surface === 'fyp' && account.platform === 'fansly'
      ? {
          views: 150 + ((daysAfterArrival * 97 + entry.id.length * 13) % 2_900),
          on: '2026-09-22',
        }
      : null
  const tracks = [
    tools.track({
      item_id: entry.id,
      account: account.code,
      surface,
      evidence: [placementEvidence(tools.evidence, account, surface, postAt)],
      album: surface === 'vault' ? `${entry.id} ${entry.title}` : null,
      stats,
    }),
  ]
  if (entry.type === 'ppv' && entry.ppv_kind === 'bundle' && account.platform === 'fansly') {
    tracks.push(
      tools.track({
        item_id: entry.id,
        account: account.code,
        surface: 'wall',
        evidence: [placementEvidence(tools.evidence, account, 'wall', postAt)],
      }),
    )
  }
  return tracks
}
