import type { LocalDate, ThumbRef } from '@contentops/contracts/domain/common'
import type { ItemFile } from '@contentops/contracts/domain/files'
import type { ItemId } from '@contentops/contracts/domain/item-type'
import { formatItemId } from '@contentops/contracts/domain/item-type'
import type { CollectionMember, PromoChannel } from '@contentops/contracts/domain/promo'
import { clipDuration } from './item-files'
import { AGENT, PERSON } from './people'
import { createRandom } from './random'
import type { CollectionRecord, HandoffRecord } from './world-types'

/** Promo of Лора (DESIGN §9.8): 6 channels, 22 collections, handoffs to three contractors. */

export interface CollectionSpec {
  number: number
  title: string
  channel: string
  videos: number
  photos: number
  size_bytes: number
  added_on: LocalDate
  contractor_id: string | null
}

const gb = (value: number) => Math.round(value * 1_000_000_000)

export const LORA_CHANNELS: readonly Omit<
  PromoChannel,
  'collection_count' | 'file_count' | 'last_handoff_on' | 'covers'
>[] = [
  { id: 'instagram', name: 'Instagram', orientation: 'vertical' },
  { id: 'reddit', name: 'Reddit', orientation: 'vertical' },
  { id: 'twitter', name: 'Twitter', orientation: 'vertical' },
  { id: 'youtube', name: 'YouTube', orientation: 'landscape' },
  { id: 'gif', name: 'Гиф-сайты', orientation: 'vertical' },
  { id: 'sfs', name: 'SFS', orientation: 'vertical' },
]

export const LORA_COLLECTIONS: readonly CollectionSpec[] = [
  {
    number: 1,
    title: 'ASMR, декабрь',
    channel: 'youtube',
    videos: 8,
    photos: 0,
    size_bytes: gb(3.1),
    added_on: '2025-12-20',
    contractor_id: null,
  },
  {
    number: 2,
    title: 'Йога, февраль',
    channel: 'youtube',
    videos: 200,
    photos: 0,
    size_bytes: gb(58),
    added_on: '2026-02-25',
    contractor_id: null,
  },
  {
    number: 3,
    title: 'Instagram, май',
    channel: 'instagram',
    videos: 300,
    photos: 80,
    size_bytes: gb(14.2),
    added_on: '2026-05-28',
    contractor_id: 'c-garanteam',
  },
  {
    number: 4,
    title: 'Reddit, апрель',
    channel: 'reddit',
    videos: 180,
    photos: 130,
    size_bytes: gb(9.4),
    added_on: '2026-04-24',
    contractor_id: null,
  },
  {
    number: 5,
    title: 'Флешинги, июнь',
    channel: 'instagram',
    videos: 420,
    photos: 0,
    size_bytes: gb(18.9),
    added_on: '2026-06-26',
    contractor_id: 'c-garanteam',
  },
  {
    number: 6,
    title: 'Twitter, май',
    channel: 'twitter',
    videos: 150,
    photos: 60,
    size_bytes: gb(5.2),
    added_on: '2026-05-18',
    contractor_id: null,
  },
  {
    number: 7,
    title: 'Instagram, июль',
    channel: 'instagram',
    videos: 350,
    photos: 0,
    size_bytes: gb(15.6),
    added_on: '2026-07-27',
    contractor_id: 'c-garanteam',
  },
  {
    number: 8,
    title: 'Reddit, июнь',
    channel: 'reddit',
    videos: 170,
    photos: 120,
    size_bytes: gb(8.8),
    added_on: '2026-06-22',
    contractor_id: null,
  },
  {
    number: 9,
    title: 'SFS, сентябрь',
    channel: 'sfs',
    videos: 19,
    photos: 0,
    size_bytes: gb(1.4),
    added_on: '2026-09-15',
    contractor_id: 'c-truehelper',
  },
  {
    number: 10,
    title: 'КП1 офис',
    channel: 'instagram',
    videos: 29,
    photos: 84,
    size_bytes: gb(2.1),
    added_on: '2026-09-05',
    contractor_id: 'c-garanteam',
  },
  {
    number: 11,
    title: 'Гиф-сайты, пак 1',
    channel: 'gif',
    videos: 115,
    photos: 0,
    size_bytes: gb(3.9),
    added_on: '2026-08-30',
    contractor_id: 'c-coraline',
  },
  {
    number: 12,
    title: 'Twitter, июнь',
    channel: 'twitter',
    videos: 170,
    photos: 60,
    size_bytes: gb(5.9),
    added_on: '2026-06-24',
    contractor_id: null,
  },
  {
    number: 13,
    title: 'Reddit, сентябрь',
    channel: 'reddit',
    videos: 200,
    photos: 130,
    size_bytes: gb(10.6),
    added_on: '2026-09-17',
    contractor_id: 'c-garanteam',
  },
  {
    number: 14,
    title: 'Reddit, август',
    channel: 'reddit',
    videos: 195,
    photos: 130,
    size_bytes: gb(10.1),
    added_on: '2026-08-21',
    contractor_id: null,
  },
  {
    number: 15,
    title: 'КП2 офис нейлон',
    channel: 'instagram',
    videos: 60,
    photos: 0,
    size_bytes: gb(2.65),
    added_on: '2026-09-18',
    contractor_id: 'c-garanteam',
  },
  {
    number: 16,
    title: 'Гиф-сайты, пак 2',
    channel: 'gif',
    videos: 100,
    photos: 0,
    size_bytes: gb(3.4),
    added_on: '2026-09-17',
    contractor_id: 'c-coraline',
  },
  {
    number: 17,
    title: 'Флешинги, август',
    channel: 'instagram',
    videos: 357,
    photos: 0,
    size_bytes: gb(16.1),
    added_on: '2026-08-29',
    contractor_id: 'c-garanteam',
  },
  {
    number: 18,
    title: 'Twitter, август',
    channel: 'twitter',
    videos: 150,
    photos: 60,
    size_bytes: gb(5.4),
    added_on: '2026-08-26',
    contractor_id: null,
  },
  {
    number: 19,
    title: 'Йога, март',
    channel: 'youtube',
    videos: 215,
    photos: 0,
    size_bytes: gb(62),
    added_on: '2026-03-27',
    contractor_id: null,
  },
  {
    number: 20,
    title: 'ASMR, апрель',
    channel: 'youtube',
    videos: 220,
    photos: 0,
    size_bytes: gb(64),
    added_on: '2026-04-29',
    contractor_id: null,
  },
  {
    number: 21,
    title: 'Йога, май',
    channel: 'youtube',
    videos: 210,
    photos: 0,
    size_bytes: gb(61),
    added_on: '2026-05-30',
    contractor_id: null,
  },
  {
    number: 22,
    title: 'ASMR, июнь',
    channel: 'youtube',
    videos: 230,
    photos: 0,
    size_bytes: gb(62),
    added_on: '2026-06-28',
    contractor_id: null,
  },
]

export function collectionId(spec: CollectionSpec): ItemId {
  return formatItemId('promo', spec.number)
}

/**
 * Handoffs of §9.8: PRM-015 ✓ 18.09, PRM-016 готовится, PRM-013 подготовлено, PRM-011 ✓ 02.09,
 * PRM-009 ▲. Each carries its collection whole, as it was prepared.
 */
export function buildLoraHandoffs(collections: readonly CollectionRecord[]): HandoffRecord[] {
  const base = {
    strip_metadata: true,
    operation_id: null,
    failure: null,
    progress: null,
    sent_on: null,
  }
  const membersOf = (id: ItemId) =>
    (collections.find((record) => record.id === id)?.members ?? []).map(
      (member) => `${member.item_id}/${member.file_key}`,
    )
  const handoffs: Omit<HandoffRecord, 'members'>[] = [
    {
      ...base,
      id: 'h-015-1',
      collection_id: 'PRM-015',
      contractor_id: 'c-garanteam',
      state: 'sent',
      video_count: 60,
      photo_count: 0,
      size_bytes: gb(2.65),
      created_at: '2026-09-18T12:10:00Z',
      sent_on: '2026-09-18',
      recorded_by: PERSON.diana,
    },
    {
      ...base,
      id: 'h-016-1',
      collection_id: 'PRM-016',
      contractor_id: 'c-coraline',
      state: 'preparing',
      progress: 0.4,
      video_count: 100,
      photo_count: 0,
      size_bytes: gb(3.4),
      created_at: '2026-09-22T10:55:00Z',
      operation_id: 'op-handoff-016',
      recorded_by: PERSON.diana,
    },
    {
      ...base,
      id: 'h-013-1',
      collection_id: 'PRM-013',
      contractor_id: 'c-garanteam',
      state: 'prepared',
      video_count: 200,
      photo_count: 130,
      size_bytes: gb(10.6),
      created_at: '2026-09-21T15:30:00Z',
      recorded_by: PERSON.diana,
    },
    {
      ...base,
      id: 'h-011-1',
      collection_id: 'PRM-011',
      contractor_id: 'c-coraline',
      state: 'sent',
      video_count: 115,
      photo_count: 0,
      size_bytes: gb(3.9),
      created_at: '2026-09-02T09:00:00Z',
      sent_on: '2026-09-02',
      recorded_by: AGENT.import,
    },
    {
      ...base,
      id: 'h-009-1',
      collection_id: 'PRM-009',
      contractor_id: 'c-truehelper',
      state: 'failed',
      video_count: 19,
      photo_count: 0,
      size_bytes: gb(1.4),
      created_at: '2026-09-15T17:20:00Z',
      failure: 'не хватило места',
      recorded_by: PERSON.diana,
    },
  ]
  return handoffs.map((handoff) => ({ ...handoff, members: membersOf(handoff.collection_id) }))
}

interface MemberSource {
  item_id: ItemId
  file_key: string
  media: 'video' | 'photo'
}

/** Promo materials are links to raw promo shoots and FYP montages. */
export interface RawShoot {
  id: ItemId
  files: number
}

function memberSources(rawShoots: readonly RawShoot[], fypIds: readonly ItemId[]): MemberSource[] {
  const sources: MemberSource[] = []
  for (const shoot of rawShoots) {
    for (let index = 1; index <= shoot.files; index++) {
      const key = `raw${String(index).padStart(2, '0')}`
      sources.push({ item_id: shoot.id, file_key: key, media: index % 4 === 0 ? 'photo' : 'video' })
    }
  }
  for (const id of fypIds) sources.push({ item_id: id, file_key: 'montage', media: 'video' })
  return sources
}

/** Files of a source object, to read a clip length from. */
export type FilesOf = (id: ItemId) => readonly ItemFile[]

function durationOf(source: MemberSource, filesOf: FilesOf): number | null {
  return source.media === 'video'
    ? clipDuration(filesOf(source.item_id), source.file_key, source.item_id)
    : null
}

function member(
  source: MemberSource,
  spec: CollectionSpec,
  thumb: ThumbRef,
  sizeBytes: number,
  filesOf: FilesOf,
): CollectionMember {
  return {
    item_id: source.item_id,
    file_key: source.file_key,
    media: source.media,
    thumb,
    size_bytes: sizeBytes,
    duration_s: durationOf(source, filesOf),
    uploaded_on: spec.added_on,
    added_on: spec.added_on,
    handed_to: [],
    other_collections: [],
  }
}

/** Members of every collection; PRM-016 shares 38 materials with PRM-011 (DESIGN §9.3). */
export function buildLoraCollections(
  rawShoots: readonly RawShoot[],
  fypIds: readonly ItemId[],
  filesOf: FilesOf,
): CollectionRecord[] {
  const random = createRandom('lora-promo-members')
  const sources = memberSources(rawShoots, fypIds)
  const records = LORA_COLLECTIONS.map((spec) => {
    const count = spec.videos + spec.photos
    const picked = random.sample(sources, Math.min(count, sources.length))
    const perFile = Math.round(spec.size_bytes / Math.max(1, count))
    const ratio: ThumbRef['ratio'] = spec.channel === 'youtube' ? '16:9' : '9:16'
    return {
      id: collectionId(spec),
      channel: spec.channel,
      contractor_id: spec.contractor_id,
      // Видео и фото подборки — ровно в числах её описания: сначала видео, затем фото.
      members: picked.map((sampled, index) => {
        const media = index < spec.videos ? ('video' as const) : ('photo' as const)
        const key = `${sampled.item_id}/${sampled.file_key}`
        return member({ ...sampled, media }, spec, { key, ratio }, perFile, filesOf)
      }),
    }
  })
  shareMembers(records, 'PRM-011', 'PRM-016', 38)
  const teaser: MemberSource = { item_id: 'PPV-073', file_key: 'teaser', media: 'video' }
  addMember(records, 'PRM-014', teaser, filesOf)
  addMember(records, 'PRM-012', teaser, filesOf)
  linkOtherCollections(records)
  return records
}

function find(records: CollectionRecord[], id: ItemId): CollectionRecord {
  const record = records.find((candidate) => candidate.id === id)
  if (!record) throw new Error(`Нет подборки ${id}`)
  return record
}

function shareMembers(records: CollectionRecord[], fromId: ItemId, toId: ItemId, count: number) {
  const from = find(records, fromId)
  const to = find(records, toId)
  const shared = from.members
    .slice(0, count)
    .map((source) => ({ ...source, added_on: '2026-09-17' }))
  const fromKeys = new Set(from.members.map((member) => `${member.item_id}/${member.file_key}`))
  const own = to.members.filter((member) => !fromKeys.has(`${member.item_id}/${member.file_key}`))
  to.members = [...shared, ...own.slice(0, Math.max(0, to.members.length - count))]
}

function addMember(
  records: CollectionRecord[],
  id: ItemId,
  source: MemberSource,
  filesOf: FilesOf,
) {
  const record = find(records, id)
  const template = record.members[0]
  if (!template) return
  record.members.push({
    ...template,
    item_id: source.item_id,
    file_key: source.file_key,
    media: source.media,
    duration_s: durationOf(source, filesOf),
    thumb: { key: `${source.item_id}/${source.file_key}`, ratio: '9:16' },
  })
}

function linkOtherCollections(records: CollectionRecord[]) {
  const where = new Map<string, ItemId[]>()
  for (const record of records) {
    for (const item of record.members) {
      const key = `${item.item_id}/${item.file_key}`
      where.set(key, [...(where.get(key) ?? []), record.id])
    }
  }
  for (const record of records) {
    for (const item of record.members) {
      const all = where.get(`${item.item_id}/${item.file_key}`) ?? []
      item.other_collections = all.filter((id) => id !== record.id)
    }
  }
}
