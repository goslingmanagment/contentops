import type { LocalDate, StatusWord } from '../../../domain/common'
import type { ItemId } from '../../../domain/item-type'
import type {
  ChannelContents,
  CollectionMember,
  Handoff,
  HandoffOverlap,
  PromoCollection,
} from '../../../domain/promo'
import { actorOf } from '../../../fixtures/people'
import type {
  CollectionRecord,
  HandoffRecord,
  ModelWorld,
  World,
} from '../../../fixtures/world-types'
import { formatBytes } from '../../../format'
import { computeHandoffOverlap, handedTo } from '../../../handoff-overlap'
import { computeHandoffStatus } from '../../../handoff-status'
import { notFound } from '../domain-error'
import { promoZipListing, promoZipMembers } from './promo-zip'

/** Promo channels, collections and handoffs (DESIGN §4.17). */

/** A folder mosaic shows up to four frames (four for landscape YouTube, DESIGN §4.17). */
const MOSAIC_COVERS = 4

function contractorName(world: World, id: string): string {
  return world.contractors.find((contractor) => contractor.id === id)?.name ?? id
}

export function handoffStatus(world: World, handoff: HandoffRecord, today: LocalDate): StatusWord {
  return computeHandoffStatus(
    {
      state: handoff.state,
      contractor_name: contractorName(world, handoff.contractor_id),
      size_bytes: handoff.size_bytes,
      progress: handoff.progress,
      sent_on: handoff.sent_on,
      failure: handoff.failure,
    },
    today,
  )
}

function summaryText(model: ModelWorld, handoff: HandoffRecord): string {
  const title = model.items.get(handoff.collection_id)?.entry.title ?? handoff.collection_id
  const parts = [title]
  if (handoff.video_count > 0) parts.push(`${handoff.video_count} видео`)
  if (handoff.photo_count > 0) parts.push(`${handoff.photo_count} фото`)
  parts.push(formatBytes(handoff.size_bytes))
  return parts.join(' · ')
}

/** The ZIP of a handoff: `PRM-015_garantteam.zip`, served at one address per handoff. */
export function handoffZip(model: ModelWorld, handoff: HandoffRecord) {
  return {
    name: `${handoff.collection_id}_${handoff.contractor_id.replace(/^c-/, '')}.zip`,
    url: `/api/v1/${model.model.code}/promo/handoffs/${handoff.id}.zip`,
  }
}

export function handoffView(
  world: World,
  model: ModelWorld,
  handoff: HandoffRecord,
  today: LocalDate,
): Handoff {
  const ready = handoff.state === 'prepared' || handoff.state === 'sent'
  return {
    id: handoff.id,
    collection_id: handoff.collection_id,
    contractor_id: handoff.contractor_id,
    contractor_name: contractorName(world, handoff.contractor_id),
    state: handoff.state,
    progress: handoff.progress,
    video_count: handoff.video_count,
    photo_count: handoff.photo_count,
    size_bytes: handoff.size_bytes,
    strip_metadata: handoff.strip_metadata,
    created_at: handoff.created_at,
    sent_on: handoff.sent_on,
    failure: handoff.failure,
    summary_text: summaryText(model, handoff),
    zip_name: ready ? handoffZip(model, handoff).name : null,
    zip_url: ready ? handoffZip(model, handoff).url : null,
    member_keys: handoff.members,
    zip_files: ready ? promoZipListing(promoZipMembers(model, handoff)) : [],
    operation_id: handoff.operation_id,
    recorded_by: actorOf(handoff.recorded_by, world.people),
    status: handoffStatus(world, handoff, today),
  }
}

const memberKey = (member: Pick<CollectionMember, 'item_id' | 'file_key'>) =>
  `${member.item_id}/${member.file_key}`

interface HandedEntry {
  contractor_id: string
  contractor: string
  on: string
  collection: ItemId
}

/** Which materials each contractor already got: the members each sent handoff carried. */
function handedOut(world: World, model: ModelWorld): Map<string, HandedEntry[]> {
  const result = new Map<string, HandedEntry[]>()
  for (const handoff of model.handoffs) {
    if (handoff.state !== 'sent' || !handoff.sent_on) continue
    const entry: HandedEntry = {
      contractor_id: handoff.contractor_id,
      contractor: contractorName(world, handoff.contractor_id),
      on: handoff.sent_on,
      collection: handoff.collection_id,
    }
    for (const key of handoff.members) {
      result.set(key, [...(result.get(key) ?? []), entry])
    }
  }
  return result
}

type HandedOut = ReturnType<typeof handedOut>

/** «GaranTTeam 18.09 (PRM-015)» on a material, from sent handoffs, oldest first. */
function withHanded(member: CollectionMember, given: HandedOut): CollectionMember {
  return {
    ...member,
    handed_to: (given.get(memberKey(member)) ?? [])
      .map((entry) => ({
        contractor_id: entry.contractor_id,
        contractor: entry.contractor,
        collection_id: entry.collection,
        on: entry.on,
      }))
      .sort((left, right) => left.on.localeCompare(right.on)),
  }
}

export function collectionRecord(model: ModelWorld, id: string): CollectionRecord {
  const record = model.collections.get(id)
  if (!record) throw notFound(`Подборки ${id} нет`)
  return record
}

export function collectionView(
  world: World,
  model: ModelWorld,
  id: string,
  today: LocalDate,
): PromoCollection {
  const record = collectionRecord(model, id)
  const entry = model.items.get(record.id)?.entry
  const given = handedOut(world, model)
  const handoffs = model.handoffs
    .filter((handoff) => handoff.collection_id === record.id)
    .map((handoff) => handoffView(world, model, handoff, today))
  const last = handoffs.at(-1)
  return {
    id: record.id,
    title: entry?.title ?? record.id,
    channel: record.channel,
    video_count:
      entry?.video_count ?? record.members.filter((member) => member.media === 'video').length,
    photo_count:
      entry?.photo_count ?? record.members.filter((member) => member.media === 'photo').length,
    size_bytes:
      entry?.size_bytes ?? record.members.reduce((sum, member) => sum + member.size_bytes, 0),
    contractor_id: record.contractor_id,
    members: record.members.map((member) => withHanded(member, given)),
    handoffs,
    covers: record.members.slice(0, MOSAIC_COVERS).map((member) => member.thumb),
    status: last?.status ?? null,
  }
}

export function channelContents(
  world: World,
  model: ModelWorld,
  channelId: string,
  today: LocalDate,
): ChannelContents {
  const channel = model.channels.find((candidate) => candidate.id === channelId)
  if (!channel) throw notFound(`Канала ${channelId} нет`)
  const collections = [...model.collections.values()]
    .filter((record) => record.channel === channelId)
    .map((record) => {
      const { members: _members, ...rest } = collectionView(world, model, record.id, today)
      return rest
    })
  const given = handedOut(world, model)
  const unfiled = (model.promo_unfiled.get(channelId) ?? []).map((member) =>
    withHanded(member, given),
  )
  return { channel, collections, unfiled }
}

/** Materials of a collection with «передавали» filled in from sent handoffs. */
function membersWithHanded(world: World, model: ModelWorld, id: string): CollectionMember[] {
  const given = handedOut(world, model)
  return collectionRecord(model, id).members.map((member) => withHanded(member, given))
}

/** «38 из 100 уже передавали Coraline Red (PRM-011, 02.09) · Убрать их · Оставить». */
export function handoffOverlap(
  world: World,
  model: ModelWorld,
  id: string,
  contractorId: string,
  today: LocalDate,
): HandoffOverlap {
  return computeHandoffOverlap(
    membersWithHanded(world, model, id),
    { id: contractorId, name: contractorName(world, contractorId) },
    today,
  )
}

/**
 * Materials a new handoff carries: the whole collection or the selection in it, and after
 * «Убрать их» only what the contractor has not got yet.
 */
export function handoffMembers(
  world: World,
  model: ModelWorld,
  id: string,
  options: {
    contractorId: string
    excludeAlreadyHanded: boolean
    only: readonly Pick<CollectionMember, 'item_id' | 'file_key'>[] | null
  },
): CollectionMember[] {
  const wanted = options.only ? new Set(options.only.map(memberKey)) : null
  return membersWithHanded(world, model, id).filter(
    (member) =>
      (!wanted || wanted.has(memberKey(member))) &&
      !(options.excludeAlreadyHanded && handedTo(member, options.contractorId)),
  )
}
