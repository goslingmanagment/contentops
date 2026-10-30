import { versionTag } from '@contentops/contracts/api/headers'
import { inboxRoutes, legacyRoutes } from '@contentops/contracts/api/routes/inbox'
import { addMinutes } from '@contentops/contracts/clock'
import type { DecideCommand } from '@contentops/contracts/commands/inbox'
import {
  type InboxGroup,
  type InboxList,
  needsOwnAccept,
  type ReadyNote,
  type VideoInSetDestination,
} from '@contentops/contracts/domain/inbox'
import type { ItemType } from '@contentops/contracts/domain/item-type'
import type { Person } from '@contentops/contracts/domain/people'
import { notFound, rule } from '../domain-error'
import type { InboxRecord, ModelWorld } from '../fixtures/world-types'
import { type BoundRoute, bind } from '../handler'
import type { MockState } from '../state'
import { groupView, inboxList, inboxRecord } from '../views/inbox'
import { actorSays } from './actor-says'
import { acceptGroup } from './inbox-accept'
import { applyFileChanges, relabel, startDraftDownload } from './inbox-files'

/** «Приехало» and «Разбор старого» (DESIGN §4.8–4.10). */

const REJECT_KEEP_DAYS = 30
const UNCLEAR_OPTION = 'unclear'
/** «Метка из имени», решённая сохранённой карточкой «Метки → страницы». */
const BY_LABELS_OPTION = 'by_labels'

function makeReady(group: InboxGroup, note: ReadyNote = { kind: 'new' }) {
  group.state = { kind: 'ready', note }
  group.accept_block = null
  group.version += 1
}

const DESTINATION_TYPE: Record<Exclude<VideoInSetDestination, 'reject'>, ItemType | null> = {
  raw: 'raw',
  life: 'life',
  fyp_source: 'raw',
  separate: null,
}

/** Хвост названия с составом, как его пишет забор с диска: «· 33 фото и 1 видео». */
const COMPOSITION = / · \d+ (фото|видео)( и \d+ (фото|видео))?$/

function compositionOf(files: readonly { media: string }[]): string {
  const photos = files.filter((file) => file.media === 'photo').length
  const videos = files.length - photos
  return [photos > 0 ? `${photos} фото` : null, videos > 0 ? `${videos} видео` : null]
    .filter(Boolean)
    .join(' и ')
}

/** Состав в названии следует за файлами: после «В сырьё» у сета «33 фото», у части «1 видео». */
function retitled(title: string, files: readonly { media: string }[]): string | null {
  return COMPOSITION.test(title) && files.length > 0
    ? title.replace(COMPOSITION, ` · ${compositionOf(files)}`)
    : null
}

function splitOff(
  model: ModelWorld,
  record: InboxRecord,
  keys: ReadonlySet<string>,
  type: ItemType | null,
  folder?: string,
): InboxRecord {
  const group = record.group
  const title = group.title
  const moved = group.files.filter((file) => keys.has(file.key))
  group.files = group.files.filter((file) => !keys.has(file.key))
  group.file_count = group.files.length
  group.size_bytes = group.files.reduce((sum, file) => sum + file.size_bytes, 0)
  group.title = retitled(title, group.files) ?? title
  group.version += 1
  const id = `${group.id}-part-${model.inbox.length + 1}`
  const part: InboxRecord = {
    target_item: null,
    prepare_started_at: null,
    ready_at: null,
    group: {
      ...group,
      id,
      title: folder
        ? `${group.source_path} › ${folder}`
        : (retitled(title, moved) ??
          `${title} · ${moved.length} ${moved.length === 1 ? 'файл' : 'файла'}`),
      source_path: folder ? `${group.source_path} / ${folder}` : group.source_path,
      archive_entries: null,
      files: moved,
      file_count: moved.length,
      size_bytes: moved.reduce((sum, file) => sum + file.size_bytes, 0),
      state: type
        ? { kind: 'ready', note: { kind: 'new' } }
        : { kind: 'decision', decision: 'what_is_it' },
      accept_block: type ? null : 'Сначала выберите тип',
      fields: { ...group.fields, type },
      hints: [],
      candidates: [],
      target_item: null,
      version: 1,
    },
  }
  relabel(group)
  relabel(part.group)
  model.inbox.push(part)
  return part
}

/** What a folder inside an archive holds, by its name: «Сеты 03.07» → a set. */
const FOLDER_TYPE: readonly [RegExp, ItemType][] = [
  [/^сет/i, 'set'],
  [/^лайф|^life/i, 'life'],
  [/^сырь|^raw/i, 'raw'],
  [/^секстинг|^sexting/i, 'sexting'],
  [/^ppv/i, 'ppv'],
  [/^fyp|^фуп/i, 'fyp'],
]

function folderType(folder: string): ItemType | null {
  return FOLDER_TYPE.find(([pattern]) => pattern.test(folder))?.[1] ?? null
}

/**
 * ◆ «Разделить архив?»: each folder of the table of contents becomes its own group — the
 * archive is accepted by its parts (DESIGN §4.8), and the archive group itself is gone.
 */
function splitArchive(model: ModelWorld, record: InboxRecord) {
  const folders = new Map<string, Set<string>>()
  for (const file of record.group.files) {
    const slash = file.file_name.indexOf('/')
    const folder = slash > 0 ? file.file_name.slice(0, slash) : 'Без папки'
    folders.set(folder, (folders.get(folder) ?? new Set()).add(file.key))
  }
  for (const [folder, keys] of folders) {
    splitOff(model, record, keys, folderType(folder), folder)
  }
  model.inbox = model.inbox.filter((candidate) => candidate !== record)
}

/**
 * The other model of a cross-model duplicate is named only to someone with rights on both
 * (DESIGN §2.5): the hint is left out of the answer for everyone else.
 */
function visibleTo(person: Person, group: InboxGroup): InboxGroup {
  const hints = group.hints.filter(
    (hint) => hint.kind !== 'other_model' || person.models.includes(hint.model),
  )
  return hints.length === group.hints.length ? group : { ...group, hints }
}

function listVisibleTo(person: Person, list: InboxList): InboxList {
  return { ...list, items: list.items.map((group) => visibleTo(person, group)) }
}

/** ◆ «Подставить монтаж в строку?»: the montage is already an object, only the row is left. */
function settleMontage(state: MockState, record: InboxRecord) {
  const itemId = record.target_item
  if (!itemId) throw rule('accept_blocked', 'Монтаж не привязан к объекту')
  record.group.state = {
    kind: 'accepted',
    item_id: itemId,
    how: 'upload',
    by: state.actor,
    at: state.clock.now(),
  }
  record.group.accept_block = null
  record.group.version += 1
}

function decide(model: ModelWorld, record: InboxRecord, command: DecideCommand) {
  const group = record.group
  if (group.state.kind !== 'decision') throw rule('accept_blocked', 'Решать здесь уже нечего')
  switch (command.decision) {
    case 'which_order':
      group.fields.order_id = command.order_id
      makeReady(group)
      if (command.order_id)
        group.state = {
          kind: 'ready',
          note: { kind: 'order_part', order_id: command.order_id, part: 'видео' },
        }
      return
    case 'what_is_it':
      group.fields.type = command.type
      makeReady(group, record.ready_note)
      return
    case 'cross_model':
      if (!command.keep) throw rule('accept_blocked', 'Чужой файл отклоняется через «Отклонить…»')
      makeReady(group)
      return
    case 'split_archive':
      if (command.split) {
        splitArchive(model, record)
      } else {
        makeReady(group)
      }
      return
    case 'video_in_set': {
      const videos = new Set(
        group.files.filter((file) => file.media === 'video').map((file) => file.key),
      )
      if (command.destination === 'reject') {
        group.files = group.files.filter((file) => !videos.has(file.key))
        group.file_count = group.files.length
        group.title = retitled(group.title, group.files) ?? group.title
      } else {
        splitOff(model, record, videos, DESTINATION_TYPE[command.destination])
      }
      makeReady(group)
      return
    }
    default:
      makeReady(group)
  }
}

export function inboxHandlers(): BoundRoute[] {
  return [
    bind(inboxRoutes.list, 'staff', ({ model, state, query }) =>
      listVisibleTo(
        state.principal,
        inboxList(model(), state.clock.now(), query.state ?? 'active'),
      ),
    ),
    bind(
      inboxRoutes.get,
      'staff',
      ({ model, state, params }) =>
        visibleTo(state.principal, groupView(model(), params.group, state.clock.now())),
      {
        etag: (body) => versionTag(body.version),
      },
    ),
    bind(inboxRoutes.update, 'staff', (context) => {
      const record = inboxRecord(context.model(), context.params.group)
      context.requireVersion(record.group.version, Object.keys(context.body)[0])
      record.group.fields = { ...record.group.fields, ...context.body }
      record.group.version += 1
      return visibleTo(context.state.principal, record.group)
    }),
    bind(inboxRoutes.files, 'staff', (context) => {
      const record = inboxRecord(context.model(), context.params.group)
      context.requireVersion(record.group.version, 'files')
      applyFileChanges(record.group, context.body)
      record.group.version += 1
      return visibleTo(context.state.principal, record.group)
    }),
    bind(inboxRoutes.download, 'staff', (context) => {
      const model = context.model()
      const record = inboxRecord(model, context.params.group)
      return startDraftDownload(context.state, model, record.group)
    }),
    bind(inboxRoutes.decide, 'staff', (context) => {
      const model = context.model()
      const record = inboxRecord(model, context.params.group)
      if (context.body.decision === 'substitute_montage') {
        settleMontage(context.state, record)
        context.log({
          area: 'inbox',
          action: 'draft.substitute',
          phrase: `${actorSays(context.state, context.body.substitute ? 'подставил' : 'оставил')} монтаж ${record.target_item ?? ''} ${context.body.substitute ? 'в строку плана' : 'в каталоге'}`,
          item_id: record.target_item,
        })
      } else {
        decide(model, record, context.body)
      }
      return visibleTo(context.state.principal, record.group)
    }),
    bind(inboxRoutes.accept, 'staff', (context) => {
      const model = context.model()
      const record = inboxRecord(model, context.params.group)
      return acceptGroup(context.state, model, record, context.body, (phrase, itemId) =>
        context.log({ area: 'inbox', action: 'draft.accept', phrase: phrase, item_id: itemId }),
      )
    }),
    bind(inboxRoutes.acceptMany, 'staff', (context) => {
      const model = context.model()
      const refused = (id: string, code: string) => ({ id, ok: false, code, accepted: null })
      const results = context.body.group_ids.map((id) => {
        const record = model.inbox.find((candidate) => candidate.group.id === id)
        if (!record) return refused(id, 'not_found')
        if (record.group.state.kind !== 'ready') return refused(id, 'accept_blocked')
        if (record.group.accept_block) return refused(id, 'number_not_issued')
        if (!record.group.fields.type) return refused(id, 'accept_blocked')
        // «Похоже на исправление» принимается только по одной, после просмотра (§4.8).
        if (needsOwnAccept(record.group)) return refused(id, 'accept_blocked')
        const accepted = acceptGroup(
          context.state,
          model,
          record,
          { as: 'default' },
          (phrase, itemId) =>
            context.log({ area: 'inbox', action: 'draft.accept', phrase: phrase, item_id: itemId }),
        )
        return { id, ok: true, code: null, accepted }
      })
      return { results }
    }),
    bind(inboxRoutes.setType, 'staff', (context) => {
      const model = context.model()
      const results = context.body.group_ids.map((id) => {
        const record = model.inbox.find((candidate) => candidate.group.id === id)
        if (!record) return { id, ok: false, code: 'not_found' }
        if (
          record.group.state.kind !== 'decision' ||
          record.group.state.decision !== 'what_is_it'
        ) {
          return { id, ok: false, code: 'accept_blocked' }
        }
        decide(model, record, { decision: 'what_is_it', type: context.body.type })
        return { id, ok: true, code: null }
      })
      return { results }
    }),
    bind(inboxRoutes.merge, 'staff', (context) => {
      const model = context.model()
      const records = context.body.group_ids.map((id) => inboxRecord(model, id))
      const [first, ...rest] = records
      if (!first) throw notFound('Нечего сливать')
      for (const other of rest) {
        first.group.files.push(...other.group.files)
        model.inbox = model.inbox.filter((candidate) => candidate !== other)
      }
      first.group.file_count = first.group.files.length
      first.group.size_bytes = first.group.files.reduce((sum, file) => sum + file.size_bytes, 0)
      relabel(first.group)
      first.group.version += 1
      context.log({
        area: 'inbox',
        action: 'draft.merge',
        phrase: `${actorSays(context.state, 'слил')} ${records.length} группы в «${first.group.title}»`,
      })
      return first.group
    }),
    bind(inboxRoutes.split, 'staff', (context) => {
      const model = context.model()
      const record = inboxRecord(model, context.params.group)
      const part = splitOff(
        model,
        record,
        new Set(context.body.file_keys),
        record.group.fields.type,
      )
      return part.group
    }),
    bind(inboxRoutes.reject, 'staff', (context) => {
      const record = inboxRecord(context.model(), context.params.group)
      const state = record.group.state.kind
      if (state === 'accepted' || state === 'rejected')
        throw rule('accept_blocked', 'Группа уже решена')
      record.group.state = {
        kind: 'rejected',
        reason: context.body.reason,
        by: context.state.actor,
        at: context.state.clock.now(),
        days_left: REJECT_KEEP_DAYS,
      }
      record.group.version += 1
      context.log({
        area: 'inbox',
        action: 'draft.reject',
        phrase: `${actorSays(context.state, 'отклонил')} «${record.group.title}»`,
      })
      return record.group
    }),
    bind(inboxRoutes.retry, 'staff', (context) => {
      const record = inboxRecord(context.model(), context.params.group)
      if (record.group.state.kind !== 'error') throw rule('accept_blocked', 'Повторять нечего')
      const now = context.state.clock.now()
      const archive = record.group.state.error === 'archive_unreadable'
      record.group.state = {
        kind: 'preparing',
        stage: archive ? 'downloading' : 'compressing',
        progress: 0,
        done_bytes: archive ? 0 : null,
        total_bytes: archive ? record.group.size_bytes : null,
      }
      record.group.accept_block = archive ? 'Ещё качается' : 'Мастер ещё собирается · 0 %'
      record.prepare_started_at = now
      record.ready_at = addMinutes(now, 1)
      record.group.version += 1
      return record.group
    }),
    bind(inboxRoutes.restore, 'staff', (context) => {
      const record = inboxRecord(context.model(), context.params.group)
      if (record.group.state.kind !== 'rejected')
        throw rule('accept_blocked', 'Вернуть можно только отклонённое')
      makeReady(record.group)
      context.log({
        area: 'inbox',
        action: 'draft.restore',
        phrase: `${actorSays(context.state, 'вернул')} в работу «${record.group.title}»`,
      })
      return record.group
    }),
    bind(legacyRoutes.get, 'staff', ({ model }) => model().legacy),
    bind(legacyRoutes.saveLabels, 'staff', (context) => {
      const legacy = context.model().legacy
      for (const change of context.body.labels) {
        const label = legacy.labels.find((candidate) => candidate.label === change.label)
        if (label) label.target = change.target
      }
      // «Метка из имени» с меткой, у которой теперь есть страница, решена карточкой (§4.9).
      const mapped = new Set(
        legacy.labels.filter((label) => label.target !== null).map((label) => label.label),
      )
      const settled = legacy.disputes.filter(
        (dispute) =>
          dispute.kind === 'label_from_name' &&
          !dispute.resolved &&
          dispute.label !== null &&
          mapped.has(dispute.label),
      )
      for (const dispute of settled) {
        dispute.resolved = {
          option: BY_LABELS_OPTION,
          by: context.state.principal.name,
          at: context.state.clock.now(),
        }
      }
      if (settled.length > 0) {
        context.log({
          area: 'inbox',
          action: 'legacy.labels',
          phrase: `${actorSays(context.state, 'привязал')} по карточке меток ${settled.length} старых имён`,
        })
      }
      return legacy
    }),
    bind(legacyRoutes.resolve, 'staff', (context) => {
      const legacy = context.model().legacy
      const dispute = legacy.disputes.find((candidate) => candidate.id === context.params.dispute)
      if (!dispute) throw notFound('Такого случая нет')
      if (dispute.postponed) throw rule('accept_blocked', dispute.postponed)
      // «Неясно — оставить в разборе»: случай остаётся спорным, решение пишется в журнал.
      if (context.body.option === UNCLEAR_OPTION) {
        context.log({
          area: 'inbox',
          action: 'legacy.unclear',
          phrase: `${actorSays(context.state, 'оставил')} в разборе «${dispute.title}»`,
        })
        return legacy
      }
      // «Номер занят» с выбором у каждой папки: папка «неясно» оставляет случай в разборе.
      const folders = context.body.folders
      if (folders && Object.values(folders).includes(UNCLEAR_OPTION)) {
        context.log({
          area: 'inbox',
          action: 'legacy.unclear',
          phrase: `${actorSays(context.state, 'оставил')} в разборе «${dispute.title}»`,
        })
        return legacy
      }
      dispute.resolved = {
        option: context.body.option,
        by: context.state.principal.name,
        at: context.state.clock.now(),
      }
      context.log({
        area: 'inbox',
        action: 'legacy.resolve',
        phrase: `${actorSays(context.state, 'разобрал')} «${dispute.title}»`,
      })
      return legacy
    }),
  ]
}
