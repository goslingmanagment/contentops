import type { CatalogEntry } from '@contentops/contracts/domain/catalog'
import type { ThumbRef } from '@contentops/contracts/domain/common'
import type { FypVersion, ItemFile } from '@contentops/contracts/domain/files'
import type { ItemId, ItemType } from '@contentops/contracts/domain/item-type'
import { ITEM_TYPES, parseItemId } from '@contentops/contracts/domain/item-type'
import type { CollectionMember, PromoChannel } from '@contentops/contracts/domain/promo'
import { PROTOTYPE_NOW, PROTOTYPE_TODAY } from '../prototype-clock'
import { createEvidenceFactory } from './evidence'
import type { FactsContext } from './facts'
import { issuedNames } from './issued-names'
import { oldNamesFor, synthesizeFiles, ydiskPathFor } from './item-files'
import { buildLoraCatalog } from './lora-catalog'
import { addLoraDeleted } from './lora-deleted'
import { applyDetailedRecords } from './lora-detailed-records'
import { buildDetailedHistory } from './lora-history-tracks'
import { buildLoraInbox } from './lora-inbox'
import { buildLoraJournal, buildLoraRecent } from './lora-journal'
import { buildLoraLegacy } from './lora-legacy'
import { buildLoraOrders, ORDER_ITEM_PATCHES } from './lora-orders'
import { buildPastWeeks, historyPools } from './lora-plan-history'
import { buildCurrentWeek, RELEASE_PPV_076 } from './lora-plan-week'
import {
  buildLoraCollections,
  buildLoraHandoffs,
  collectionId,
  type FilesOf,
  LORA_CHANNELS,
  LORA_COLLECTIONS,
} from './lora-promo'
import { buildLoraUnfiled } from './lora-promo-unfiled'
import { buildLoraNorms, COVERAGE, LORA } from './models'
import { fillHistoricalPlacements, LORA_NOT_UPLOADED } from './placement-fill'
import { copyBytes, createRowBuilder, createTrackBuilder } from './plan-builder'
import type {
  CollectionRecord,
  HandoffRecord,
  ItemRecord,
  ModelWorld,
  PlanRowRecord,
  World,
} from './world-types'

/** Assembles Лора: catalog, plan, history, «Приехало», orders, promo and journal. */

export function recordFor(entry: CatalogEntry): ItemRecord {
  return {
    entry,
    version: 1,
    lifecycle: { state: 'active' },
    description: '',
    files: null,
    frames: null,
    markup: null,
    fyp_versions: [],
    provenance: [],
    ydisk_path: ydiskPathFor(entry),
    old_names: oldNamesFor(entry),
    receipts: [],
  }
}

export function idCounters(entries: readonly CatalogEntry[]): Map<ItemType, number> {
  const counters = new Map<ItemType, number>(ITEM_TYPES.map((type) => [type, 1]))
  for (const entry of entries) {
    const parsed = parseItemId(entry.id)
    if (parsed)
      counters.set(parsed.type, Math.max(counters.get(parsed.type) ?? 1, parsed.number + 1))
  }
  return counters
}

function attachOrders(
  records: Map<ItemId, ItemRecord>,
  orders: ReturnType<typeof buildLoraOrders>,
) {
  for (const order of orders) {
    for (const part of order.parts) {
      const record = part.item_id ? records.get(part.item_id) : undefined
      if (record) record.entry.order_id = order.id
    }
  }
}

/** FYP versions come from the plan: v1 for Fansly 2, v2 for Fansly 3 (DESIGN §4.5). */
function attachFypVersions(records: Map<ItemId, ItemRecord>, rows: readonly PlanRowRecord[]) {
  for (const row of rows) {
    if (!row.item_id || !row.fyp_version) continue
    const record = records.get(row.item_id)
    if (!record) continue
    const existing = record.fyp_versions.find((version) => version.no === row.fyp_version?.no)
    const placed = { account: row.account, on: row.date <= PROTOTYPE_TODAY ? row.date : null }
    if (existing) {
      existing.placed.push(placed)
      continue
    }
    const version: FypVersion = {
      no: row.fyp_version.no,
      level: row.fyp_version.level,
      thumb: { key: `${row.item_id}/u${row.fyp_version.no}`, ratio: '9:16' },
      duration_s: record.entry.duration_s ?? 9,
      placed: [placed],
    }
    record.fyp_versions.push(version)
  }
  const fyp0801 = records.get('FYP-0801')
  if (fyp0801 && !fyp0801.fyp_versions.some((version) => version.no === 3)) {
    fyp0801.fyp_versions.push({
      no: 3,
      level: 'mirror',
      thumb: { key: 'FYP-0801/u3', ratio: '9:16' },
      duration_s: 9,
      placed: [],
    })
  }
  for (const record of records.values())
    record.fyp_versions.sort((left, right) => left.no - right.no)
}

/** A channel mosaic has three cells, four for landscape YouTube (DESIGN §4.17). */
const CHANNEL_COVERS = 4

/**
 * Covers of a channel folder: one per newest collection; with fewer collections than
 * cells the rest are frames of the channel's own files, so no cell stays empty (§1.2).
 */
function channelCovers(
  channel: (typeof LORA_CHANNELS)[number],
  own: readonly CollectionRecord[],
  unfiled: readonly CollectionMember[],
): ThumbRef[] {
  const ratio = channel.orientation === 'landscape' ? ('16:9' as const) : ('3:4' as const)
  const covers: ThumbRef[] = own.slice(-CHANNEL_COVERS).map((collection) => ({
    key: collection.id,
    ratio,
  }))
  const files = [...own]
    .reverse()
    .flatMap((collection) => collection.members)
    .concat(unfiled)
  for (const member of files) {
    if (covers.length >= CHANNEL_COVERS) break
    if (!covers.some((cover) => cover.key === member.thumb.key)) covers.push(member.thumb)
  }
  return covers
}

function buildChannels(
  collections: readonly CollectionRecord[],
  unfiled: ReadonlyMap<string, readonly CollectionMember[]>,
  handoffs: readonly HandoffRecord[],
): PromoChannel[] {
  return LORA_CHANNELS.map((channel) => {
    const own = collections.filter((collection) => collection.channel === channel.id)
    const ids = new Set(own.map((collection) => collection.id))
    const sent = handoffs
      .filter((handoff) => ids.has(handoff.collection_id) && handoff.sent_on)
      .map((handoff) => handoff.sent_on ?? '')
      .sort()
    return {
      ...channel,
      collection_count: own.length,
      file_count: LORA_COLLECTIONS.filter((spec) => ids.has(collectionId(spec))).reduce(
        (sum, spec) => sum + spec.videos + spec.photos,
        0,
      ),
      last_handoff_on: sent.at(-1) ?? null,
      covers: channelCovers(channel, own, unfiled.get(channel.id) ?? []),
    }
  })
}

/** Files of an object by ID, synthesized once per object for promo clip lengths. */
function filesReader(records: ReadonlyMap<ItemId, ItemRecord>): FilesOf {
  const cache = new Map<ItemId, readonly ItemFile[]>()
  return (id) => {
    const known = cache.get(id)
    if (known) return known
    const record = records.get(id)
    const files = record ? (record.files ?? synthesizeFiles(record.entry)) : []
    cache.set(id, files)
    return files
  }
}

export function buildLoraWorld(world: World): ModelWorld {
  const entries = buildLoraCatalog()
  for (const entry of entries) Object.assign(entry, ORDER_ITEM_PATCHES[entry.id] ?? {})
  const records = new Map(entries.map((entry) => [entry.id, recordFor(entry)]))
  applyDetailedRecords(records)
  const orders = buildLoraOrders(entries.filter((entry) => entry.type === 'custom'))
  attachOrders(records, orders)

  const row = createRowBuilder('r-lora', (item, surface) => {
    const entry = records.get(item)?.entry
    return entry ? copyBytes(entry, surface) : 18_000_000
  })
  const evidence = createEvidenceFactory('e-lora')
  const track = createTrackBuilder('t-lora')
  const titleOf = (id: ItemId) => records.get(id)?.entry.title ?? id
  const context = { row, evidence, titleOf, issued: issuedNames(records) }
  const built = [...buildPastWeeks(context, historyPools(entries)), ...buildCurrentWeek(context)]
  const history = buildDetailedHistory(context, track)
  const rows = [...built, ...history.rows]
  attachFypVersions(
    records,
    rows.map((entry) => entry.row),
  )

  const collections = buildLoraCollections(
    entries
      .filter((entry) => entry.type === 'raw')
      .map((entry) => ({
        id: entry.id,
        files: (entry.photo_count ?? 0) + (entry.video_count ?? 0),
      })),
    entries.filter((entry) => entry.type === 'fyp').map((entry) => entry.id),
    filesReader(records),
  )
  const handoffs = buildLoraHandoffs(collections)
  const unfiled = buildLoraUnfiled(
    collections,
    entries.filter((entry) => entry.type === 'fyp'),
  )

  const model: ModelWorld = {
    model: LORA,
    items: records,
    tracks: [...rows.flatMap((entry) => (entry.track ? [entry.track] : [])), ...history.tracks],
    plan_rows: new Map(rows.map((entry) => [entry.row.id, entry.row])),
    releases: [{ id: RELEASE_PPV_076, item_id: 'PPV-076', date: '2026-09-24' }],
    norms: new Map(buildLoraNorms().map((norm) => [norm.account, norm])),
    coverage: new Map(
      LORA.accounts.map((account) => [
        account.code,
        COVERAGE[account.code] ?? {
          posts_complete: false,
          vault_complete: false,
          visible_from: null,
        },
      ]),
    ),
    inbox: buildLoraInbox(),
    legacy: buildLoraLegacy(),
    orders,
    collections: new Map(collections.map((collection) => [collection.id, collection])),
    promo_unfiled: unfiled,
    handoffs,
    channels: buildChannels(collections, unfiled, handoffs),
    journal: buildLoraJournal(world.people),
    recent: buildLoraRecent(),
    counters: idCounters(entries),
    disk_checked_at: '2026-09-22T11:16:00Z',
    catalog_version: 1,
    summary_version: 1,
  }

  const factsContext: FactsContext = { now: PROTOTYPE_NOW, world, model }
  model.tracks.push(
    ...fillHistoricalPlacements(factsContext, LORA_NOT_UPLOADED, { track, evidence }),
  )
  addLoraDeleted(model)
  return model
}
