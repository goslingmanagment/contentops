import { journalRoutes, operationRoutes } from '@contentops/contracts/api/routes/journal'
import { promoRoutes } from '@contentops/contracts/api/routes/promo'
import { CONTRACTOR_FORMAT_LABEL, type CollectionMember } from '@contentops/contracts/domain/promo'
import { PROMO_MANIFEST_NAME } from '@contentops/contracts/download-name'
import { formatBytes } from '@contentops/contracts/format'
import { notFound, rule } from '../domain-error'
import { clipDuration, synthesizeFiles, ydiskPathFor } from '../fixtures/item-files'
import type { CollectionRecord, HandoffRecord, ModelWorld } from '../fixtures/world-types'
import { type BoundRoute, bind, todayOf } from '../handler'
import { registerSample } from '../sample-files'
import type { MockState } from '../state'
import { journalPage } from '../views/journal'
import { wholeList } from '../views/paginate'
import {
  channelContents,
  collectionRecord,
  collectionView,
  handoffMembers,
  handoffOverlap,
  handoffView,
  handoffZip,
} from '../views/promo'
import { promoManifestHead, promoZipListing, promoZipMembers } from '../views/promo-zip'
import { actorSays } from './actor-says'
import { catalogChanged, newEntry, newRecord, nextItemId } from './model-records'

/** Promo collections and handoffs (DESIGN §4.17), the journal and long operations. */

const memberKey = (member: { item_id: string; file_key: string }) =>
  `${member.item_id}/${member.file_key}`

function refreshCounts(model: ModelWorld, collection: CollectionRecord) {
  const entry = model.items.get(collection.id)?.entry
  if (!entry) return
  entry.video_count = collection.members.filter((member) => member.media === 'video').length
  entry.photo_count = collection.members.filter((member) => member.media === 'photo').length
  entry.size_bytes = collection.members.reduce((sum, member) => sum + member.size_bytes, 0)
}

function newCollection(
  state: MockState,
  model: ModelWorld,
  channel: string,
  title: string | null,
): CollectionRecord {
  const id = nextItemId(model, 'promo')
  const entry = newEntry(id, 'promo', title ?? `Подборка ${id}`, todayOf(state))
  entry.channel = channel
  entry.cover = { key: id, ratio: channel === 'youtube' ? '16:9' : '3:4' }
  model.items.set(id, newRecord(entry, ydiskPathFor(entry)))
  const collection: CollectionRecord = { id, channel, contractor_id: null, members: [] }
  model.collections.set(id, collection)
  return collection
}

function memberFrom(
  state: MockState,
  model: ModelWorld,
  ref: { item_id: string; file_key: string },
): CollectionMember {
  const record = model.items.get(ref.item_id)
  if (!record) throw notFound(`${ref.item_id} нет`)
  const entry = record.entry
  const video = entry.type !== 'set' && entry.type !== 'life'
  const files = record.files ?? synthesizeFiles(entry)
  return {
    item_id: ref.item_id,
    file_key: ref.file_key,
    media: video ? 'video' : 'photo',
    thumb: { key: `${ref.item_id}/${ref.file_key}`, ratio: video ? '9:16' : '3:4' },
    size_bytes: video ? Math.round((entry.duration_s ?? 20) * 1_400_000) : 2_400_000,
    duration_s: video ? clipDuration(files, ref.file_key, ref.item_id) : null,
    uploaded_on: entry.arrived_on,
    added_on: todayOf(state),
    handed_to: [],
    other_collections: [],
  }
}

/** Materials leave «Без подборки» of their channel once they join a collection. */
function takeUnfiled(
  model: ModelWorld,
  channel: string,
  refs: readonly { item_id: string; file_key: string }[],
): Map<string, CollectionMember> {
  const waiting = model.promo_unfiled.get(channel) ?? []
  const wanted = new Set(refs.map(memberKey))
  const taken = new Map(
    waiting.filter((member) => wanted.has(memberKey(member))).map((m) => [memberKey(m), m]),
  )
  model.promo_unfiled.set(
    channel,
    waiting.filter((member) => !taken.has(memberKey(member))),
  )
  return taken
}

/** Handoffs being prepared follow their operation; a finished one becomes «подготовлено». */
/** What the ZIP of a handoff carries: the sample behind its address (`sample-files.ts`). */
function registerHandoffZip(state: MockState, model: ModelWorld, handoff: HandoffRecord) {
  const zip = handoffZip(model, handoff)
  const contractor = state.world.contractors.find(
    (candidate) => candidate.id === handoff.contractor_id,
  )
  const title = model.items.get(handoff.collection_id)?.entry.title ?? handoff.collection_id
  const format = contractor ? ` · ${CONTRACTOR_FORMAT_LABEL[contractor.format]}` : ''
  const members = promoZipMembers(model, handoff)
  registerSample(state, zip.url, {
    file_name: zip.name,
    kind: `ZIP передачи${format}`,
    size_bytes: handoff.size_bytes,
    source: `Промо · подборка ${handoff.collection_id} «${title}» · для ${contractor?.name ?? handoff.contractor_id}`,
    meta_stripped: handoff.strip_metadata,
    members: promoZipListing(members),
    appendix: {
      name: PROMO_MANIFEST_NAME,
      lines: promoManifestHead(handoff, members, contractor?.format ?? null),
    },
  })
  return zip
}

/** Progress of handoffs being prepared, and the ZIP behind every handoff the reader sees. */
function syncHandoffs(state: MockState, model: ModelWorld) {
  for (const handoff of model.handoffs) {
    registerHandoffZip(state, model, handoff)
    if (!handoff.operation_id || handoff.state !== 'preparing') continue
    const operation = state.operations.view(handoff.operation_id)
    if (operation && handoff.state === 'preparing') handoff.progress = operation.progress
  }
}

function handoffOf(model: ModelWorld, id: string): HandoffRecord {
  const handoff = model.handoffs.find((candidate) => candidate.id === id)
  if (!handoff) throw notFound('Такой передачи нет')
  return handoff
}

export function promoHandlers(): BoundRoute[] {
  return [
    bind(promoRoutes.channels, 'read', ({ model }) => wholeList(model().channels)),
    bind(promoRoutes.channel, 'read', ({ state, model, params }) => {
      syncHandoffs(state, model())
      return channelContents(state.world, model(), params.channel, todayOf(state))
    }),
    bind(promoRoutes.collection, 'read', ({ state, model, params }) => {
      syncHandoffs(state, model())
      return collectionView(state.world, model(), params.collection, todayOf(state))
    }),
    bind(promoRoutes.add, 'staff', (context) => {
      const model = context.model()
      const { body, state } = context
      const collection =
        body.collection === 'new'
          ? newCollection(state, model, body.channel, body.title)
          : collectionRecord(model, body.collection)
      const present = new Set(collection.members.map(memberKey))
      const added = body.members.filter((member) => !present.has(memberKey(member)))
      const unfiled = takeUnfiled(model, collection.channel, added)
      collection.members.push(
        ...added.map((member) => {
          const waiting = unfiled.get(memberKey(member))
          return waiting
            ? { ...waiting, added_on: todayOf(state) }
            : memberFrom(state, model, member)
        }),
      )
      refreshCounts(model, collection)
      catalogChanged(model)
      context.log({
        area: 'promo',
        action: 'promo.add',
        phrase: `${actorSays(state, 'добавил')} ${added.length} материалов в ${collection.id}`,
        item_id: collection.id,
      })
      return collectionView(state.world, model, collection.id, todayOf(state))
    }),
    bind(promoRoutes.remove, 'staff', (context) => {
      const model = context.model()
      const collection = collectionRecord(model, context.params.collection)
      const removed = new Set(context.body.members.map(memberKey))
      collection.members = collection.members.filter((member) => !removed.has(memberKey(member)))
      refreshCounts(model, collection)
      catalogChanged(model)
      return collectionView(context.state.world, model, collection.id, todayOf(context.state))
    }),
    bind(promoRoutes.handoffCheck, 'read', ({ state, model, params, query }) =>
      handoffOverlap(state.world, model(), params.collection, query.contractor, todayOf(state)),
    ),
    bind(promoRoutes.prepareHandoff, 'staff', (context) => {
      const model = context.model()
      const { state, body } = context
      const collection = collectionRecord(model, context.params.collection)
      const contractor = state.world.contractors.find(
        (candidate) => candidate.id === body.contractor_id,
      )
      if (!contractor) throw notFound('Такого подрядчика нет')
      const members = handoffMembers(state.world, model, collection.id, {
        contractorId: contractor.id,
        excludeAlreadyHanded: body.exclude_already_handed,
        only: body.members,
      })
      if (members.length === 0)
        throw rule('invalid_request', 'Не выполнено: всё уже передавали этому подрядчику')
      const handoff: HandoffRecord = {
        id: `h-${collection.id.toLowerCase()}-${model.handoffs.length + 1}`,
        collection_id: collection.id,
        contractor_id: contractor.id,
        state: 'preparing',
        progress: 0,
        video_count: members.filter((member) => member.media === 'video').length,
        photo_count: members.filter((member) => member.media === 'photo').length,
        size_bytes: members.reduce((sum, member) => sum + member.size_bytes, 0),
        strip_metadata: body.strip_metadata,
        created_at: state.clock.now(),
        sent_on: null,
        failure: null,
        operation_id: null,
        recorded_by: state.principal.id,
        members: members.map(memberKey),
      }
      const zip = registerHandoffZip(state, model, handoff)
      const operation = state.operations.start({
        model: model.model.code,
        kind: 'handoff',
        label: `Передача ${collection.id} готовится · ${formatBytes(handoff.size_bytes)}`,
        done_label: `Передача ${collection.id} готова`,
        result: { download_url: zip.url, file_name: zip.name, size_bytes: handoff.size_bytes },
        on_done: () => {
          handoff.state = 'prepared'
          handoff.progress = 1
        },
      })
      handoff.operation_id = operation.id
      model.handoffs.push(handoff)
      context.log({
        area: 'promo',
        action: 'handoff.prepare',
        phrase: `${actorSays(state, 'начал')} готовить передачу ${collection.id} для ${contractor.name}`,
        item_id: collection.id,
      })
      return {
        kind: 'operation',
        operation_id: operation.id,
        status_url: operation.status_url,
        handoff_id: handoff.id,
      }
    }),
    bind(promoRoutes.markSent, 'staff', (context) => {
      const model = context.model()
      const handoff = handoffOf(model, context.params.handoff)
      syncHandoffs(context.state, model)
      if (handoff.state !== 'prepared')
        throw rule('handoff_not_ready', 'Не выполнено: передача ещё готовится')
      handoff.state = 'sent'
      handoff.sent_on = todayOf(context.state)
      const channel = model.channels.find(
        (candidate) => candidate.id === model.collections.get(handoff.collection_id)?.channel,
      )
      if (channel) channel.last_handoff_on = handoff.sent_on
      context.log({
        area: 'promo',
        action: 'handoff.sent',
        phrase: `${actorSays(context.state, 'отметил')} передачу ${handoff.collection_id} переданной`,
        item_id: handoff.collection_id,
      })
      return handoffView(context.state.world, model, handoff, todayOf(context.state))
    }),
    bind(promoRoutes.contractors, 'read', ({ state }) => wholeList(state.world.contractors)),
    bind(promoRoutes.handoffs, 'read', ({ state, model }) => {
      const current = model()
      syncHandoffs(state, current)
      return wholeList(
        [...current.handoffs]
          .sort((left, right) => right.created_at.localeCompare(left.created_at))
          .map((handoff) => handoffView(state.world, current, handoff, todayOf(state))),
      )
    }),
    bind(journalRoutes.list, 'read', ({ model, query, state }) =>
      journalPage(model(), query, state.principal.role),
    ),
    bind(operationRoutes.get, 'read', ({ state, params }) => {
      const operation = state.operations.view(params.operation)
      if (!operation) throw notFound('Такой операции нет')
      return operation
    }),
  ]
}
