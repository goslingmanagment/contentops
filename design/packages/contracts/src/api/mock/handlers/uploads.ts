import type { CreateUploadCommand, UploadedFile, UploadKind } from '../../../commands/uploads'
import { UPLOAD_KIND_LABEL } from '../../../commands/uploads'
import type { ItemFile } from '../../../domain/files'
import type { DraftFile, InboxGroup, UploadResult } from '../../../domain/inbox'
import type { ItemId, ItemType } from '../../../domain/item-type'
import { ydiskPathFor } from '../../../fixtures/item-files'
import type { InboxRecord, ItemRecord, ModelWorld } from '../../../fixtures/world-types'
import { plural } from '../../../format'
import { inboxRoutes } from '../../routes/inbox'
import { rule } from '../domain-error'
import { type BoundRoute, bind, todayOf } from '../handler'
import type { MockState } from '../state'
import { recordOf } from '../views/item'
import { actorSays } from './actor-says'
import { catalogChanged, newEntry, newRecord, nextItemId, touch } from './model-records'
import { filesOf, recount } from './object-files'
import { rowOf } from './plan-records'

/**
 * Web uploads (DESIGN §3.7): «Другое» into «Приехало», with a target — accepted at once.
 * A file that does not fit the target (a teaser made of photos) is refused with 422: the
 * upload then stays in the tray with ▲, as a group «Загружено вами» would.
 */

const UPLOADED = 'Загружено вами'
const pad = (value: number) => String(value).padStart(2, '0')

function nextGroupId(model: ModelWorld): string {
  let number = model.inbox.length + 1
  while (model.inbox.some((record) => record.group.id === `g-upload-${number}`)) number += 1
  return `g-upload-${number}`
}

/** «3 фото», «2 видео», «3 фото · 1 видео». */
function contentWords(files: readonly UploadedFile[]): string {
  const photos = files.filter((file) => file.media === 'photo').length
  const videos = files.length - photos
  const parts = [
    photos > 0 ? `${photos} фото` : null,
    videos > 0 ? `${videos} видео` : null,
  ].filter((part): part is string => part !== null)
  return parts.join(' · ')
}

function draftFiles(groupId: string, files: readonly UploadedFile[]): DraftFile[] {
  let photo = 0
  return files.map((file, index) => {
    const position = index + 1
    const isPhoto = file.media === 'photo'
    if (isPhoto) photo += 1
    return {
      key: `f${String(position).padStart(3, '0')}`,
      file_name: file.file_name,
      role: isPhoto ? 'photo' : 'clip',
      role_label: isPhoto ? `фото ${photo}` : 'видео',
      media: file.media,
      position: isPhoto ? photo : null,
      duration_s: isPhoto ? null : 30,
      size_bytes: file.size_bytes,
      thumb: { key: `draft:${groupId}/${position}`, ratio: isPhoto ? '3:4' : '9:16' },
      shot_at: null,
    }
  })
}

function emptyFields(type: ItemType | null): InboxGroup['fields'] {
  return {
    type,
    title: '',
    description: '',
    tags: [],
    ppv_kind: null,
    raw_purpose: null,
    channel: null,
    collection: null,
    second_person: false,
    fan_name: null,
    order_id: null,
    shot_on: null,
  }
}

function pushGroup(model: ModelWorld, group: InboxGroup, target: ItemId | null): InboxRecord {
  const record: InboxRecord = {
    group,
    target_item: target,
    prepare_started_at: null,
    ready_at: null,
  }
  model.inbox.push(record)
  return record
}

/** «Другое»: a group «Загружено вами · 3 фото»; without a type it asks ◆ «Что это?». */
function uploadToInbox(state: MockState, model: ModelWorld, command: CreateUploadCommand) {
  const id = nextGroupId(model)
  const type = command.type ?? null
  const files = draftFiles(id, command.files)
  const group: InboxGroup = {
    id,
    title: `${UPLOADED} · ${contentWords(command.files)}`,
    source_path: UPLOADED,
    root: UPLOADED,
    uploaded_by: state.actor,
    arrived_at: state.clock.now(),
    size_bytes: files.reduce((sum, file) => sum + file.size_bytes, 0),
    file_count: files.length,
    state: type
      ? { kind: 'ready', note: { kind: 'new' } }
      : { kind: 'decision', decision: 'what_is_it' },
    accept_block: type ? null : 'Сначала выберите тип',
    fields: emptyFields(type),
    hints: [],
    files,
    candidates: [],
    archive_entries: null,
    target_item: null,
    version: 1,
  }
  pushGroup(model, group, null)
  return group
}

function uploadedFile(
  record: ItemRecord,
  file: UploadedFile,
  spec: Pick<ItemFile, 'key' | 'role' | 'label' | 'position'>,
  today: string,
): ItemFile {
  const isVideo = file.media === 'video'
  return {
    ...spec,
    media: file.media,
    file_name: file.file_name,
    duration_s: isVideo ? (record.entry.duration_s ?? 30) : null,
    width: 2160,
    height: 3840,
    size_bytes: file.size_bytes,
    thumb: { key: `${record.entry.id}/${spec.key}-up`, ratio: isVideo ? '9:16' : '3:4' },
    current_version: 1,
    versions: [{ no: 1, on: today, reason: null, duration_s: null }],
    state: { kind: 'ready' },
    selected: null,
    processed: null,
    assignment: null,
    flags: [],
    shot_at: null,
    source: null,
  }
}

function requireVideo(files: readonly UploadedFile[], what: string): UploadedFile {
  const video = files.find((file) => file.media === 'video')
  if (!video || files.length !== 1) throw rule('accept_blocked', `${what} — один видеофайл`)
  return video
}

/** A new version of the main video: «мастер v3 · загружено вами». */
function newVersion(record: ItemRecord, role: ItemFile['role'], today: string) {
  const main = filesOf(record).find((file) => file.role === role)
  if (!main) throw rule('accept_blocked', `У ${record.entry.id} нет файла «${role}»`)
  const no = main.versions.reduce((max, version) => Math.max(max, version.no), 0) + 1
  main.versions.push({ no, on: today, reason: 'загружено вами', duration_s: main.duration_s })
  main.current_version = no
  record.entry.version_count = Math.max(record.entry.version_count, main.versions.length)
}

/** Files with a target join it by kind (DESIGN §3.7): the thumbnail changes to the new one. */
function attach(
  record: ItemRecord,
  kind: UploadKind,
  uploaded: readonly UploadedFile[],
  today: string,
) {
  const files = filesOf(record)
  switch (kind) {
    case 'teaser': {
      if (record.entry.type !== 'ppv' && record.entry.type !== 'custom')
        throw rule('accept_blocked', 'Тизер бывает у PPV и кастома')
      const video = requireVideo(uploaded, 'Тизер')
      const others = files.filter((file) => file.role !== 'teaser')
      files.splice(
        0,
        files.length,
        ...others,
        uploadedFile(
          record,
          video,
          { key: 'teaser', role: 'teaser', label: 'тизер', position: null },
          today,
        ),
      )
      break
    }
    case 'master_version':
      requireVideo(uploaded, 'Новая версия мастера')
      newVersion(record, 'master', today)
      break
    case 'fyp_montage':
      if (record.entry.type !== 'fyp') throw rule('accept_blocked', 'Монтаж фупа — только у фупа')
      requireVideo(uploaded, 'Монтаж фупа')
      newVersion(record, 'montage', today)
      break
    case 'frames': {
      if (uploaded.some((file) => file.media !== 'photo'))
        throw rule('accept_blocked', 'Обработанные кадры — только фото')
      let position = files.reduce((max, file) => Math.max(max, file.position ?? 0), 0)
      for (const file of uploaded) {
        position += 1
        const key = `up${pad(position)}`
        const photo = uploadedFile(
          record,
          file,
          { key, role: 'photo', label: `фото ${position}`, position },
          today,
        )
        if (record.entry.type === 'set') photo.processed = true
        files.push(photo)
      }
      break
    }
    case 'other':
      throw rule('invalid_request', '«Другое» загружается без цели')
  }
  recount(record.entry, files)
  touch(record)
}

/** A row waiting for a montage (DESIGN §4.13 «Под монтаж»): the montage becomes a new object. */
function montageForRow(
  model: ModelWorld,
  rowId: string,
  kind: UploadKind,
  uploaded: readonly UploadedFile[],
  today: string,
): ItemRecord {
  const row = rowOf(model, rowId)
  if (row.item_id) {
    const record = model.items.get(row.item_id)
    if (!record) throw rule('accept_blocked', 'Объекта строки уже нет')
    attach(record, kind, uploaded, today)
    return record
  }
  const waiting = row.awaiting_montage
  if (!waiting) throw rule('accept_blocked', 'Строка не ждёт монтаж')
  const video = requireVideo(uploaded, 'Монтаж')
  const source = model.items.get(waiting.from_item)
  const type: ItemType = waiting.expected_type === 'ppv' ? 'ppv' : 'fyp'
  const id = nextItemId(model, type)
  const entry = newEntry(id, type, source?.entry.title ?? video.file_name, today)
  entry.duration_s = source?.entry.duration_s ?? 30
  const record = newRecord(entry, ydiskPathFor(entry))
  const role = type === 'fyp' ? 'montage' : 'master'
  record.files = [
    uploadedFile(
      record,
      video,
      { key: role, role, label: role === 'montage' ? 'монтаж' : 'мастер', position: null },
      today,
    ),
  ]
  if (source) {
    record.provenance.push({
      id: `pv-${id}-from`,
      relation: 'made_from',
      direction: 'out',
      item_id: source.entry.id,
      item_type: source.entry.type,
      item_title: source.entry.title,
      extra: null,
      confirmed: true,
    })
    source.provenance.push({
      id: `pv-${id}-from-back`,
      relation: 'made_from',
      direction: 'in',
      item_id: id,
      item_type: type,
      item_title: entry.title,
      extra: null,
      confirmed: true,
    })
    touch(source)
  }
  model.items.set(id, record)
  row.item_id = id
  row.awaiting_montage = null
  row.version += 1
  model.summary_version += 1
  return record
}

/** «Решённое»: «PPV-089 · тизер» — принято при загрузке, тем, кто загрузил. */
function acceptedRecord(
  state: MockState,
  model: ModelWorld,
  record: ItemRecord,
  command: CreateUploadCommand,
): InboxGroup {
  const id = nextGroupId(model)
  const files = draftFiles(id, command.files)
  const now = state.clock.now()
  const group: InboxGroup = {
    id,
    title:
      command.files.length === 1
        ? (command.files[0]?.file_name ?? UPLOADED)
        : `${UPLOADED} · ${contentWords(command.files)}`,
    source_path: UPLOADED,
    root: UPLOADED,
    uploaded_by: state.actor,
    arrived_at: now,
    size_bytes: files.reduce((sum, file) => sum + file.size_bytes, 0),
    file_count: files.length,
    state: { kind: 'accepted', item_id: record.entry.id, how: 'upload', by: state.actor, at: now },
    accept_block: null,
    fields: {
      ...emptyFields(record.entry.type),
      title: `${record.entry.title} · ${UPLOAD_KIND_LABEL[command.kind].toLowerCase()}`,
    },
    hints: [],
    files,
    candidates: [],
    archive_entries: null,
    target_item: record.entry.id,
    version: 1,
  }
  pushGroup(model, group, record.entry.id)
  return group
}

export function uploadHandlers(): BoundRoute[] {
  return [
    bind(inboxRoutes.upload, 'staff', (context): UploadResult => {
      const { state, body } = context
      const model = context.model()
      const count = body.files.length
      const filesWord = `${count} ${plural(count, ['файл', 'файла', 'файлов'])}`
      if (body.target === null) {
        const group = uploadToInbox(state, model, body)
        context.log({
          area: 'inbox',
          action: 'upload.inbox',
          phrase: `${actorSays(state, 'загрузил')} ${filesWord} в Приехало`,
        })
        return {
          group_id: group.id,
          placed: 'inbox',
          item_id: null,
          decision: group.state.kind === 'decision' ? group.state.decision : null,
        }
      }
      const today = todayOf(state)
      const record =
        body.target.kind === 'item'
          ? recordOf(context.facts(), body.target.item_id)
          : montageForRow(model, body.target.row_id, body.kind, body.files, today)
      if (body.target.kind === 'item') attach(record, body.kind, body.files, today)
      catalogChanged(model)
      const group = acceptedRecord(state, model, record, body)
      context.log({
        area: 'inbox',
        action: 'upload.accept',
        phrase: `${actorSays(state, 'загрузил')} ${UPLOAD_KIND_LABEL[body.kind].toLowerCase()} к ${record.entry.id} — принято при загрузке`,
        item_id: record.entry.id,
      })
      return { group_id: group.id, placed: 'attached', item_id: record.entry.id, decision: null }
    }),
  ]
}
