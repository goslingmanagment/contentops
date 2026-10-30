import type { CatalogEntry } from '@contentops/contracts/domain/catalog'
import type { ItemId, ItemType } from '@contentops/contracts/domain/item-type'
import { formatItemId } from '@contentops/contracts/domain/item-type'
import type { ItemRecord, ModelWorld } from '../fixtures/world-types'

/** Small helpers every mutating handler of a model uses. */

export function nextItemId(model: ModelWorld, type: ItemType): ItemId {
  const next = model.counters.get(type) ?? 1
  model.counters.set(type, next + 1)
  return formatItemId(type, next)
}

/** A catalog change: new ETag of `/index`, and of `/index/pages` since pairs may change too. */
export function catalogChanged(model: ModelWorld) {
  model.catalog_version += 1
  model.summary_version += 1
}

export function placementsChanged(model: ModelWorld) {
  model.summary_version += 1
}

export function touch(record: ItemRecord) {
  record.version += 1
}

export function newEntry(id: ItemId, type: ItemType, title: string, today: string): CatalogEntry {
  return {
    id,
    type,
    title,
    tags: [],
    markup: 'draft',
    cover: { key: id, ratio: type === 'fyp' ? '9:16' : '3:4' },
    duration_s: null,
    photo_count: null,
    video_count: null,
    version_count: 1,
    has_teaser: false,
    arrived_on: today,
    shot_on: today,
    ppv_kind: null,
    raw_purpose: null,
    ppv_made_as: null,
    fan_name: null,
    second_person: false,
    delivered_on: null,
    selected_count: null,
    processed_count: null,
    life_unassigned: null,
    life_chat_count: null,
    life_feed_count: null,
    steady_content: false,
    photo_custom: false,
    aliases: [],
    order_id: null,
    channel: null,
    size_bytes: null,
  }
}

export function newRecord(entry: CatalogEntry, ydiskPath: string): ItemRecord {
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
    ydisk_path: ydiskPath,
    old_names: [],
    receipts: [],
  }
}
