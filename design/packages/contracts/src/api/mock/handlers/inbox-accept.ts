import type { AcceptCommand, ExtendRole } from '../../../commands/inbox'
import type { CatalogEntry } from '../../../domain/catalog'
import type { AcceptHow, AcceptResult, InboxGroup, ReadyNote } from '../../../domain/inbox'
import type { ItemId } from '../../../domain/item-type'
import type { CollectionMember } from '../../../domain/promo'
import { ydiskPathFor } from '../../../fixtures/item-files'
import type { InboxRecord, ModelWorld } from '../../../fixtures/world-types'
import { computeOrderStatus } from '../../../order-status'
import { rule } from '../domain-error'
import { todayOf } from '../handler'
import type { MockState } from '../state'
import { actorSays } from './actor-says'
import { catalogChanged, newEntry, newRecord, nextItemId, touch } from './model-records'

/** «Принять» (DESIGN §4.8): a new object, an addition, a delivery, a fix or promo material. */

interface Accepted {
  item_id: ItemId
  how: AcceptHow
  next_step: string | null
}

function countFiles(group: InboxGroup) {
  const videos = group.files.filter((file) => file.media === 'video')
  const photos = group.files.filter((file) => file.media === 'photo')
  const master = videos.find((file) => file.role === 'master') ?? videos[0]
  return { videos, photos, master }
}

function createItem(state: MockState, model: ModelWorld, group: InboxGroup): ItemId {
  const type = group.fields.type
  if (!type) throw rule('accept_blocked', 'Сначала выберите тип')
  const id = nextItemId(model, type)
  const entry = newEntry(id, type, group.fields.title || group.title, todayOf(state))
  const { videos, photos, master } = countFiles(group)
  entry.tags = [...group.fields.tags]
  entry.shot_on = group.fields.shot_on ?? entry.shot_on
  entry.second_person = group.fields.second_person
  entry.duration_s = type === 'set' || type === 'life' ? null : (master?.duration_s ?? null)
  entry.photo_count = photos.length
  entry.video_count = videos.length
  entry.has_teaser = group.files.some((file) => file.role === 'teaser')
  if (type === 'ppv') entry.ppv_kind = group.fields.ppv_kind ?? 'bundle'
  if (type === 'set') {
    entry.selected_count = 0
    entry.processed_count = 0
  }
  if (type === 'life') {
    entry.life_unassigned = photos.length
    entry.life_chat_count = 0
    entry.life_feed_count = 0
  }
  if (type === 'raw') entry.raw_purpose = group.fields.raw_purpose ?? 'unknown'
  if (type === 'custom') {
    entry.fan_name = group.fields.fan_name ?? 'unknown'
    entry.delivered_on = todayOf(state)
    entry.order_id = group.fields.order_id
  }
  if (type === 'promo') {
    entry.channel = group.fields.channel
    entry.size_bytes = group.size_bytes
  }
  model.items.set(id, newRecord(entry, ydiskPathFor(entry)))
  return id
}

function nextStepFor(model: ModelWorld, itemId: ItemId): string | null {
  const entry = model.items.get(itemId)?.entry
  if (!entry) return null
  if (entry.type === 'set') return 'Отобрать кадры'
  if (entry.type === 'life') return 'Лента / чаты'
  if (entry.type === 'ppv') return entry.has_teaser ? 'В план' : 'Добавить тизер'
  if (entry.type === 'fyp') return 'В план'
  return null
}

/** How the files change the object they join: more photos, a teaser or a new master version. */
const EXTEND_EFFECT: Record<ExtendRole, (entry: CatalogEntry, group: InboxGroup) => void> = {
  photos: (entry, group) => {
    entry.photo_count = (entry.photo_count ?? 0) + countFiles(group).photos.length
  },
  teaser: (entry) => {
    entry.has_teaser = true
  },
  master_version: (entry, group) => {
    entry.version_count += 1
    entry.duration_s = countFiles(group).master?.duration_s ?? entry.duration_s
  },
}

function extend(
  model: ModelWorld,
  group: InboxGroup,
  target: ItemId,
  role: ExtendRole = 'photos',
): Accepted {
  const record = model.items.get(target)
  if (!record) throw rule('accept_blocked', `${target} нет в каталоге`)
  EXTEND_EFFECT[role](record.entry, group)
  record.files = null
  touch(record)
  return {
    item_id: target,
    how: 'extend',
    next_step: record.entry.type === 'set' ? 'Отобрать кадры' : null,
  }
}

function fix(state: MockState, model: ModelWorld, target: ItemId, revisionId: string): Accepted {
  const record = model.items.get(target)
  if (!record) throw rule('accept_blocked', `${target} нет в каталоге`)
  record.entry.version_count += 1
  record.files = null
  touch(record)
  const order = model.orders.find((candidate) =>
    candidate.revisions.some((revision) => revision.id === revisionId),
  )
  const revision = order?.revisions.find((candidate) => candidate.id === revisionId)
  if (order && revision) {
    revision.done = {
      basis: 'new_version',
      by: state.actor,
      at: state.clock.now(),
      version_label: `новая версия ${target}`,
    }
    order.version += 1
  }
  return { item_id: target, how: 'fix', next_step: 'Закрыть заказ' }
}

function deliver(
  state: MockState,
  model: ModelWorld,
  group: InboxGroup,
  orderId: string,
): Accepted {
  const itemId = createItem(state, model, group)
  const order = model.orders.find((candidate) => candidate.id === orderId)
  if (order) {
    const entry = model.items.get(itemId)?.entry
    if (entry) entry.order_id = order.id
    const video = order.parts.find((part) => part.kind === 'video')
    if (video) {
      video.delivered = 1
      video.item_id = itemId
      video.delivered_on = todayOf(state)
      video.duration_s = entry?.duration_s ?? null
    }
    order.deliveries.push({
      id: `dl-${itemId}`,
      item_id: itemId,
      matched: group.candidates.find((candidate) => candidate.order_id === orderId)?.matched ?? [
        'раздел Customs',
      ],
      linked_by: state.actor,
      confirmed_by: state.actor,
      at: state.clock.now(),
    })
    order.version += 1
  }
  const complete = order
    ? computeOrderStatus(order, state.clock.now(), model.model.name_genitive).state === 'delivered'
    : false
  return { item_id: itemId, how: 'delivery', next_step: complete ? 'Закрыть заказ' : null }
}

function promo(state: MockState, model: ModelWorld, group: InboxGroup): Accepted {
  const existing =
    group.fields.collection && group.fields.collection !== 'new'
      ? model.collections.get(group.fields.collection)
      : undefined
  const id =
    existing?.id ??
    createItem(state, model, { ...group, fields: { ...group.fields, type: 'promo' } })
  const collection = existing ?? {
    id,
    channel: group.fields.channel ?? 'instagram',
    contractor_id: null,
    members: [],
  }
  const members: CollectionMember[] = group.files.map((file) => ({
    item_id: id,
    file_key: file.key,
    media: file.media,
    thumb: file.thumb,
    size_bytes: file.size_bytes,
    duration_s: file.media === 'video' ? file.duration_s : null,
    uploaded_on: todayOf(state),
    added_on: todayOf(state),
    handed_to: [],
    other_collections: [],
  }))
  collection.members.push(...members)
  model.collections.set(id, collection)
  return { item_id: id, how: 'new', next_step: null }
}

function acceptByNote(
  state: MockState,
  model: ModelWorld,
  record: InboxRecord,
  note: ReadyNote,
): Accepted {
  const group = record.group
  switch (note.kind) {
    case 'extends':
      return extend(model, group, note.item_id)
    case 'fix_of':
      return fix(state, model, note.item_id, note.revision_id)
    case 'order_part':
      return deliver(state, model, group, note.order_id)
    case 'promo':
      return promo(state, model, group)
    default: {
      const itemId = createItem(state, model, group)
      return { item_id: itemId, how: 'new', next_step: nextStepFor(model, itemId) }
    }
  }
}

function noteFor(command: AcceptCommand, ready: ReadyNote): ReadyNote {
  if (command.extend) return { kind: 'extends', item_id: command.extend.item_id }
  return command.as === 'separate' ? { kind: 'new' } : ready
}

/**
 * Accepts one ready group; a group that is not ready is refused with its reason. A ready
 * group can still wait for its number: «Номер выдадим после разбора старого Я.Диска».
 */
export function acceptGroup(
  state: MockState,
  model: ModelWorld,
  record: InboxRecord,
  command: AcceptCommand,
  log: (phrase: string, itemId: ItemId) => void,
): AcceptResult {
  const group = record.group
  if (group.state.kind !== 'ready') {
    throw rule('accept_blocked', group.accept_block ?? 'Группа ещё не готова', {
      reason: group.accept_block,
    })
  }
  if (group.accept_block && !command.extend) {
    throw rule('number_not_issued', group.accept_block, { reason: group.accept_block })
  }
  const note = noteFor(command, group.state.note)
  const accepted =
    note.kind === 'extends' && command.extend
      ? extend(model, group, note.item_id, command.extend.role)
      : acceptByNote(state, model, record, note)
  group.state = {
    kind: 'accepted',
    item_id: accepted.item_id,
    how: accepted.how,
    by: state.actor,
    at: state.clock.now(),
  }
  group.version += 1
  catalogChanged(model)
  log(
    `${actorSays(state, 'принял')} ${accepted.item_id} из «${group.source_path.replaceAll(' / ', '/')}»`,
    accepted.item_id,
  )
  return accepted
}
