import { describe, expect, it } from 'vitest'
import { parseLegacyPath } from './path.ts'
import type { ClaimKind, PathContext } from './types.ts'

/**
 * Every row of the import matrix (legacy-and-import §8) on a fictional name of the same shape.
 * `row` quotes the matrix row; rows marked «снято» are checked by the current rule (SPEC
 * §6.3–6.4): the shift is cancelled, FYP batches get no page, SXT-010/011 only by evidence.
 */

interface MatrixRow {
  row: string
  path: string
  isDir?: boolean
  context?: Partial<PathContext>
  claims: [ClaimKind, Record<string, unknown>][]
  unknown?: string[]
}

const usage = (
  label: string,
  account: unknown,
  iso: string | null,
  post: number | null = null,
) => ({
  label,
  account,
  post_of_day: post,
  date: iso === null ? null : expect.objectContaining({ iso }),
})
const idx = (index: number) => ({ kind: 'index', index })
const ALL = { kind: 'all' }
const UNKNOWN = { kind: 'unknown' }

const MATRIX: MatrixRow[] = [
  {
    row: '`[PPV-0NN]_slug_date/` — номер, дата папки как заявка, бандл',
    path: '1. PPV/Bundles/[PPV-022]_velvet_chair_19.01.2026',
    isDir: true,
    context: { area: 'ppv', typeHint: 'PPV', ppvKind: 'bundle' },
    claims: [
      ['number', { type: 'PPV', number: 22, form: 'bracket', reserves: true }],
      ['title', { text: 'velvet chair', lang: 'en' }],
      ['date', { date: expect.objectContaining({ iso: '2026-01-19' }), unset: false }],
    ],
  },
  {
    row: '`[PPV-0NN]_slug_Nmin_X.X.X/` — «дата не проставлена», не «не выпущен»; PPV в личку',
    path: '1. PPV/[PPV-066]_rope_stretch_6min_X.X.X',
    isDir: true,
    context: { ppvKind: 'dm' },
    claims: [
      ['number', { type: 'PPV', number: 66 }],
      ['duration', { seconds: 360, approximate: true }],
      ['date', { date: null, unset: true }],
    ],
  },
  {
    row: '`[PPV-068]_slug_X` — дата не проставлена коротким `X`',
    path: '1. PPV/Bundles/[PPV-068]_frost_blowjob_X',
    isDir: true,
    claims: [
      ['number', { number: 68 }],
      ['date', { unset: true }],
    ],
  },
  {
    row: '`usedN_DD.MM.YY` — заявленные размещения на lora-N',
    path: '2. FYP/August 2026/used3_04.08.26_used2_31.07.26.mov',
    context: { typeHint: 'FYP' },
    claims: [
      ['used', usage('used3', idx(3), '2026-08-04')],
      ['used', usage('used2', idx(2), '2026-07-31')],
    ],
  },
  {
    row: '`usedN_K_DD.MM` — K-й пост дня; без года — дата неизвестна наполовину',
    path: '2. FYP/Posted/August 2025 (posted)/posted/used1_1_28.07.MOV',
    claims: [['used', usage('used1', idx(1), '--07-28', 1)]],
  },
  {
    row: '`posted_<дата>` — lora-1',
    path: '2. FYP/July 2026/posted_12.03.26.mov',
    claims: [['posted', usage('posted', idx(1), '2026-03-12')]],
  },
  {
    row: '`posted_all` — три аккаунта; длительность приклеена к году',
    path: '1. PPV/Bundles/[PPV-011]_tease_11min_02.10.2025/posted_all_3.10.2510:41 в комбинезоне.mov',
    claims: [
      ['posted', usage('posted_all', ALL, '2025-10-03')],
      ['duration', { seconds: 641 }],
      ['title', { text: 'в комбинезоне' }],
    ],
  },
  {
    row: '`used_all` — три аккаунта, дата неизвестна',
    path: '4. Sets/Posted sets/set_на_подоконнике_11.07.25(used_all)',
    isDir: true,
    claims: [
      ['used', usage('used_all', ALL, null)],
      ['date', { date: expect.objectContaining({ iso: '2025-07-11' }) }],
      ['title', { text: 'на подоконнике' }],
    ],
  },
  {
    row: '`(usedN)` без даты — дата неизвестна',
    path: '7. Pictures/IMG_9001(used2).JPG',
    claims: [
      ['used', usage('used2', idx(2), null)],
      ['origin', { origin: 'camera' }],
    ],
  },
  {
    row: '`used` без номера — выходило, страница неизвестна',
    path: '6. Life/Life_others/used_08.09IMG_5001.JPG',
    claims: [['used', usage('used', UNKNOWN, '--09-08')]],
  },
  {
    row: '`FYP_NN_DD.MM.YY` — алиас номера батча; страницу подтверждает КМ (снято: lora-1)',
    path: '2. FYP/Posted/May 2025(posted)/FYP_03_16.04.25.MOV',
    claims: [
      ['number', { type: 'FYP', number: 3, form: 'fyp_batch', reserves: false }],
      ['posted', usage('fyp_batch', UNKNOWN, '2025-04-16')],
    ],
  },
  {
    row: '`Posted/<Month YYYY> (posted)/` — служебная папка: выходило, страница неизвестна',
    path: '2. FYP/Posted/May 2025(posted)',
    isDir: true,
    claims: [
      ['posted', usage('posted_folder', UNKNOWN, null)],
      ['date', { date: expect.objectContaining({ iso: '2025-05' }) }],
    ],
  },
  {
    row: '`7. Pictures` — `IMG_2552(used1_12.07).JPG`',
    path: '7. Pictures/IMG_2552(used1_12.07).JPG',
    context: { area: 'pictures', typeHint: 'LIFE|SET' },
    claims: [['used', usage('used1', idx(1), '--07-12')]],
  },
  {
    row: '`7. Pictures` — `(2used_15.07)IMG_2555.JPG`',
    path: '7. Pictures/(2used_15.07)IMG_2555.JPG',
    claims: [['used', { ...usage('used2', idx(2), '--07-15'), notes: ['prefix'] }]],
  },
  {
    row: '`7. Pictures` — `used2_12.07.JPG`',
    path: '7. Pictures/used3_12.07.JPG',
    claims: [['used', usage('used3', idx(3), '--07-12')]],
  },
  {
    row: '`set_*` — SET, дата из имени — заявка',
    path: '4. Sets/Posted sets/set_красная_пижама_18.06.26',
    isDir: true,
    context: { area: 'sets', typeHint: 'SET' },
    claims: [
      ['title', { text: 'красная пижама', lang: 'ru' }],
      ['date', { date: expect.objectContaining({ iso: '2026-06-18' }) }],
    ],
  },
  {
    row: '`[Set-002]` — старый SET-номер',
    path: '4. Sets/Posted sets/[Set-002]_robe_on_table_26.04.25',
    isDir: true,
    claims: [
      ['number', { type: 'SET', number: 2, form: 'bracket', reserves: true }],
      ['title', { text: 'robe on table' }],
    ],
  },
  {
    row: '`non used_used__` — размещение 20.07, аккаунт неизвестен',
    path: '4. Sets/non used_used__20.07_set_летний_сад_10.07',
    isDir: true,
    claims: [
      ['used', usage('used', UNKNOWN, '--07-20')],
      ['title', { text: 'летний сад' }],
      ['date', { date: expect.objectContaining({ iso: '--07-10' }) }],
    ],
  },
  {
    row: '`posted_all_set_` — три аккаунта',
    path: '4. Sets/Posted sets/posted_all_set_голубые_носки_13.10.25',
    isDir: true,
    claims: [
      ['posted', usage('posted_all', ALL, null)],
      ['title', { text: 'голубые носки' }],
    ],
  },
  {
    row: 'сет: `original/` → raw',
    path: '4. Sets/Posted sets/[Set-002]_robe_on_table_26.04.25/original',
    isDir: true,
    claims: [['role', { role: 'raw' }]],
  },
  {
    row: 'сет: `ed/` → ed',
    path: '4. Sets/non used_used__20.07_set_летний_сад_10.07/ed',
    isDir: true,
    claims: [['role', { role: 'ed' }]],
  },
  {
    row: '`sexting_NNN` — SXT с сохранением номера',
    path: '5. Sextings/sexting_012_satin_heels_30.05.26',
    isDir: true,
    context: { area: 'sextings', typeHint: 'SXT' },
    claims: [
      ['number', { type: 'SXT', number: 12, form: 'sexting', reserves: true }],
      ['title', { text: 'satin heels' }],
    ],
  },
  {
    row: '`sexting _002…` — пробел перед подчёркиванием',
    path: '5. Sextings/sexting _002_homemade_robe_30.01.25',
    isDir: true,
    claims: [['number', { type: 'SXT', number: 2 }]],
  },
  {
    row: 'секстинг: `optional/`, `extra/` — теги, не роли',
    path: '5. Sextings/sexting _002_homemade_robe_30.01.25/optional',
    isDir: true,
    claims: [['tag', { tag: 'optional' }]],
  },
  {
    row: '`sexting feb.zip` — архив (010/011 — только по улике, SPEC §6.4)',
    path: '5. Sextings/sexting feb.zip',
    context: { isArchive: true },
    claims: [['date', { date: expect.objectContaining({ iso: '--02' }) }]],
  },
  {
    row: '`MM:SS <описание>.mov` — длительность и название как есть',
    path: '3. Customs/14:05 в синем платье .mov',
    context: { area: 'customs', typeHint: 'CUS' },
    claims: [
      ['duration', { seconds: 845, approximate: false }],
      ['title', { text: 'в синем платье', lang: 'ru' }],
    ],
  },
  {
    row: '`MM:SS <ник>.mov` — ник фана и есть название (решение 30.10.2026)',
    path: '3. Customs/13:03 Орион .mov',
    claims: [
      ['duration', { seconds: 783 }],
      ['title', { text: 'Орион' }],
    ],
  },
  {
    row: '`Кастом N минут …`',
    path: '3. Customs/Кастом 10 минут для Ориона.mov',
    claims: [
      ['duration', { seconds: 600, approximate: true }],
      ['title', { text: 'для Ориона' }],
    ],
  },
  {
    row: '`Custom_…` — описание, длительность, ник, дата',
    path: '3. Customs/Custom_в_халате_14мин_orionfan77_12.05.25.mov',
    claims: [
      ['duration', { seconds: 840 }],
      ['date', { date: expect.objectContaining({ iso: '2025-05-12' }) }],
      ['title', { text: 'в халате orionfan77', lang: 'mixed' }],
    ],
  },
  {
    row: 'кастом «прочее» — название без длительности',
    path: '3. Customs/Пахнущие кеды.mov',
    claims: [['title', { text: 'Пахнущие кеды' }]],
  },
  {
    row: '`отобранное на PPV/` — связь происхождения по md5',
    path: '3. Customs/отобранное на PPV/Растяжка и верёвка.mov',
    context: { selectedForPpv: true, typeHint: 'CUS' },
    claims: [['title', { text: 'Растяжка и верёвка' }]],
  },
  {
    row: '`1. PPV/Bundles/*`: `full.mov` — master',
    path: '1. PPV/Bundles/[PPV-024]_cotton_robe_02.12.2025/full.mov',
    claims: [['role', { role: 'master' }]],
  },
  {
    row: '`1. PPV/Bundles/*`: `13 минут(used1).mov` — мастер по длительности',
    path: '1. PPV/Bundles/[PPV-024]_cotton_robe_02.12.2025/13 минут(used1).mov',
    claims: [
      ['duration', { seconds: 780, approximate: true }],
      ['used', usage('used1', idx(1), null)],
    ],
  },
  {
    row: '`1. PPV/Bundles/*`: `copy_*.mov` — копия iOS',
    path: '1. PPV/7.08.2026/copy_0A1B2C3D-4E5F-4061-8293-A4B5C6D7E8F9.mov',
    context: { typeHint: 'RAW', rawPurpose: 'ppv' },
    claims: [['origin', { origin: 'ios_copy' }]],
  },
  {
    row: '`promo*` — teaser',
    path: '1. PPV/Bundles/[PPV-022]_velvet_chair_19.01.2026/promo2.MOV',
    claims: [['role', { role: 'teaser', ordinal: 2, word: 'promo' }]],
  },
  {
    row: '`lv_0_*` — teaser, экспорт CapCut',
    path: '1. PPV/[PPV-066]_rope_stretch_6min_X.X.X/lv_0_20260323145220.mp4',
    claims: [
      ['role', { role: 'teaser' }],
      ['origin', { origin: 'capcut' }],
    ],
  },
  {
    row: '`тизер` — teaser',
    path: '1. PPV/Bundles/[PPV-024]_cotton_robe_02.12.2025/тизер.mp4',
    claims: [['role', { role: 'teaser', word: 'тизер' }]],
  },
  {
    row: 'фото-кастом `Custom_…_<фан>_дата/`',
    path: '3. Customs/Custom_фото_в_свитере_25шт_orionfan77_19.04.25',
    isDir: true,
    context: { typeHint: 'CUS' },
    claims: [
      ['title', { text: 'фото в свитере orionfan77' }],
      ['date', { date: expect.objectContaining({ iso: '2025-04-19' }) }],
    ],
  },
  {
    row: 'фото-кастом `38 фото/`',
    path: '3. Customs/38 фото',
    isDir: true,
    context: { typeHint: 'CUS' },
    claims: [],
  },
  {
    row: 'фото-кастом `<фан> фото видео/`',
    path: '3. Customs/орион фото видео',
    isDir: true,
    claims: [['title', { text: 'орион фото видео' }]],
  },
  {
    row: 'корень `8. Other` — файлы камеры → RAW по EXIF-дню',
    path: '8. Other/IMG_1101.HEIC',
    context: { area: 'other', typeHint: 'RAW' },
    claims: [['origin', { origin: 'camera' }]],
  },
  {
    row: '`8. Other/нюды/` — тег',
    path: '8. Other/нюды',
    isDir: true,
    claims: [['tag', { tag: 'нюды' }]],
  },
  {
    row: '`8. Other/ПЕРЕЕЗД/`, `примерочная/` — RAW, имя папки — название',
    path: '8. Other/ПЕРЕЕЗД',
    isDir: true,
    claims: [['title', { text: 'ПЕРЕЕЗД' }]],
  },
  {
    row: 'дамп в корне `9. SMM` — RAW, сырьё для FYP',
    path: '9. SMM/IMG_8283.mov',
    context: { area: 'smm', typeHint: 'RAW', rawPurpose: 'fyp', promoChannel: null },
    claims: [['origin', { origin: 'camera' }]],
  },
  {
    row: 'подрядческая папка SMM — PRM, экспорт подрядчика',
    path: '9. SMM/Twitter/zenpromo june/photos/june_photo_001_img_1234_0a1b2c3d4e.jpg',
    context: { typeHint: 'PRM', promoChannel: 'Twitter' },
    claims: [
      ['origin', { origin: 'contractor_export' }],
      ['role', { ordinal: 1 }],
    ],
  },
  {
    row: '`YT` — канал, вендор в имени папки',
    path: '9. SMM/YT/Mirko/декабрь - ASMR - 6 видео ',
    isDir: true,
    context: { typeHint: 'PRM', promoChannel: 'YT' },
    claims: [
      ['date', { date: expect.objectContaining({ iso: '--12' }) }],
      ['title', { text: 'ASMR' }],
    ],
  },
  {
    row: '`SteadyContent` — исходники модели для подрядчика: RAW «фупы», тег вендора',
    path: '2. FYP/SteadyContent',
    isDir: true,
    context: { typeHint: 'RAW', rawPurpose: 'fyp', vendor: 'steadycontent' },
    claims: [['tag', { tag: 'steadycontent' }]],
  },
  {
    row: '`SteadyContent/<Month>/11-2.MOV`, `1.3.mov` — задание N, дубль K: сырьё фупов',
    path: '2. FYP/SteadyContent/January/11-2.MOV',
    context: { typeHint: 'RAW', rawPurpose: 'fyp', vendor: 'steadycontent' },
    claims: [['role', { role: null, ordinal: 11 }]],
  },
  {
    row: '`SteadyContent/<Month>/IMG_*.mov` — тоже исходники подрядчика',
    path: '2. FYP/SteadyContent/May/IMG_3724.mov',
    context: { typeHint: 'RAW', rawPurpose: 'fyp' },
    claims: [['origin', { origin: 'camera' }]],
  },
  {
    row: 'дубль задания `N-K` в `2. FYP` на любой глубине — сырьё фупов',
    path: '2. FYP/Ноябрь/3-2.MOV',
    context: { typeHint: 'RAW', rawPurpose: 'fyp' },
    claims: [['role', { role: null, ordinal: 3 }]],
  },
  {
    row: 'файл камеры прямо в `2. FYP` (`Видео 01.11.2026, 10 45 34 PM.mov`, `IMG_*`) — сырьё фупов',
    path: '2. FYP/Видео 01.11.2026, 10 45 34 PM (1).mov',
    context: { typeHint: 'RAW', rawPurpose: 'fyp' },
    claims: [['date', { date: expect.objectContaining({ iso: '2026-11-01' }) }]],
  },
  {
    row: 'фото прямо в `2. FYP` — сырьё фупов',
    path: '2. FYP/ref.jpg',
    context: { typeHint: 'RAW', rawPurpose: 'fyp' },
    claims: [['title', { text: 'ref' }]],
  },
  {
    row: 'фуп прямо в `2. FYP` с именем батча или меток — FYP',
    path: '2. FYP/FYP_2_13.06.25.mov',
    context: { typeHint: 'FYP', rawPurpose: null },
    claims: [['number', { type: 'FYP', number: 2, form: 'fyp_batch' }]],
  },
  {
    row: 'номер ролика в месяце `Posted` (`25.mov`) — выложенный FYP, не дубль',
    path: '2. FYP/Posted/April 2025 (posted)/25.mov',
    context: { typeHint: 'FYP', rawPurpose: null },
    claims: [['role', { role: null, ordinal: 25 }]],
  },
  {
    row: '`BG/13:08 кастом минет` — CUS с жанром bg',
    path: 'BG/13:08 кастом у окна.mov',
    context: { area: 'bg', genre: 'bg', typeHint: 'CUS' },
    claims: [
      ['duration', { seconds: 788 }],
      ['title', { text: 'кастом у окна' }],
    ],
  },
  {
    row: '`BG/1. PPV/` — кандидаты PPV с живого счётчика',
    path: 'BG/1. PPV/3-teaser.mov',
    context: { genre: 'bg', subArea: 'ppv', typeHint: 'PPV' },
    claims: [['role', { role: 'teaser', ordinal: 3 }]],
  },
  {
    row: '`6. Life` — LIFE по папкам',
    path: '6. Life/posted/Life_прогулка_в_парке_09.12.25',
    isDir: true,
    context: { area: 'life', typeHint: 'LIFE' },
    claims: [
      ['title', { text: 'прогулка в парке' }],
      ['date', { date: expect.objectContaining({ iso: '2025-12-09' }) }],
    ],
  },
  {
    row: '`6. Life/posted/` — заявленные размещения, страница неизвестна',
    path: '6. Life/posted',
    isDir: true,
    claims: [['posted', usage('posted_folder', UNKNOWN, null)]],
  },
  {
    row: '`8. Other/Под рассылки` — RAW с назначением «рассылка»',
    path: '8. Other/Под рассылки/IMG_2001.JPG',
    context: { typeHint: 'RAW', rawPurpose: 'mass_dm' },
    claims: [['origin', { origin: 'camera' }]],
  },
  {
    row: 'корневые zip — распаковка, снятие дублей',
    path: 'archive-2025-11-04_01-02-03.zip',
    context: { area: 'root', isArchive: true, foreignModel: null },
    claims: [['origin', { origin: 'export' }]],
  },
  {
    row: 'архив другой модели — паркуется до её подключения',
    path: 'Bea FYP — монтаж (КМ) — 2026-08-18.zip',
    context: { isArchive: true, foreignModel: 'Bea' },
    claims: [['date', { date: expect.objectContaining({ iso: '2026-08-18' }) }]],
  },
  {
    row: 'корневые `IMG_7707/7708.mov` — второе местоположение того же ассета',
    path: 'IMG_7707.mov',
    context: { area: 'root', typeHint: 'RAW' },
    claims: [['origin', { origin: 'camera' }]],
  },
  {
    row: '`Старый формат`: `PPV/old/NNN bndl Nmin …(used_all)` — номер только алиас',
    path: 'Старый формат/PPV/old/001 bndl 8min ванна(used_all).mov',
    context: { area: 'old_format', subArea: 'ppv' },
    claims: [
      ['number', { type: 'PPV', number: 1, form: 'old_format', reserves: false }],
      ['duration', { seconds: 480 }],
      ['used', usage('used_all', ALL, null)],
      ['title', { text: 'ванна' }],
    ],
  },
  {
    row: '`Старый формат`: `(used_all)016 …`',
    path: 'Старый формат/PPV/old/(used_all)016 bndl 2min душ.mov',
    claims: [
      ['used', usage('used_all', ALL, null)],
      ['number', { type: 'PPV', number: 16, reserves: false }],
    ],
  },
  {
    row: '`Старый формат`: `Sets/NNN …`',
    path: 'Старый формат/Sets/014 на балконе',
    isDir: true,
    claims: [
      ['number', { type: 'SET', number: 14, form: 'old_format', reserves: false }],
      ['title', { text: 'на балконе' }],
    ],
  },
  {
    row: '`Старый формат`: метки `(usedN)` — заявки, как у FYP',
    path: 'Старый формат/FYP/IMG_3001(used2).MOV',
    claims: [['used', usage('used2', idx(2), null)]],
  },
  // Найдено 30.10.2026 при замере (legacy §8, конец таблицы).
  {
    row: 'найдено 30.10.2026: формат Notion `PPV_<описание>_<N>мин_<дата>_кастом_<ник>`',
    path: '1. PPV/[PPV-001]_lotus_pose_7min_03.03.2025/PPV_Лотос_7мин_03.03.25_кастом_Orion(Used1).MOV',
    claims: [
      ['title', { text: 'Лотос' }],
      ['duration', { seconds: 420 }],
      ['origin', { origin: 'custom', fan: 'Orion' }],
      ['used', usage('used1', idx(1), null)],
    ],
  },
  {
    row: 'найдено 30.10.2026: опечатки меток `ued3`, `usd2`, дата через запятую',
    path: '9. SMM/Gif сайты/Апрель/usd2_1_27,09.mov',
    claims: [['used', { ...usage('used2', idx(2), '--09-27', 1), notes: ['typo'] }]],
  },
  {
    row: 'найдено 30.10.2026: K приклеен к дате `used_all_125.08`',
    path: '2. FYP/Posted/August 2025 (posted)/posted/used_all_124.08_.MOV',
    claims: [['used', { ...usage('used_all', ALL, '--08-24', 1), notes: ['glued'] }]],
  },
  {
    row: 'найдено 30.10.2026: дата приклеена к метке `12.091used`, двойная точка `17..09`',
    path: '2. FYP/Posted/September2025 (posted)/posted/used1_2_11.091used_2_16..09.MOV',
    claims: [
      ['used', usage('used1', idx(1), '--09-11', 2)],
      ['used', usage('used1', idx(1), '--09-16', 2)],
    ],
  },
  {
    row: 'найдено 30.10.2026: `posted_allife_…` — `posted_all` и `life` слиплись',
    path: '6. Life/posted/posted_allife_сбор_груш_21.09',
    isDir: true,
    claims: [
      ['posted', usage('posted_all', ALL, null)],
      ['title', { text: 'сбор груш' }],
    ],
  },
  {
    row: 'найдено 30.10.2026: метки `usedN` с N > 3 (`used10`) — на подтверждение КМ',
    path: '9. SMM/Twitter/clips/used10.MOV',
    claims: [['used', usage('used10', idx(10), null)]],
  },
  {
    row: 'найдено 30.10.2026: имена из одних цифр — выгрузка мессенджера или галереи',
    path: '1. PPV/[PPV-054]_slow_14min_X.X.X/1000100001 (1).jpg',
    claims: [['origin', { origin: 'messenger' }]],
  },
  {
    row: 'найдено 30.10.2026: `photo_YYYY-MM-DD_hh-mm-ss` — сохранено из Telegram',
    path: '1. PPV/Bundles/[PPV-068]_frost_blowjob_X/photo_2026-04-20_21-10-05.jpg',
    claims: [['origin', { origin: 'messenger' }]],
  },
  {
    row: 'найдено 30.10.2026: `$RXXXXXX` — файлы, восстановленные из корзины Windows',
    path: '4. Sets/Posted sets/Set_желтый_топ_08.05.25/original/$RQ4K7ZP.JPG',
    claims: [['origin', { origin: 'recovered' }]],
  },
  {
    row: 'найдено 30.10.2026: снимки экрана и `YYYY-MM-DD hh.mm.ss`',
    path: 'BG/7. Pictures/2025-03-01 08.15.40.jpg',
    claims: [
      ['origin', { origin: 'export' }],
      ['date', { date: expect.objectContaining({ iso: '2025-03-01' }) }],
    ],
  },
  {
    row: 'найдено 30.10.2026: подписи кадров сета `4_legs_promo`',
    path: '4. Sets/Posted sets/set_утро_21.05.25(used3)(used2)/4_legs_promo.JPG',
    claims: [
      ['role', { role: null, ordinal: 4 }],
      ['role', { role: 'teaser', word: 'promo' }],
      ['title', { text: 'legs' }],
    ],
  },
]

/**
 * The shapes of a Telegram-mirrored archive (Ари, 03.11.2026; legacy-and-import §10) on
 * fictional names: packs named by the ID, export names, the `SEX` alias, message numbers,
 * «✅ ЗАПОЩЕНО», FYP sources and takes, references, not-content and message folders.
 */
const PACKS: MatrixRow[] = [
  {
    row: 'пак `PPV-NNN Название` в разделе своего типа — номер с резервом, название',
    path: '1. PPV/PPV-005 Синее платье, масло',
    isDir: true,
    context: { area: 'ppv', typeHint: 'PPV' },
    claims: [
      ['number', { type: 'PPV', number: 5, form: 'pack', reserves: true }],
      ['title', { text: 'Синее платье, масло' }],
    ],
  },
  {
    row: 'пак с датой впереди `ДД.ММ.ГГ SXT-NNN Название`',
    path: '5. Sextings/12.10.26 SXT-004 Красное бельё',
    isDir: true,
    claims: [
      ['date', { date: expect.objectContaining({ iso: '2026-10-12' }) }],
      ['number', { type: 'SXT', number: 4, form: 'pack', reserves: true }],
      ['title', { text: 'Красное бельё' }],
    ],
  },
  {
    row: '`SEX` — их слово для SXT',
    path: '5. Sextings/01.07.26 SEX-001 пак',
    isDir: true,
    claims: [['number', { type: 'SXT', number: 1, form: 'pack', reserves: true }]],
  },
  {
    row: 'ID без скобок вне раздела своего типа — только упоминание',
    path: '7. Монтажи/Агент/PPV-005',
    isDir: true,
    context: { area: 'montage', typeHint: 'FYP' },
    claims: [['number', { type: 'PPV', number: 5, form: 'loose', reserves: false }]],
  },
  {
    row: '`FYP NN — задание` в цикле — номер задания, не номер фупа',
    path: '2. FYP/1. Цикл 1 март — исходники/FYP 01 — Флеш',
    isDir: true,
    context: { typeHint: 'RAW', rawPurpose: 'fyp' },
    claims: [
      ['number', { type: 'FYP', number: 1, form: 'loose', reserves: false }],
      ['title', { text: 'Флеш' }],
    ],
  },
  {
    row: 'имя выгрузки: мастер с длительностью — ID без резерва, роль, длительность',
    path: '1. PPV/PPV-005 Синее платье, масло/PPV-005_blue-dress-oil_master__7m12s.mov',
    claims: [
      ['number', { type: 'PPV', number: 5, form: 'export', reserves: false }],
      ['title', { text: 'blue dress oil', lang: 'en' }],
      ['role', { role: 'master', ordinal: null }],
      ['duration', { seconds: 432, approximate: false }],
    ],
  },
  {
    row: 'имя выгрузки: кадр второй версии',
    path: '1. PPV/PPV-005 Синее платье, масло/PPV-005_blue-dress-oil_pic04_v2.jpg',
    claims: [['role', { role: 'pic', ordinal: 4, version: 2 }]],
  },
  {
    row: 'имя выгрузки секстинга: порядок показа и номер роли',
    path: '5. Sextings/12.10.26 SXT-004 Красное бельё/SXT-004_03_clip02.mov',
    claims: [
      ['number', { type: 'SXT', number: 4, form: 'export', reserves: false }],
      ['role', { role: 'clip', ordinal: 2, position: 3 }],
    ],
  },
  {
    row: 'файл под номером сообщения Telegram',
    path: '4. Sets/05-07.06.26 новая квартира (не разобрано)/176543.jpg',
    claims: [['origin', { origin: 'messenger' }]],
  },
  {
    row: 'номер сообщения приклеен к имени камеры',
    path: '2. FYP/2. Цикл 2 июнь — исходники/Пробы образов 07.06/IMG_7077_175668.MOV',
    context: { typeHint: 'RAW', rawPurpose: 'fyp' },
    claims: [
      ['origin', { origin: 'camera' }],
      ['origin', { origin: 'messenger' }],
    ],
  },
  {
    row: '«✅ ЗАПОЩЕНО ДД.ММ» готового фупа — то же, что `posted_ДД.ММ`',
    path: '7. Монтажи/готовые фупы/✅ ЗАПОЩЕНО 02.09 — warm up.mp4',
    context: { typeHint: 'FYP' },
    claims: [
      ['posted', usage('posted', idx(1), '--09-02')],
      ['title', { text: 'warm up' }],
    ],
  },
  {
    row: 'дубли задания фупа — сырьё для фупов',
    path: '2. FYP/3. Цикл 3 сентябрь — исходники/FYP 02/Дубли/IMG_9382.MOV',
    context: { typeHint: 'RAW', rawPurpose: 'fyp' },
    claims: [['origin', { origin: 'camera' }]],
  },
  {
    row: 'папка дня в 2. FYP — съёмка модели, сырьё для фупов',
    path: '2. FYP/18.10.26/IMG_1128.MOV',
    context: { typeHint: 'RAW', rawPurpose: 'fyp' },
    claims: [['origin', { origin: 'camera' }]],
  },
  {
    row: 'задание «Повторить реф…» с дублями — контент',
    path: '2. FYP/2. Цикл 2 июнь — исходники/FYP 02 — Повторить реф без лица/Дубли/IMG_6797.MOV',
    context: { typeHint: 'RAW' },
    claims: [['origin', { origin: 'camera' }]],
  },
  {
    row: 'реф в `ТЗ/` — не контент, заявок нет',
    path: '2. FYP/1. Цикл 1 март — исходники/FYP 01 — Флеш/ТЗ/tz_212.mp4',
    context: { notContent: 'рефы и карточки заказов' },
    claims: [],
  },
  {
    row: '`ТЗ рефы`, `карточки и рефы заказов`, `Отменённый реф` — не контент',
    path: '3. Customs/карточки и рефы заказов/01.10.26_1658.jpg',
    context: { notContent: 'рефы и карточки заказов' },
    claims: [],
  },
  {
    row: 'папка «не контент» — не контент',
    path: '8. Other/не контент/группа/1131.jpg',
    context: { notContent: 'не контент' },
    claims: [],
  },
  {
    row: 'переписка (`личка`, `чат группы`) — тип решает человек',
    path: '8. Other/личка/29.09.26/204929.jpg',
    context: { typeHint: null },
    claims: [['origin', { origin: 'messenger' }]],
  },
]

describe('legacy §8 matrix', () => {
  it.each([...MATRIX, ...PACKS])('$row', ({ path, isDir, context, claims, unknown }) => {
    const parsed = parseLegacyPath(`disk:/${path}`, {
      isDir: isDir ?? false,
      foreignModelNames: ['Bea'],
    })
    if (context) expect(parsed.context).toMatchObject(context)
    for (const [kind, payload] of claims) {
      expect(parsed.claims).toContainEqual(
        expect.objectContaining({ kind, payload: expect.objectContaining(payload) }),
      )
    }
    const found = parsed.claims.filter((c) => c.kind === 'unknown').map((c) => c.raw_fragment)
    expect(found).toEqual(unknown ?? [])
    for (const claim of parsed.claims) {
      expect(path.normalize('NFC')).toContain(claim.raw_fragment)
      expect(claim.claim_key).toMatch(/^[0-9a-f]{10}:[a-z_]+:\d+/)
    }
    if (claims.length === 0) expect(parsed.claims).toEqual([])
  })

  it('a path of the model list is not content; nothing else is', () => {
    const notContent = ['_опись', '3. Customs/[CUS-001]_a_02.09.26/1227.jpg']
    const of = (path: string) =>
      parseLegacyPath(path, { isDir: false, notContent }).context.notContent
    expect(of('_опись/контактные листы/photos_01.jpg')).toBe('по списку модели')
    expect(of('3. Customs/[CUS-001]_a_02.09.26/1227.jpg')).toBe('по списку модели')
    expect(of('3. Customs/[CUS-001]_a_02.09.26/IMG_9187.MOV')).toBeUndefined()
    expect(of('_описание/x.jpg')).toBeUndefined()
  })
})
