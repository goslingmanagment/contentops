import { mskDate } from '@contentops/contracts/clock'
import type { CatalogEntry } from '@contentops/contracts/domain/catalog'
import type { Instant } from '@contentops/contracts/domain/common'
import type { ItemFile } from '@contentops/contracts/domain/files'
import type {
  ItemDetail,
  ItemPagePlacement,
  PlacementAction,
  SurfacePlacement,
} from '@contentops/contracts/domain/item'
import type { ItemId } from '@contentops/contracts/domain/item-type'
import type { Account } from '@contentops/contracts/domain/model'
import type { Role } from '@contentops/contracts/domain/people'
import type { PlacementVerdict, SurfaceKind } from '@contentops/contracts/domain/placement'
import { computeOrderStatus } from '@contentops/contracts/order-status'
import { type PageStats, summarizePage } from '@contentops/contracts/page-summary'
import { isInPlanLevel, isPlacedLevel } from '@contentops/contracts/placement'
import { vaultAlbumName } from '@contentops/contracts/vault-album'
import { notFound } from '../domain-error'
import { evaluateRow, evaluateTrack, type FactsContext } from '../fixtures/facts'
import { synthesizeFiles, synthesizeFrames, synthesizeMarkup } from '../fixtures/item-files'
import type { CollectionRecord, ItemRecord, OrderRecord } from '../fixtures/world-types'
import { orderFacts, orderStatusOf } from './orders'
import { handoffStatus } from './promo'

/** The object page (DESIGN §4.4): files, markup, origin, «где залито» per page. */

interface SurfaceFacts {
  surface: SurfaceKind
  verdict: PlacementVerdict
  placement: SurfacePlacement
}

function surfacesOf(context: FactsContext, itemId: ItemId, account: string): SurfaceFacts[] {
  const result: SurfaceFacts[] = []
  const rowsWithTrack = new Set<string>()
  for (const track of context.model.tracks) {
    if (track.plan_row_id) rowsWithTrack.add(track.plan_row_id)
    if (track.item_id !== itemId || track.account !== account) continue
    const verdict = evaluateTrack(context, track)
    result.push({
      surface: track.surface,
      verdict,
      placement: {
        surface: track.surface,
        verdict,
        plan_row_id: track.plan_row_id,
        album: track.album,
        caption: track.caption,
        views: track.stats?.views ?? null,
        stats_on: track.stats?.on ?? null,
      },
    })
  }
  for (const row of context.model.plan_rows.values()) {
    if (row.item_id !== itemId || row.account !== account || rowsWithTrack.has(row.id)) continue
    const verdict = evaluateRow(context, row)
    if (verdict.level === 'cancelled') continue
    result.push({
      surface: row.surface,
      verdict,
      placement: {
        surface: row.surface,
        verdict,
        plan_row_id: row.id,
        album: row.album,
        caption: null,
        views: null,
        stats_on: null,
      },
    })
  }
  return result.filter((entry) => entry.verdict.level !== 'cancelled')
}

const UPLOAD_NOW_TYPES: readonly CatalogEntry['type'][] = ['ppv', 'sexting', 'life', 'set']

function actionFor(
  entry: CatalogEntry,
  account: Account,
  surfaces: readonly SurfaceFacts[],
): PlacementAction | null {
  const turn = surfaces.find((surface) => surface.verdict.sign === 'turn')
  if (turn) return 'Сверить'
  if (surfaces.some((surface) => isPlacedLevel(surface.verdict.level))) return null
  // Уже в плане на этой странице: второй «Залить сейчас» поставил бы вторую строку.
  if (surfaces.some((surface) => isInPlanLevel(surface.verdict.level))) return null
  if (entry.second_person && account.platform === 'onlyfans') return null
  if (entry.type === 'fyp') return account.platform === 'fansly' ? 'В план' : null
  return UPLOAD_NOW_TYPES.includes(entry.type) ? 'Залить сейчас' : null
}

function pagesOf(context: FactsContext, record: ItemRecord): ItemPagePlacement[] {
  return context.model.model.accounts.map((account) => {
    const surfaces = surfacesOf(context, record.entry.id, account.code)
    const summary = summarizePage(record.entry.id, account.code, surfaces, {
      hasFypVersion: record.fyp_versions.some((version) =>
        version.placed.some((placed) => placed.account === account.code),
      ),
      stats: bestStats(surfaces.map((surface) => surface.placement)),
    })
    return {
      account: account.code,
      summary,
      surfaces: surfaces.map((surface) => ({
        ...surface.placement,
        album: surface.placement.album ?? defaultAlbum(record.entry, surface.surface),
      })),
      action: actionFor(record.entry, account, surfaces),
    }
  })
}

function bestStats(placements: readonly SurfacePlacement[]): PageStats | null {
  let best: PageStats | null = null
  for (const placement of placements) {
    if (placement.views === null || placement.stats_on === null) continue
    if (best && best.views >= placement.views) continue
    best = { views: placement.views, on: placement.stats_on }
  }
  return best
}

/** Vault album named by the norm: «PPV-076 Нейлон и каблуки», у лайфа — «Lifestyle». */
function defaultAlbum(entry: CatalogEntry, surface: SurfaceKind): string | null {
  return surface === 'vault' ? vaultAlbumName(entry) : null
}

function promoFiles(collection: CollectionRecord): ItemFile[] {
  return collection.members.map((member, index) => ({
    key: `m${String(index + 1).padStart(3, '0')}`,
    role: 'promo_link',
    label: member.item_id,
    media: member.media,
    position: index + 1,
    file_name: `${member.item_id}-${member.file_key}`,
    duration_s: null,
    width: 1080,
    height: 1920,
    size_bytes: member.size_bytes,
    thumb: member.thumb,
    current_version: 1,
    versions: [{ no: 1, on: member.added_on, reason: null, duration_s: null }],
    state: { kind: 'ready' },
    selected: null,
    processed: null,
    assignment: null,
    flags: [],
    shot_at: null,
    source: { item_id: member.item_id, file_key: member.file_key },
  }))
}

export function recordOf(context: FactsContext, id: ItemId): ItemRecord {
  const record = context.model.items.get(id)
  if (!record) throw notFound(`${id} у ${context.model.model.name_genitive} нет`)
  return record
}

/** Materializes synthesized markup before a change, so edits persist. */
export function markupOf(record: ItemRecord) {
  record.markup ??= synthesizeMarkup(record.entry)
  return record.markup
}

/**
 * «Готов для PPV» (DESIGN §4.5): видео-кастом без PPV, чей заказ сдан и правок не ждёт.
 * Кастом без заказа пришёл из старой библиотеки — его сдали до ContentOps.
 */
function readyForPpv(entry: CatalogEntry, order: OrderRecord | undefined, now: Instant): boolean {
  if (entry.type !== 'custom' || entry.photo_custom || entry.ppv_made_as !== null) return false
  if (!order) return true
  const { state } = computeOrderStatus(orderFacts(order, now), now, '')
  return state === 'delivered' || state === 'closed'
}

export function itemDetail(context: FactsContext, id: ItemId, role: Role): ItemDetail {
  const record = recordOf(context, id)
  const entry = record.entry
  const collection = entry.type === 'promo' ? context.model.collections.get(entry.id) : undefined
  const order = entry.order_id
    ? context.model.orders.find((candidate) => candidate.id === entry.order_id)
    : undefined
  const handoffs = context.model.handoffs.filter((handoff) => handoff.collection_id === entry.id)
  return {
    entry,
    version: record.version,
    lifecycle: record.lifecycle,
    files: collection ? promoFiles(collection) : (record.files ?? synthesizeFiles(entry)),
    frames: record.frames ?? synthesizeFrames(entry),
    fyp_versions: record.fyp_versions,
    markup: record.markup ?? synthesizeMarkup(entry),
    provenance: record.provenance,
    ydisk: {
      path: record.ydisk_path,
      url: `https://disk.yandex.ru/client/disk/${encodeURIComponent(record.ydisk_path.replaceAll(' / ', '/'))}`,
      old_names: record.old_names.filter((name) => role !== 'reader' || !name.with_fan_name),
    },
    pages: pagesOf(context, record),
    order: order
      ? {
          id: order.id,
          title: order.title,
          status: orderStatusOf(order, context.now, context.model.model.name_genitive, role),
        }
      : null,
    handoffs: handoffs.map((handoff) => ({
      id: handoff.id,
      status: handoffStatus(context.world, handoff, mskDate(context.now)),
    })),
    receipts: record.receipts,
    ready_for_ppv: record.ppv_montage === undefined && readyForPpv(entry, order, context.now),
    ppv_montage: record.ppv_montage === undefined ? null : { operation_id: record.ppv_montage },
    frame_check: record.frame_check ?? null,
  }
}
