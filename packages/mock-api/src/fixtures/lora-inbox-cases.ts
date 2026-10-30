import { mskInstant } from '@contentops/contracts/clock'
import type { LocalDate, LocalTime } from '@contentops/contracts/domain/common'
import { buildLoraInbox, fields, files, group } from './lora-inbox'
import type { InboxRecord } from './world-types'

/**
 * `?demo=cases`: the day of §9.4 plus every rarer case of the «Приёмка» table (DESIGN §4.8,
 * §5.3) that a normal Tuesday does not have — a cross-model duplicate, a changed plan row,
 * a vanished pack, an unreadable archive, a failed upload, a number waiting for the old
 * Я.Диск, a web upload, hints and an unpacked archive with its table of contents.
 */

const at = (date: LocalDate, time: LocalTime) => mskInstant(date, time)
const TODAY = '2026-09-22'
const YESTERDAY = '2026-09-21'
const MB = 1_000_000

const UPLOADED = 'Загружено вами'

/** Folders inside the unpacked archive: its table of contents, three different shoots. */
const ARCHIVE_FOLDERS = [
  { folder: 'Сеты 03.07', count: 80, media: 'photo' },
  { folder: 'Лайф 12.07', count: 60, media: 'photo' },
  { folder: 'Сырьё 20.07', count: 70, media: 'photo' },
  { folder: 'Сырьё 20.07', count: 4, media: 'video' },
] as const

function rareDecisions(): InboxRecord[] {
  return [
    group({
      id: 'g-cross-524',
      title: '5:24 нейлон',
      source_path: '3. Customs / 5:24 нейлон.mov',
      root: '3. Customs',
      arrived_at: at(TODAY, '12:10'),
      state: { kind: 'decision', decision: 'cross_model' },
      fields: fields({ type: 'custom', title: 'Нейлон', fan_name: 'unknown' }),
      files: files(
        'g-cross-524',
        [{ count: 1, media: 'video', duration_s: 324, size_bytes: 1_100 * MB }],
        at(TODAY, '11:40'),
      ),
      accept_block: 'Сначала проверьте файл',
      hints: [
        {
          kind: 'other_model',
          model: 'ari',
          text: 'У Ари: 3. Customs / 5:24 нейлон.mov, принят 12.09',
        },
      ],
    }),
    group({
      id: 'g-montage-f1',
      title: 'Монтаж для Fansly 1',
      source_path: UPLOADED,
      root: UPLOADED,
      arrived_at: at(TODAY, '13:05'),
      state: { kind: 'decision', decision: 'substitute_montage' },
      fields: fields({ type: 'fyp', title: 'Монтаж из RAW-0214' }),
      files: files(
        'g-montage-f1',
        [
          {
            count: 1,
            media: 'video',
            role: 'montage',
            label: () => 'монтаж',
            duration_s: 9,
            size_bytes: 38 * MB,
            name: () => 'FYP_montage_RAW-0214.mp4',
          },
        ],
        at(TODAY, '12:58'),
      ),
      hints: [
        {
          kind: 'row_change',
          was: 'Fansly 1 · фуп · вт 22, весь день',
          now: 'Fansly 1 · фуп · ср 23, 03:00',
        },
      ],
      target_item: 'FYP-0800',
    }),
    group({
      id: 'g-vanished',
      title: 'Сеты · 19.09.26 вечер · 12 фото',
      source_path: '4. Sets / 19.09.26 вечер',
      root: '4. Sets',
      arrived_at: at(YESTERDAY, '20:40'),
      state: { kind: 'error', error: 'vanished', detail: '4. Sets / 19.09.26 вечер' },
      fields: fields({ type: 'set', title: 'Вечер у окна', shot_on: '2026-09-19' }),
      files: files('g-vanished', [{ count: 12, media: 'photo' }], at('2026-09-19', '19:30')),
      accept_block: 'Пропал с Я.Диска',
    }),
    group({
      id: 'g-zip-march',
      title: 'sexting march.zip',
      source_path: 'sexting march.zip',
      root: 'корень',
      arrived_at: at(TODAY, '06:30'),
      state: { kind: 'error', error: 'archive_unreadable', detail: '2,1 ГБ · sexting march.zip' },
      fields: fields({}),
      files: [],
      size_bytes: 2_100 * MB,
      accept_block: 'Архив не читается',
    }),
    group({
      id: 'g-upload-teaser',
      title: 'Тизер для PPV-074',
      source_path: UPLOADED,
      root: UPLOADED,
      arrived_at: at(TODAY, '13:40'),
      state: {
        kind: 'error',
        error: 'upload_failed',
        detail: 'файл обрывается на 0:21 из 0:32',
      },
      fields: fields({ type: 'ppv', title: 'Кристаллы и каблуки' }),
      files: files(
        'g-upload-teaser',
        [
          {
            count: 1,
            media: 'video',
            role: 'teaser',
            label: () => 'тизер',
            duration_s: 32,
            size_bytes: 64 * MB,
            name: () => 'PPV-074_teaser.mp4',
          },
        ],
        at(TODAY, '13:38'),
      ),
      accept_block: 'Загрузка не прошла проверку',
      target_item: 'PPV-074',
    }),
    // Три съёмки в одном архиве: одним «Сырьём» его не принять — ◆ «Разделить архив?».
    group({
      id: 'g-zip-july',
      title: 'Июль.zip · 214 файлов',
      source_path: 'Июль.zip',
      root: 'корень',
      arrived_at: at(YESTERDAY, '07:30'),
      state: { kind: 'decision', decision: 'split_archive' },
      accept_block: 'Сначала разделите архив',
      fields: fields({ type: 'raw', title: 'Июль', raw_purpose: 'unknown' }),
      files: files(
        'g-zip-july',
        ARCHIVE_FOLDERS.map(({ folder, count, media }) => ({
          count,
          media,
          role: media === 'photo' ? ('photo' as const) : ('raw' as const),
          label: media === 'photo' ? undefined : () => 'файл съёмки',
          duration_s: 40,
          size_bytes: media === 'photo' ? Math.round(2.4 * MB) : 300 * MB,
          name: (index: number) =>
            `${folder}/IMG_${String(index).padStart(4, '0')}.${media === 'photo' ? 'JPG' : 'MOV'}`,
        })),
        at('2026-07-20', '12:00'),
      ),
      archive_entries: 214,
    }),
  ]
}

function rareReady(): InboxRecord[] {
  return [
    group({
      id: 'g-sxt-robe',
      title: 'Секстинг · чулки и халат · 18 файлов',
      source_path: '5. Sextings / чулки и халат',
      root: '5. Sextings',
      arrived_at: at(TODAY, '09:50'),
      state: { kind: 'ready', note: { kind: 'new' } },
      fields: fields({ type: 'sexting', title: 'Чулки и халат', shot_on: '2026-09-20' }),
      files: files(
        'g-sxt-robe',
        [
          { count: 14, media: 'photo' },
          {
            count: 4,
            media: 'video',
            role: 'clip',
            duration_s: 18,
            size_bytes: 60 * MB,
            label: (index) => `видео ${index}`,
          },
        ],
        at('2026-09-20', '21:10'),
      ),
      accept_block: 'Номер выдадим после разбора старого Я.Диска',
    }),
    // Загрузка без цели проверена, но тип не выбран: ◆ «Что это?», а не «Готово».
    group({
      id: 'g-web-photos',
      title: 'Загружено вами · 3 фото',
      source_path: UPLOADED,
      root: UPLOADED,
      arrived_at: at(TODAY, '13:55'),
      state: { kind: 'decision', decision: 'what_is_it' },
      accept_block: 'Сначала выберите тип',
      fields: fields({}),
      files: files(
        'g-web-photos',
        [{ count: 3, media: 'photo', name: (index) => `photo_${index}.jpg` }],
        at(TODAY, '13:20'),
      ),
    }),
    group({
      id: 'g-1537-office',
      title: '15:37 в офисе',
      source_path: '3. Customs / 15:37 в офисе.mov',
      root: '3. Customs',
      arrived_at: at(TODAY, '08:10'),
      state: { kind: 'ready', note: { kind: 'new' } },
      fields: fields({ type: 'custom', title: 'В офисе', fan_name: 'unknown' }),
      files: files(
        'g-1537-office',
        [{ count: 1, media: 'video', duration_s: 912, size_bytes: 1_600 * MB }],
        at(TODAY, '07:30'),
      ),
      hints: [{ kind: 'duration_mismatch', text: 'в имени 15:37, в файле 15:12' }],
    }),
    group({
      id: 'g-life-coffee',
      title: 'Лайф · 9 фото',
      source_path: '6. Life / life_кофе_14.09.26',
      root: '6. Life',
      arrived_at: at(YESTERDAY, '09:00'),
      state: { kind: 'ready', note: { kind: 'new' } },
      fields: fields({ type: 'life', title: 'Кофе на балконе', shot_on: '2026-09-14' }),
      files: files('g-life-coffee', [{ count: 9, media: 'photo' }], at('2026-09-14', '10:15')),
      hints: [{ kind: 'changed_after_snapshot', text: 'изменён после снимка' }],
    }),
  ]
}

function rarePreparing(): InboxRecord[] {
  return [
    group({
      id: 'g-sets-2209',
      title: 'Сеты · 22.09.26 · 40 фото',
      source_path: '4. Sets / 22.09.26',
      root: '4. Sets',
      arrived_at: at(TODAY, '14:05'),
      state: {
        kind: 'preparing',
        stage: 'discovered',
        progress: null,
        done_bytes: null,
        total_bytes: 104 * MB,
      },
      fields: fields({ type: 'set', title: 'Сет 22 сентября', shot_on: '2026-09-22' }),
      files: files('g-sets-2209', [{ count: 40, media: 'photo' }], at(TODAY, '11:00')),
      accept_block: 'Ещё качается',
      ready_in_min: 8,
    }),
    group({
      id: 'g-web-videos',
      title: 'Загружено вами · 2 видео',
      source_path: UPLOADED,
      root: UPLOADED,
      arrived_at: at(TODAY, '14:12'),
      state: {
        kind: 'preparing',
        stage: 'checking',
        progress: null,
        done_bytes: null,
        total_bytes: null,
      },
      fields: fields({}),
      files: files(
        'g-web-videos',
        [{ count: 2, media: 'video', role: 'clip', duration_s: 21, size_bytes: 80 * MB }],
        at(TODAY, '14:00'),
      ),
      accept_block: 'Проверяется',
      ready_in_min: 2,
    }),
    group({
      id: 'g-life-beach',
      title: 'Лайф · 30 фото',
      source_path: '6. Life / life_пляж_20.09.26',
      root: '6. Life',
      arrived_at: at(TODAY, '13:20'),
      state: {
        kind: 'preparing',
        stage: 'preview',
        progress: 0.4,
        done_bytes: null,
        total_bytes: null,
      },
      fields: fields({ type: 'life', title: 'Пляж', shot_on: '2026-09-20' }),
      files: files('g-life-beach', [{ count: 30, media: 'photo' }], at('2026-09-20', '17:40')),
      accept_block: 'Превью собирается · 40 %',
      ready_in_min: 4,
    }),
  ]
}

/** The ordinary Tuesday plus every rarer case of the acceptance table. */
export function buildCasesInbox(): InboxRecord[] {
  return [...buildLoraInbox(), ...rareDecisions(), ...rareReady(), ...rarePreparing()]
}
