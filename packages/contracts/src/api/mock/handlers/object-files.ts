import type { CatalogEntry } from '../../../domain/catalog'
import { FILE_ROLE_LABEL, type ItemFile } from '../../../domain/files'
import type { ItemId } from '../../../domain/item-type'
import type { ProvenanceLink } from '../../../domain/provenance'
import { selectionDelivery } from '../../../download-files'
import { synthesizeFiles, synthesizeFrames, ydiskPathFor } from '../../../fixtures/item-files'
import type { ItemRecord, ModelWorld } from '../../../fixtures/world-types'
import { objectFileRoutes } from '../../routes/object-files'
import { rule } from '../domain-error'
import { type BoundRoute, bind, todayOf } from '../handler'
import { registerSample } from '../sample-files'
import { itemDetail, recordOf } from '../views/item'
import { actorSays } from './actor-says'
import { catalogChanged, newEntry, newRecord, nextItemId, touch } from './model-records'

/** Files inside one object (DESIGN §4.5): order, picks, purposes, builds from frames. */

const pad = (value: number) => String(value).padStart(2, '0')

/** Materializes synthesized files before a change, so edits persist. */
export function filesOf(record: ItemRecord): ItemFile[] {
  record.files ??= synthesizeFiles(record.entry)
  return record.files
}

function pickFiles(record: ItemRecord, keys: readonly string[]): ItemFile[] {
  const files = filesOf(record)
  const picked = keys.map((key) => files.find((file) => file.key === key))
  if (picked.some((file) => file === undefined)) {
    throw rule('invalid_request', 'Таких файлов в объекте нет')
  }
  return picked.filter((file): file is ItemFile => file !== undefined)
}

const MAIN_VIDEO_ROLES: readonly ItemFile['role'][] = ['master', 'teaser', 'montage', 'source']

/** Counts the index keeps for instant filters; `null` stays `null` («не про этот тип»). */
export function recount(entry: CatalogEntry, files: readonly ItemFile[]) {
  const photos = files.filter((file) => file.media === 'photo')
  const extraVideos = files.filter(
    (file) => file.media === 'video' && !MAIN_VIDEO_ROLES.includes(file.role),
  )
  if (entry.photo_count !== null) entry.photo_count = photos.length
  if (entry.video_count !== null) entry.video_count = extraVideos.length
  if (entry.type === 'ppv') entry.has_teaser = files.some((file) => file.role === 'teaser')
  if (entry.type === 'set') {
    entry.selected_count = photos.filter((file) => file.selected).length
    entry.processed_count = photos.filter((file) => file.processed).length
  }
  if (entry.type === 'life') {
    entry.life_unassigned = photos.filter((file) => file.assignment === null).length
    entry.life_chat_count = photos.filter(
      (file) => file.assignment === 'chats' || file.assignment === 'both',
    ).length
    entry.life_feed_count = photos.filter(
      (file) => file.assignment === 'feed' || file.assignment === 'both',
    ).length
  }
}

/** Files named in the command get positions 1…n in its order; the rest keep theirs. */
function applyOrder(files: readonly ItemFile[], keys: readonly string[]) {
  keys.forEach((key, index) => {
    const file = files.find((candidate) => candidate.key === key)
    if (file) file.position = index + 1
  })
}

function nextPosition(files: readonly ItemFile[], among: (file: ItemFile) => boolean): number {
  return files.filter(among).reduce((max, file) => Math.max(max, file.position ?? 0), 0) + 1
}

function nextPhotoKey(files: readonly ItemFile[], prefix: string): string {
  let number = files.length + 1
  while (files.some((file) => file.key === `${prefix}${pad(number)}`)) number += 1
  return `${prefix}${pad(number)}`
}

function photoFromFrame(record: ItemRecord, t_s: number, key: string, position: number): ItemFile {
  const frames = record.frames ?? synthesizeFrames(record.entry)
  const frame = frames.find((candidate) => candidate.t_s === t_s)
  if (!frame) throw rule('invalid_request', 'Такого кадра у мастера нет')
  const minutes = Math.floor(t_s / 60)
  return {
    key,
    role: 'photo',
    label: `фото ${position}`,
    media: 'photo',
    position,
    file_name: `frame_${minutes}m${pad(Math.round(t_s % 60))}s.jpg`,
    duration_s: null,
    width: 2160,
    height: 3840,
    size_bytes: 3_100_000,
    thumb: frame.thumb,
    current_version: 1,
    versions: [{ no: 1, on: record.entry.arrived_on, reason: null, duration_s: null }],
    state: { kind: 'ready' },
    selected: null,
    processed: null,
    assignment: null,
    flags: [],
    shot_at: null,
    source: null,
  }
}

function requireRaw(record: ItemRecord) {
  if (record.entry.type !== 'raw') throw rule('invalid_request', 'Это можно только у сырья')
}

function link(
  id: string,
  relation: ProvenanceLink['relation'],
  direction: ProvenanceLink['direction'],
  other: ItemRecord,
): ProvenanceLink {
  return {
    id,
    relation,
    direction,
    item_id: other.entry.id,
    item_type: other.entry.type,
    item_title: other.entry.title,
    extra: null,
    confirmed: true,
  }
}

/** Writes the link on both objects: «Выделен из → RAW-0214» and «Выделено из него ← …». */
function linkBoth(
  from: ItemRecord,
  to: ItemRecord,
  relation: ProvenanceLink['relation'],
  id: string,
) {
  from.provenance.push(link(id, relation, 'out', to))
  to.provenance.push(link(`${id}-back`, relation, 'in', from))
}

function newRawFrom(model: ModelWorld, source: ItemRecord, today: string): ItemRecord {
  const id = nextItemId(model, 'raw')
  const entry = newEntry(id, 'raw', source.entry.title, today)
  entry.shot_on = source.entry.shot_on
  entry.raw_purpose = 'unknown'
  entry.photo_count = 0
  entry.video_count = 0
  entry.cover = { key: id, ratio: '3:4' }
  const record = newRecord(entry, ydiskPathFor(entry))
  record.files = []
  model.items.set(id, record)
  return record
}

export function objectFileHandlers(): BoundRoute[] {
  return [
    bind(objectFileRoutes.reorder, 'staff', (context) => {
      const facts = context.facts()
      const record = recordOf(facts, context.params.id)
      context.requireVersion(record.version)
      pickFiles(record, context.body.keys)
      applyOrder(filesOf(record), context.body.keys)
      touch(record)
      catalogChanged(facts.model)
      context.log({
        area: 'catalog',
        action: 'files.reorder',
        phrase: `${actorSays(context.state, 'изменил')} порядок файлов ${record.entry.id}`,
        item_id: record.entry.id,
      })
      return itemDetail(facts, record.entry.id, context.state.principal.role)
    }),
    bind(objectFileRoutes.pick, 'staff', (context) => {
      const facts = context.facts()
      const record = recordOf(facts, context.params.id)
      if (record.entry.type !== 'set') throw rule('invalid_request', 'Кадры отбираются у сета')
      const files = filesOf(record)
      for (const file of pickFiles(record, context.body.keys)) {
        if (file.selected === context.body.selected) continue
        if (context.body.selected) {
          file.position = nextPosition(files, (candidate) => candidate.selected === true)
        }
        file.selected = context.body.selected
      }
      recount(record.entry, files)
      touch(record)
      catalogChanged(facts.model)
      return itemDetail(facts, record.entry.id, context.state.principal.role)
    }),
    bind(objectFileRoutes.assign, 'staff', (context) => {
      const facts = context.facts()
      const record = recordOf(facts, context.params.id)
      if (record.entry.type !== 'life') throw rule('invalid_request', 'Назначение — у лайфа')
      for (const file of pickFiles(record, context.body.keys)) {
        file.assignment = context.body.assignment
      }
      recount(record.entry, filesOf(record))
      touch(record)
      catalogChanged(facts.model)
      context.log({
        area: 'catalog',
        action: 'files.assign',
        phrase: `${actorSays(context.state, 'назначил')} кадры ${record.entry.id}: ${context.body.keys.length}`,
        item_id: record.entry.id,
      })
      return itemDetail(facts, record.entry.id, context.state.principal.role)
    }),
    bind(objectFileRoutes.remove, 'staff', (context) => {
      const facts = context.facts()
      const record = recordOf(facts, context.params.id)
      context.requireVersion(record.version)
      const removed = new Set(pickFiles(record, context.body.keys).map((file) => file.key))
      if (removed.has('master')) throw rule('invalid_request', 'Мастер из объекта не убирается')
      record.files = filesOf(record).filter((file) => !removed.has(file.key))
      recount(record.entry, record.files)
      touch(record)
      catalogChanged(facts.model)
      context.log({
        area: 'catalog',
        action: 'files.remove',
        phrase: `${actorSays(context.state, 'убрал')} из ${record.entry.id} файлов: ${removed.size}`,
        item_id: record.entry.id,
      })
      return itemDetail(facts, record.entry.id, context.state.principal.role)
    }),
    bind(objectFileRoutes.download, 'staff', (context) => {
      const record = recordOf(context.facts(), context.params.id)
      const files = pickFiles(record, context.body.keys)
      const single = files.length === 1 ? files[0] : undefined
      const delivery = selectionDelivery(record.entry, filesOf(record), files)
      const fileName = delivery.name
      const sizeBytes = files.reduce((sum, file) => sum + file.size_bytes, 0)
      record.receipts.unshift({
        id: `rc-${record.entry.id}-${record.receipts.length + 1}`,
        file_name: fileName,
        by: context.state.actor,
        at: context.state.clock.now(),
        meta_stripped: context.body.strip_metadata,
        plan_row_id: null,
      })
      const url = `/api/v1/${context.params.model}/a/${record.entry.id}/files?name=${encodeURIComponent(fileName)}`
      registerSample(context.state, url, {
        file_name: fileName,
        kind: single ? `Файл объекта — ${FILE_ROLE_LABEL[single.role]}` : 'Архив выбранных файлов',
        size_bytes: sizeBytes,
        source: `${record.entry.id} «${record.entry.title}» · Я.Диск: ${record.ydisk_path}`,
        meta_stripped: context.body.strip_metadata,
        members: delivery.archive ? delivery.files.map((member) => member.name) : [],
      })
      return {
        kind: 'ready' as const,
        download_url: url,
        file_name: fileName,
        size_bytes: sizeBytes,
      }
    }),
    bind(objectFileRoutes.makePhotos, 'staff', (context) => {
      const facts = context.facts()
      const record = recordOf(facts, context.params.id)
      const frames = [...context.body.frames]
      // Validate the frames now: a wrong one is a 400 at once, not a failed build later.
      for (const t_s of frames) photoFromFrame(record, t_s, 'check', 1)
      const operation = context.state.operations.start({
        model: facts.model.model.code,
        kind: 'make_photo',
        label: `Фото из кадров собираются · ${record.entry.id}`,
        done_label: `Фото из кадров готовы · ${record.entry.id}`,
        result: { download_url: null, file_name: null, size_bytes: null },
        on_done: () => {
          const files = filesOf(record)
          for (const t_s of frames) {
            const position = nextPosition(files, (file) => file.role === 'photo')
            files.push(photoFromFrame(record, t_s, nextPhotoKey(files, 'ph'), position))
          }
          recount(record.entry, files)
          touch(record)
          catalogChanged(facts.model)
        },
      })
      context.log({
        area: 'catalog',
        action: 'frames.make_photos',
        phrase: `${actorSays(context.state, 'сделал')} фото из кадров ${record.entry.id}: ${frames.length}`,
        item_id: record.entry.id,
      })
      return { kind: 'operation', operation_id: operation.id, status_url: operation.status_url }
    }),
    bind(objectFileRoutes.makeCover, 'staff', (context) => {
      const facts = context.facts()
      const record = recordOf(facts, context.params.id)
      const { body } = context
      const thumb =
        body.from === 'frame'
          ? (record.frames ?? synthesizeFrames(record.entry)).find(
              (frame) => frame.t_s === body.t_s,
            )?.thumb
          : pickFiles(record, [body.key])[0]?.thumb
      if (!thumb) throw rule('invalid_request', 'Такого кадра у мастера нет')
      const operation = context.state.operations.start({
        model: facts.model.model.code,
        kind: 'make_cover',
        label: `Обложка собирается · ${record.entry.id}`,
        done_label: `Обложка готова · ${record.entry.id}`,
        result: { download_url: null, file_name: null, size_bytes: null },
        on_done: () => {
          record.entry.cover = { key: thumb.key, ratio: record.entry.cover.ratio }
          touch(record)
          catalogChanged(facts.model)
        },
      })
      return { kind: 'operation', operation_id: operation.id, status_url: operation.status_url }
    }),
    bind(objectFileRoutes.buildFypVersions, 'staff', (context) => {
      const facts = context.facts()
      const record = recordOf(facts, context.params.id)
      if (record.entry.type !== 'fyp') throw rule('invalid_request', 'Версии собираются у фупа')
      const { count, level } = context.body
      const operation = context.state.operations.start({
        model: facts.model.model.code,
        kind: 'fyp_versions',
        label: `Версии фупа собираются · ${record.entry.id}`,
        done_label: `Версии фупа готовы · ${record.entry.id}`,
        result: { download_url: null, file_name: null, size_bytes: null },
        on_done: () => {
          const last = record.fyp_versions.reduce((max, version) => Math.max(max, version.no), 0)
          for (let index = 1; index <= count; index += 1) {
            record.fyp_versions.push({
              no: last + index,
              level,
              thumb: { key: `${record.entry.id}/u${last + index}`, ratio: '9:16' },
              duration_s: record.entry.duration_s ?? 9,
              placed: [],
            })
          }
          touch(record)
          catalogChanged(facts.model)
        },
      })
      context.log({
        area: 'catalog',
        action: 'fyp.versions',
        phrase: `${actorSays(context.state, 'заказал')} версии ${record.entry.id}: ${count}`,
        item_id: record.entry.id,
      })
      return { kind: 'operation', operation_id: operation.id, status_url: operation.status_url }
    }),
    bind(objectFileRoutes.setPurpose, 'staff', (context) => {
      const facts = context.facts()
      const record = recordOf(facts, context.params.id)
      requireRaw(record)
      context.requireVersion(record.version)
      record.entry.raw_purpose = context.body.purpose
      touch(record)
      catalogChanged(facts.model)
      return itemDetail(facts, record.entry.id, context.state.principal.role)
    }),
    bind(objectFileRoutes.extractShoot, 'staff', (context) => {
      const facts = context.facts()
      const source = recordOf(facts, context.params.id)
      requireRaw(source)
      const moving = new Set(pickFiles(source, context.body.keys).map((file) => file.key))
      if (moving.size === filesOf(source).length) {
        throw rule('invalid_request', 'Все файлы сразу не выделяются — останется пустая съёмка')
      }
      const target = newRawFrom(facts.model, source, todayOf(context.state))
      target.files = filesOf(source).filter((file) => moving.has(file.key))
      source.files = filesOf(source).filter((file) => !moving.has(file.key))
      recount(source.entry, source.files)
      recount(target.entry, target.files)
      linkBoth(target, source, 'extracted_from', `pv-${target.entry.id}-extract`)
      touch(source)
      catalogChanged(facts.model)
      context.log({
        area: 'catalog',
        action: 'raw.extract',
        phrase: `${actorSays(context.state, 'выделил')} ${target.entry.id} из ${source.entry.id}`,
        item_id: target.entry.id,
      })
      return { item_id: target.entry.id }
    }),
    bind(objectFileRoutes.merge, 'staff', (context) => {
      const facts = context.facts()
      const source = recordOf(facts, context.params.id)
      const target = recordOf(facts, context.body.into)
      requireRaw(source)
      requireRaw(target)
      if (source === target) throw rule('invalid_request', 'Съёмка не сливается сама с собой')
      if (target.lifecycle.state !== 'active') throw rule('invalid_request', 'Эта съёмка уже слита')
      context.requireVersion(source.version)
      const targetFiles = filesOf(target)
      for (const file of filesOf(source)) {
        targetFiles.push({ ...file, key: nextPhotoKey(targetFiles, 'raw') })
      }
      recount(target.entry, targetFiles)
      target.old_names.push({ name: source.entry.id, kind: 'number', with_fan_name: false })
      linkBoth(target, source, 'merged_from', `pv-${target.entry.id}-merge-${source.entry.id}`)
      source.lifecycle = { state: 'merged', into: target.entry.id, at: context.state.clock.now() }
      touch(target)
      catalogChanged(facts.model)
      context.log({
        area: 'catalog',
        action: 'raw.merge',
        phrase: `${actorSays(context.state, 'слил')} ${source.entry.id} с ${target.entry.id}`,
        item_id: target.entry.id,
      })
      return { item_id: target.entry.id }
    }),
    bind(objectFileRoutes.makeMaster, 'staff', (context) => {
      const facts = context.facts()
      const source = recordOf(facts, context.params.id)
      requireRaw(source)
      const [file] = pickFiles(source, [context.body.file_key])
      if (file?.media !== 'video') {
        throw rule('invalid_request', 'Мастером становится видео')
      }
      const id: ItemId = nextItemId(facts.model, 'ppv')
      const entry = newEntry(id, 'ppv', context.body.title, todayOf(context.state))
      entry.ppv_kind = context.body.kind
      entry.duration_s = file.duration_s
      entry.photo_count = 0
      entry.shot_on = source.entry.shot_on
      const record = newRecord(entry, ydiskPathFor(entry))
      record.files = [
        {
          ...file,
          key: 'master',
          role: 'master',
          label: 'мастер',
          position: null,
          thumb: { key: id, ratio: '9:16' },
          source: { item_id: source.entry.id, file_key: file.key },
        },
      ]
      facts.model.items.set(id, record)
      linkBoth(record, source, 'extracted_from', `pv-${id}-master`)
      catalogChanged(facts.model)
      context.log({
        area: 'catalog',
        action: 'raw.make_master',
        phrase: `${actorSays(context.state, 'сделал')} ${id} из ${source.entry.id} · ${file.file_name}`,
        item_id: id,
      })
      return { item_id: id, how: 'new' as const, next_step: 'Добавить тизер' }
    }),
  ]
}
