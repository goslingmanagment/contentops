import type { CatalogEntry } from '@contentops/contracts/domain/catalog'
import type { LocalDate } from '@contentops/contracts/domain/common'
import type { CollectionMember } from '@contentops/contracts/domain/promo'
import type { CollectionRecord } from './world-types'

/**
 * «Без подборки» у Лоры (DESIGN §4.17, сценарий §6.7): новый пак для гиф-сайтов лежит в
 * канале ещё без подборки. Девять роликов из него уже уходили Coraline Red в PRM-011,
 * поэтому перед «Подготовить» видна строка «уже передавали».
 */

const PACK_FROM_EARLIER = { collection: 'PRM-011', from: 60, count: 9 } as const
const FRESH_MONTAGES = 15
const FIRST_DAY: LocalDate = '2026-09-21'
const SECOND_DAY: LocalDate = '2026-09-22'
const FIRST_DAY_COUNT = 10
const CLIP_BYTES = 34_000_000

const keyOf = (member: Pick<CollectionMember, 'item_id' | 'file_key'>) =>
  `${member.item_id}/${member.file_key}`

function freshMontage(entry: CatalogEntry): CollectionMember {
  return {
    item_id: entry.id,
    file_key: 'montage',
    media: 'video',
    thumb: { key: `${entry.id}/montage`, ratio: '9:16' },
    size_bytes: CLIP_BYTES,
    duration_s: entry.duration_s,
    uploaded_on: entry.arrived_on,
    added_on: FIRST_DAY,
    handed_to: [],
    prepared_for: [],
    other_collections: [],
  }
}

/** Materials by channel; only «Гиф-сайты» has any in the default data. */
export function buildLoraUnfiled(
  collections: readonly CollectionRecord[],
  fyps: readonly CatalogEntry[],
): Map<string, CollectionMember[]> {
  const used = new Set(collections.flatMap((record) => record.members.map(keyOf)))
  const earlier = collections.find((record) => record.id === PACK_FROM_EARLIER.collection)
  const repeated = (earlier?.members ?? [])
    .slice(PACK_FROM_EARLIER.from, PACK_FROM_EARLIER.from + PACK_FROM_EARLIER.count)
    .map((member) => ({ ...member, other_collections: [PACK_FROM_EARLIER.collection] }))
  const fresh = fyps
    .filter((entry) => !used.has(`${entry.id}/montage`))
    .slice(0, FRESH_MONTAGES)
    .map(freshMontage)
  const pack = [...fresh, ...repeated].map((member, index) => ({
    ...member,
    size_bytes: CLIP_BYTES,
    added_on: index < FIRST_DAY_COUNT ? FIRST_DAY : SECOND_DAY,
  }))
  return new Map([['gif', pack]])
}
