import {
  addDays,
  type CatalogEntry,
  formatNumber,
  type IntegrationLine,
  ITEM_TYPE_INFO,
  ITEM_TYPES,
  type ItemType,
  type LocalDate,
  plural,
} from '@contentops/contracts'
import type { MosaicLayout, MosaicTile } from '@contentops/ui/components/mosaic'
import { itemCover } from '@/lib/item-cover'
import type { PageNotUploaded } from '../shared/not-uploaded-index'
import { folderComposition, notUploadedComposition } from './folder-composition'

/**
 * Папка корня Библиотеки (DESIGN §4.1): раздел-тип, «Ещё не залито» и, когда работает
 * разметка ИИ, «Разметка на проверку» (§4.20).
 */
export type FolderKey = ItemType | 'not-uploaded' | 'markup'

/** Третья строка папки: место под неё отведено всегда. */
export type FolderNote =
  | { kind: 'week'; count: number }
  | { kind: 'overdue'; count: number }
  /** Строка Hub: на папке коротко, полная фраза — в подсказке. */
  | { kind: 'integration'; line: IntegrationLine; short: string }

export interface LibraryFolder {
  key: FolderKey
  name: string
  /** Серое число у названия; у «Ещё не залито» его нет. */
  count: number | undefined
  composition: string
  note: FolderNote | null
  tiles: MosaicTile[]
  layout: MosaicLayout
}

interface MosaicPlan {
  layout: MosaicLayout
  size: number
  /** Подписи на кадрах: длительность у видео, «22 фото» у фото. В сетках 3 × 2 и 2 × 2 их нет. */
  captions: boolean
  /** Порядок выбора кадров: новейшие по приходу, у кастомов — последние сдачи. */
  order: (entry: CatalogEntry) => string
}

const byArrival = (entry: CatalogEntry) => `${entry.arrived_on}|${entry.id}`

const MOSAIC: Record<ItemType, MosaicPlan> = {
  ppv: { layout: 'feature', size: 3, captions: true, order: byArrival },
  fyp: { layout: 'columns', size: 3, captions: true, order: byArrival },
  custom: {
    layout: 'feature',
    size: 3,
    captions: true,
    order: (entry) => `${entry.delivered_on ?? entry.arrived_on}|${entry.id}`,
  },
  set: { layout: 'grid-6', size: 6, captions: false, order: byArrival },
  sexting: { layout: 'feature', size: 3, captions: true, order: byArrival },
  life: { layout: 'grid-4', size: 4, captions: false, order: byArrival },
  raw: { layout: 'feature', size: 3, captions: true, order: byArrival },
  promo: { layout: 'feature', size: 3, captions: false, order: byArrival },
}

function tileOf(entry: CatalogEntry, captions: boolean): MosaicTile {
  const cover = itemCover(entry)
  return {
    seed: cover.seed,
    kind: cover.kind,
    family: cover.family,
    durationSeconds: captions ? cover.durationSeconds : undefined,
    countLabel: captions ? cover.countLabel : undefined,
    count: captions ? cover.count : undefined,
  }
}

function newestFirst(entries: readonly CatalogEntry[], order: (entry: CatalogEntry) => string) {
  return [...entries].sort((left, right) => order(right).localeCompare(order(left)))
}

export interface FolderSources {
  items: readonly CatalogEntry[]
  today: LocalDate
  /** Просроченные заказы — «▲ 1 заказ просрочен» на Кастомах. */
  overdueOrders: number
  /** `null`, пока сводка по страницам не пришла: папка «Ещё не залито» без мозаики. */
  notUploaded: readonly PageNotUploaded[] | null
  pageCount: number
  hubNote: { line: IntegrationLine; short: string } | null
  /** Разметка ИИ подключена и работает: появляется десятая папка. */
  markupReview: boolean
}

function typeFolder(type: ItemType, sources: FolderSources): LibraryFolder {
  const entries = sources.items.filter((entry) => entry.type === type)
  const plan = MOSAIC[type]
  const weekStart = addDays(sources.today, -6)
  const thisWeek = entries.filter((entry) => entry.arrived_on >= weekStart).length
  const note: FolderNote | null =
    type === 'custom' && sources.overdueOrders > 0
      ? { kind: 'overdue', count: sources.overdueOrders }
      : thisWeek > 0
        ? { kind: 'week', count: thisWeek }
        : null
  const newest = newestFirst(entries, plan.order)
  return {
    key: type,
    name: ITEM_TYPE_INFO[type].folder,
    count: entries.length,
    composition: folderComposition(type, entries),
    note,
    tiles: newest.slice(0, plan.size).map((entry) => tileOf(entry, plan.captions)),
    layout: plan.layout,
  }
}

/** Обложки незалитых PPV и сетов: сначала то, чего нет на большинстве страниц. */
function notUploadedFolder(sources: FolderSources): LibraryFolder {
  const pages = sources.notUploaded ?? []
  const missing = new Map<string, { entry: CatalogEntry; pages: number }>()
  for (const page of pages) {
    for (const entry of page.items) {
      if (entry.type === 'ppv' || entry.type === 'set') {
        const seen = missing.get(entry.id)
        missing.set(entry.id, { entry, pages: (seen?.pages ?? 0) + 1 })
      }
    }
  }
  const covers = [...missing.values()]
    .sort(
      (left, right) =>
        right.pages - left.pages || byArrival(right.entry).localeCompare(byArrival(left.entry)),
    )
    .slice(0, 3)
    .map(({ entry }) => tileOf(entry, true))
  return {
    key: 'not-uploaded',
    name: 'Ещё не залито',
    count: undefined,
    composition: notUploadedComposition(sources.pageCount),
    note: sources.hubNote ? { kind: 'integration', ...sources.hubNote } : null,
    tiles: covers,
    layout: 'feature',
  }
}

/** Объекты, где разметка ещё не подтверждена человеком целиком. */
function markupFolder(sources: FolderSources): LibraryFolder {
  const drafts = sources.items.filter((entry) => entry.markup !== 'confirmed')
  return {
    key: 'markup',
    name: 'Разметка на проверку',
    // Название длинное: число уходит в строку состава, чтобы название не обрезалось.
    count: undefined,
    composition: `${formatNumber(drafts.length)} ${plural(drafts.length, ['объект', 'объекта', 'объектов'])} с черновиком`,
    note: null,
    tiles: newestFirst(drafts, byArrival)
      .slice(0, 3)
      .map((entry) => tileOf(entry, true)),
    layout: 'feature',
  }
}

/** Восемь разделов в привычном порядке и «Ещё не залито» (DESIGN §0, §4.1). */
export function buildLibraryFolders(sources: FolderSources): LibraryFolder[] {
  const folders = [
    ...ITEM_TYPES.map((type) => typeFolder(type, sources)),
    notUploadedFolder(sources),
  ]
  return sources.markupReview ? [...folders, markupFolder(sources)] : folders
}

/** Раздел-тип, а не папка-ответ («Ещё не залито», «Разметка на проверку»). */
export function isTypeFolder(folder: LibraryFolder): folder is LibraryFolder & { key: ItemType } {
  return folder.key !== 'not-uploaded' && folder.key !== 'markup'
}
