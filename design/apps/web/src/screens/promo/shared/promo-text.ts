import {
  type CollectionMember,
  formatBytes,
  formatDate,
  formatNumber,
  type ItemId,
  type LocalDate,
  type MemberRef,
  type PromoChannel,
  type PromoCollection,
  plural,
} from '@contentops/contracts'
import { filesWord } from '@/lib/words'

/**
 * Подписи Промо (DESIGN §4.17) в одном месте: состав подборки и канала, «передавали».
 * Числа — с разрядами, размер — «2,65 ГБ».
 */

interface MediaCounts {
  video_count: number
  photo_count: number
}

/** «60 видео», «200 видео · 130 фото», «84 фото». */
export function mediaCounts({ video_count, photo_count }: MediaCounts): string {
  const parts: string[] = []
  if (video_count > 0) parts.push(`${formatNumber(video_count)} видео`)
  if (photo_count > 0) parts.push(`${formatNumber(photo_count)} фото`)
  return parts.length > 0 ? parts.join(' · ') : 'пусто'
}

/** «60 видео · 2,65 ГБ». */
export function mediaComposition(counts: MediaCounts & { size_bytes: number }): string {
  return `${mediaCounts(counts)} · ${formatBytes(counts.size_bytes)}`
}

const NBSP = '\u00a0'

/**
 * Подпись «a · b · c», которая переносится только между частями и после точки:
 * «PRM-010 · 29 видео ·» / «84 фото · 2,1 ГБ», а не «29» на одной строке и «видео» на
 * другой.
 */
export function breakBetweenParts(text: string): string {
  return text
    .split(' · ')
    .map((part) => part.replaceAll(' ', NBSP))
    .join(`${NBSP}· `)
}

export function collectionsWord(count: number): string {
  return `${formatNumber(count)} ${plural(count, ['подборка', 'подборки', 'подборок'])}`
}

/** «6 подборок · 1 680 файлов». */
export function channelComposition(channel: PromoChannel): string {
  return `${collectionsWord(channel.collection_count)} · ${filesWord(channel.file_count)}`
}

/** Подборка, в которой смотрят материал, и кому она уходит (закреплённый или последний). */
export interface HandedScope {
  collectionId: ItemId
  contractorId: string | null
}

/** Подрядчик подборки для «передавали»: закреплённый, иначе тот, кому её отдали последним. */
export function collectionContractor(collection: PromoCollection): string | null {
  const lastSent = collection.handoffs.filter((handoff) => handoff.state === 'sent').at(-1)
  return collection.contractor_id ?? lastSent?.contractor_id ?? null
}

/**
 * «02.09 передавали Coraline Red» — последняя передача материала вне этой подборки или
 * другому подрядчику. Передачи самой подборки её подрядчику уже видны на её папке и не
 * повторяются на каждой плитке. Дата первой: на узкой плитке обрезается имя, а не дата.
 */
export function handedText(
  member: CollectionMember,
  scope: HandedScope | null,
  today: LocalDate,
): string | null {
  const last = member.handed_to
    .filter(
      (given) =>
        !scope ||
        given.collection_id !== scope.collectionId ||
        given.contractor_id !== scope.contractorId,
    )
    .at(-1)
  return last ? `${formatDate(last.on, today)} передавали ${last.contractor}` : null
}

/** Ключ материала: один файл одного объекта (`RAW-0213/raw03`). */
export function memberKey(member: Pick<CollectionMember, 'item_id' | 'file_key'>): string {
  return `${member.item_id}/${member.file_key}`
}

/** Материал по ключу `RAW-0213/raw03`: в ID объекта и ключе файла косой черты нет. */
export function memberRefOf(key: string): MemberRef {
  const slash = key.indexOf('/')
  return { item_id: key.slice(0, slash), file_key: key.slice(slash + 1) }
}

/** Сколько видео, фото и байт в наборе материалов. */
export function membersTotals(members: readonly CollectionMember[]) {
  return {
    video_count: members.filter((member) => member.media === 'video').length,
    photo_count: members.filter((member) => member.media === 'photo').length,
    size_bytes: members.reduce((sum, member) => sum + member.size_bytes, 0),
  }
}
