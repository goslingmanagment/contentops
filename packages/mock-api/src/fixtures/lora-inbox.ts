import { addMinutes, mskInstant } from '@contentops/contracts/clock'
import type { ActorRef, Instant, LocalDate, LocalTime } from '@contentops/contracts/domain/common'
import type {
  DraftFields,
  DraftFile,
  DraftHint,
  DraftState,
  InboxGroup,
  OrderCandidate,
} from '@contentops/contracts/domain/inbox'
import type { ItemId, ItemType } from '@contentops/contracts/domain/item-type'
import { PROTOTYPE_NOW } from '../prototype-clock'
import { ORDER_ID } from './lora-orders'
import { AGENT, PERSON, SYSTEM_ACTOR } from './people'
import type { InboxRecord } from './world-types'

/** «Приехало» of Лора on 22.09 (DESIGN §9.4) and the peak day for `?demo=peak`. */

const at = (date: LocalDate, time: LocalTime) => mskInstant(date, time)
const TODAY = '2026-09-22'
const YESTERDAY = '2026-09-21'
const MB = 1_000_000

const DIANA: ActorRef = { type: 'person', id: PERSON.diana, name: 'Диана', gender: 'f' }
/** The root and path of a web upload: it has no place on Я.Диск. */
const WEB_UPLOAD = 'Загружено вами'
const INTAKE_AGENT: ActorRef = {
  type: 'agent',
  id: AGENT.intake,
  name: 'Агент приёмки',
  gender: 'm',
}

export function fields(patch: Partial<DraftFields>): DraftFields {
  return {
    type: null,
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
    ...patch,
  }
}

export interface FileRun {
  count: number
  media: 'video' | 'photo'
  role?: DraftFile['role']
  label?: (position: number) => string
  duration_s?: number
  size_bytes?: number
  name?: (position: number) => string
}

export function files(
  groupId: string,
  runs: readonly FileRun[],
  shotAt: Instant | null,
): DraftFile[] {
  const result: DraftFile[] = []
  for (const run of runs) {
    for (let index = 1; index <= run.count; index++) {
      const position = result.length + 1
      const role = run.role ?? (run.media === 'photo' ? 'photo' : 'master')
      result.push({
        key: `f${String(position).padStart(3, '0')}`,
        file_name:
          run.name?.(index) ?? `IMG_${4000 + position}.${run.media === 'photo' ? 'JPG' : 'MOV'}`,
        role,
        role_label:
          run.label?.(index) ??
          (role === 'photo' ? `фото ${index}` : role === 'master' ? 'мастер' : 'видео'),
        media: run.media,
        position: role === 'photo' ? index : null,
        duration_s: run.media === 'video' ? (run.duration_s ?? 30) : null,
        size_bytes: run.size_bytes ?? (run.media === 'photo' ? Math.round(2.6 * MB) : 900 * MB),
        thumb: {
          key: `draft:${groupId}/${position}`,
          ratio: run.media === 'photo' ? '3:4' : '9:16',
        },
        shot_at: shotAt,
      })
    }
  }
  return result
}

export interface GroupSpec {
  id: string
  title: string
  source_path: string
  root: string
  arrived_at: Instant
  state: DraftState
  fields: DraftFields
  files: DraftFile[]
  accept_block?: string
  hints?: DraftHint[]
  candidates?: OrderCandidate[]
  archive_entries?: number
  target_item?: ItemId
  /** A web upload's author; by default every group «Загружено вами» of Лора is Диана's. */
  uploaded_by?: ActorRef | null
  /** Minutes after «сейчас» when a preparing group becomes ready. */
  ready_in_min?: number
  /** What «готово» says once preparing ends, if not «новое». */
  ready_note?: Extract<DraftState, { kind: 'ready' }>['note']
  /** Size known before the files: an archive that is still downloading or unreadable. */
  size_bytes?: number
}

/**
 * Группа из одного файла на Я.Диске (`3. Customs / 2:54 грудь попа .mov`): файл называется
 * так же, как лежит, — «Скачать исходник» отдаёт его под этим именем. Архив — не файл
 * группы, его участники называются своими именами.
 */
function namedBySource(sourcePath: string, files: DraftFile[]): DraftFile[] {
  const name = sourcePath.split(' / ').at(-1) ?? ''
  const [only] = files
  if (!only || files.length > 1 || !/\.[A-Za-z0-9]{2,4}$/.test(name) || /\.zip$/i.test(name)) {
    return files
  }
  return [{ ...only, file_name: name }]
}

export function group(spec: GroupSpec): InboxRecord {
  const size = spec.size_bytes ?? spec.files.reduce((sum, file) => sum + file.size_bytes, 0)
  const inboxGroup: InboxGroup = {
    id: spec.id,
    title: spec.title,
    source_path: spec.source_path,
    root: spec.root,
    uploaded_by: spec.uploaded_by ?? (spec.root === WEB_UPLOAD ? DIANA : null),
    arrived_at: spec.arrived_at,
    size_bytes: size,
    file_count: spec.archive_entries ?? spec.files.length,
    state: spec.state,
    accept_block: spec.accept_block ?? null,
    fields: spec.fields,
    hints: spec.hints ?? [],
    files: namedBySource(spec.source_path, spec.files),
    candidates: spec.candidates ?? [],
    archive_entries: spec.archive_entries ?? null,
    target_item: spec.target_item ?? null,
    version: 1,
  }
  const readyIn = spec.ready_in_min
  return {
    group: inboxGroup,
    target_item: spec.target_item ?? null,
    prepare_started_at: readyIn === undefined ? null : PROTOTYPE_NOW,
    ready_at: readyIn === undefined ? null : addMinutes(PROTOTYPE_NOW, readyIn),
    ...(spec.ready_note ? { ready_note: spec.ready_note } : {}),
  }
}

const ready = (note: Extract<DraftState, { kind: 'ready' }>['note']): DraftState => ({
  kind: 'ready',
  note,
})

function needsDecision(): InboxRecord[] {
  return [
    group({
      id: 'g-2254',
      title: '2:54 грудь попа',
      source_path: '3. Customs / 2:54 грудь попа .mov',
      root: '3. Customs',
      arrived_at: at(TODAY, '11:02'),
      state: { kind: 'decision', decision: 'which_order' },
      fields: fields({ type: 'custom', title: 'Грудь и попа', fan_name: 'unknown' }),
      files: files(
        'g-2254',
        [{ count: 1, media: 'video', duration_s: 174, size_bytes: 1_900 * MB }],
        at(TODAY, '10:31'),
      ),
      accept_block: 'Сначала выберите заказ',
      candidates: [
        {
          order_id: ORDER_ID.breastsButt,
          title: 'грудь и попа',
          deadline: '2026-09-24',
          excerpt: 'Крупно грудь и попа, без лица. Около 3 минут.',
          matched: [
            'ответ на карточку',
            'в имени «грудь», «попа»',
            '2:54 при заказанных «около 3 минут»',
            'раздел Customs',
          ],
        },
        {
          order_id: ORDER_ID.breasts,
          title: 'грудь',
          deadline: '2026-09-26',
          excerpt: 'Грудь, медленно, при свечах. 3 минуты.',
          matched: ['в имени «грудь»', '2:54 при заказанных «3 минуты»', 'раздел Customs'],
        },
      ],
    }),
    group({
      id: 'g-1610',
      title: '8. Other · IMG_1610.JPG',
      source_path: '8. Other / IMG_1610.JPG',
      root: '8. Other',
      arrived_at: at(TODAY, '07:55'),
      state: { kind: 'decision', decision: 'what_is_it' },
      fields: fields({ title: 'IMG_1610' }),
      files: files(
        'g-1610',
        [{ count: 1, media: 'photo', name: () => 'IMG_1610.JPG' }],
        at(TODAY, '07:40'),
      ),
      accept_block: 'Сначала выберите тип',
    }),
    group({
      id: 'g-sets-2009',
      title: 'Сеты · 20.09.26 · 33 фото и 1 видео',
      source_path: '4. Sets / 20.09.26',
      root: '4. Sets',
      arrived_at: at(YESTERDAY, '22:10'),
      state: { kind: 'decision', decision: 'video_in_set' },
      fields: fields({ type: 'set', title: 'Сет 20 сентября', shot_on: '2026-09-20' }),
      files: files(
        'g-sets-2009',
        [
          { count: 33, media: 'photo' },
          {
            count: 1,
            media: 'video',
            role: 'clip',
            duration_s: 42,
            size_bytes: 180 * MB,
            label: () => 'видео',
          },
        ],
        at('2026-09-20', '16:12'),
      ),
      accept_block: 'Сначала решите, куда видео',
    }),
    group({
      id: 'g-1717',
      title: '17:17 Пов от девушки',
      source_path: '3. Customs / 17:17 Пов от девушки .mov',
      root: '3. Customs',
      arrived_at: at(YESTERDAY, '19:40'),
      state: { kind: 'error', error: 'master_failed', detail: 'рассинхрон звука' },
      fields: fields({ type: 'custom', title: 'Пов от девушки', fan_name: 'unknown' }),
      files: files(
        'g-1717',
        [{ count: 1, media: 'video', duration_s: 1037, size_bytes: 2_400 * MB }],
        at(YESTERDAY, '18:02'),
      ),
      accept_block: 'Мастер не собрался',
    }),
  ]
}

function readyGroups(): InboxRecord[] {
  return [
    group({
      id: 'g-sets-2109',
      title: 'Сеты · 21.09.26 · 22 фото',
      source_path: '4. Sets / 21.09.26',
      root: '4. Sets',
      arrived_at: at(TODAY, '10:40'),
      state: ready({ kind: 'new' }),
      fields: fields({
        type: 'set',
        title: 'Кружево у окна',
        tags: ['lace', 'teasing'],
        shot_on: '2026-09-21',
      }),
      files: files(
        'g-sets-2109',
        [{ count: 22, media: 'photo', size_bytes: Math.round(2.64 * MB) }],
        at(YESTERDAY, '15:20'),
      ),
    }),
    group({
      id: 'g-life-16',
      title: 'Лайф · 16 фото',
      source_path: '6. Life / life_прогулка_21.09.26',
      root: '6. Life',
      arrived_at: at(TODAY, '10:12'),
      state: ready({ kind: 'new' }),
      fields: fields({ type: 'life', title: 'Прогулка в парке', shot_on: '2026-09-21' }),
      files: files('g-life-16', [{ count: 16, media: 'photo' }], at(YESTERDAY, '13:05')),
      hints: [
        {
          kind: 'similar',
          text: 'Похоже на фото № 7 из сета 69',
          item_id: 'SET-069',
          file_key: 'ed07',
        },
      ],
    }),
    group({
      id: 'g-set074-plus3',
      title: '+3 фото в set_reading_book_thong_16.09.26',
      source_path: '4. Sets / Posted sets / set_reading_book_thong_16.09.26',
      root: '4. Sets',
      arrived_at: at(YESTERDAY, '16:02'),
      state: ready({ kind: 'extends', item_id: 'SET-074' }),
      fields: fields({ type: 'set', title: 'Чтение книги, стринги' }),
      files: files('g-set074-plus3', [{ count: 3, media: 'photo' }], at('2026-09-16', '14:40')),
      target_item: 'SET-074',
    }),
    group({
      id: 'g-341',
      title: '3:41 танец живота без музыки',
      source_path: '3. Customs / 3:41 танец живота без музыки.mov',
      root: '3. Customs',
      arrived_at: at(YESTERDAY, '12:30'),
      state: ready({ kind: 'fix_of', item_id: 'CUS-195', revision_id: 'rev-195-1' }),
      fields: fields({
        type: 'custom',
        title: 'Танец живота',
        order_id: ORDER_ID.bellyDance,
        fan_name: 'unknown',
      }),
      files: files(
        'g-341',
        [{ count: 1, media: 'video', duration_s: 221, size_bytes: 610 * MB }],
        at(YESTERDAY, '11:50'),
      ),
      hints: [
        {
          kind: 'order_match',
          text: 'Правка от 20.09: «без музыки, только звук комнаты» · ответ на сообщение с правкой',
        },
      ],
      target_item: 'CUS-195',
    }),
    group({
      id: 'g-kp3',
      title: '9. SMM/Instagram/КП3 · 14 видео',
      source_path: '9. SMM / Instagram / GaranTTeam ведение / КП3 21.09.26',
      root: '9. SMM',
      arrived_at: at(YESTERDAY, '11:15'),
      state: ready({ kind: 'promo', channel: 'instagram' }),
      fields: fields({ type: 'promo', title: 'КП3 офис', channel: 'instagram', collection: 'new' }),
      files: files(
        'g-kp3',
        [
          {
            count: 14,
            media: 'video',
            role: 'clip',
            duration_s: 14,
            size_bytes: 44 * MB,
            label: (index) => `видео ${index}`,
          },
        ],
        at('2026-09-20', '12:00'),
      ),
    }),
  ]
}

function preparingGroups(): InboxRecord[] {
  return [
    group({
      id: 'g-ppv-short',
      title: '1. PPV/21.09.26 короткий · видео 5:12 и 9 фото',
      source_path: '1. PPV / 21.09.26 короткий',
      root: '1. PPV',
      arrived_at: at(TODAY, '09:15'),
      state: {
        kind: 'preparing',
        stage: 'compressing',
        progress: 0.62,
        done_bytes: null,
        total_bytes: null,
      },
      fields: fields({ type: 'ppv', title: 'Короткий тизинг у окна', ppv_kind: 'bundle' }),
      files: files(
        'g-ppv-short',
        [
          { count: 1, media: 'video', duration_s: 312, size_bytes: 1_180 * MB },
          { count: 9, media: 'photo' },
        ],
        at(YESTERDAY, '17:30'),
      ),
      accept_block: 'Мастер ещё собирается · 62 %',
      ready_in_min: 3,
    }),
    group({
      id: 'g-archive',
      title: 'Архив.zip · 214 файлов',
      source_path: 'Архив.zip',
      root: 'корень',
      arrived_at: at(TODAY, '08:30'),
      state: {
        kind: 'preparing',
        stage: 'downloading',
        progress: 3.2 / 5.8,
        done_bytes: 3_200 * MB,
        total_bytes: 5_800 * MB,
      },
      fields: fields({}),
      files: [],
      size_bytes: 5_800 * MB,
      archive_entries: 214,
      accept_block: 'Ещё качается',
      ready_in_min: 6,
    }),
  ]
}

function decided(): InboxRecord[] {
  const accepted = (
    id: string,
    title: string,
    path: string,
    item: ItemId,
    how: 'new' | 'duplicate' | 'delivery' | 'upload',
    by: ActorRef,
    when: Instant,
    type: ItemType,
    fileKey?: string,
  ) =>
    group({
      id,
      title,
      source_path: path,
      root: path.split(' / ')[0] ?? path,
      arrived_at: when,
      state: {
        kind: 'accepted',
        item_id: item,
        how,
        by,
        at: when,
        ...(fileKey ? { file_key: fileKey } : {}),
      },
      fields: fields({ type, title }),
      files: [],
    })
  const rejected = (
    id: string,
    title: string,
    reason: string | null,
    when: Instant,
    daysLeft: number,
  ) =>
    group({
      id,
      title,
      source_path: `8. Other / ${title}`,
      root: '8. Other',
      arrived_at: when,
      state: { kind: 'rejected', reason, by: DIANA, at: when, days_left: daysLeft },
      fields: fields({ title }),
      files: [],
    })
  return [
    accepted(
      'g-done-set073',
      'После душа',
      '4. Sets / 19.09.26',
      'SET-073',
      'new',
      DIANA,
      at('2026-09-19', '18:20'),
      'set',
    ),
    accepted(
      'g-done-life191',
      'Завтрак у окна',
      '6. Life / life_завтрак_07.09.26',
      'LIFE-191',
      'new',
      INTAKE_AGENT,
      at(YESTERDAY, '09:40'),
      'life',
    ),
    accepted(
      'g-done-dup',
      'IMG_8487.JPG',
      '8. Other / IMG_8487.JPG',
      'SET-069',
      'duplicate',
      SYSTEM_ACTOR,
      at(YESTERDAY, '08:05'),
      'set',
      'ed07',
    ),
    accepted(
      'g-done-cus197',
      '15:37 босс',
      '3. Customs / 15:37 босс.mov',
      'CUS-197',
      'delivery',
      DIANA,
      at('2026-09-18', '16:30'),
      'custom',
    ),
    accepted(
      'g-done-fyp0803',
      'Монтаж для Fansly 2',
      'Загружено вами',
      'FYP-0803',
      'upload',
      DIANA,
      at(YESTERDAY, '17:12'),
      'fyp',
    ),
    rejected(
      'g-rej-1',
      'Screenshot_20260904.png',
      'не контент: скриншот',
      at('2026-09-04', '12:00'),
      12,
    ),
    rejected('g-rej-2', 'IMG_3321.MOV', null, at('2026-09-15', '09:30'), 23),
  ]
}

/** Groups of «Приехало» on a normal day. */
export function buildLoraInbox(): InboxRecord[] {
  return [...needsDecision(), ...readyGroups(), ...preparingGroups(), ...decided()]
}

/** `?demo=peak`: 12 packs and about 400 files, five «Что это?» from `8. Other`. */
export function buildPeakInbox(): InboxRecord[] {
  const dumpTimes: LocalTime[] = ['07:10', '07:40', '08:15', '08:50', '09:20']
  const dumps = [160, 44, 38, 21, 12].map((count, index) =>
    group({
      id: `g-peak-other-${index + 1}`,
      title: `8. Other · ${count} фото`,
      source_path: `8. Other / камера ${index + 1}`,
      root: '8. Other',
      arrived_at: at(TODAY, dumpTimes[index] ?? '09:00'),
      state: { kind: 'decision', decision: 'what_is_it' },
      fields: fields({ title: `Камера ${index + 1}` }),
      files: files(
        `g-peak-other-${index + 1}`,
        [{ count, media: 'photo' }],
        at(YESTERDAY, '20:00'),
      ),
      accept_block: 'Сначала выберите тип',
    }),
  )
  const extraSets = group({
    id: 'g-peak-sets',
    title: 'Сеты · 22.09.26 · 58 фото',
    source_path: '4. Sets / 22.09.26',
    root: '4. Sets',
    arrived_at: at(TODAY, '12:40'),
    state: ready({ kind: 'new' }),
    fields: fields({ type: 'set', title: 'Отель, утро', shot_on: '2026-09-22' }),
    files: files('g-peak-sets', [{ count: 58, media: 'photo' }], at(TODAY, '09:00')),
  })
  const kept = new Set([
    'g-sets-2009',
    'g-sets-2109',
    'g-life-16',
    'g-kp3',
    'g-ppv-short',
    'g-archive',
  ])
  const base = buildLoraInbox().filter(
    (record) =>
      kept.has(record.group.id) ||
      record.group.state.kind === 'accepted' ||
      record.group.state.kind === 'rejected',
  )
  return [...dumps, extraSets, ...base]
}
