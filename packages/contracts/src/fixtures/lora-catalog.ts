import { addDays } from '../clock'
import type { CatalogEntry } from '../domain/catalog'
import type { ItemId } from '../domain/item-type'
import { formatItemId } from '../domain/item-type'
import { type CatalogPlan, generateCatalog, numberRange, sparseNumbers } from './catalog-generator'
import { collectionId, LORA_COLLECTIONS } from './lora-promo'
import { createRandom } from './random'

/**
 * Лора's catalog: 1 391 objects (DESIGN §9.3) — PPV 90 (52 bundles, 38 «в личку»),
 * FYP 796 (150 SteadyContent), customs 197 (5 photo customs, 38 already in PPV),
 * sets 73, sextings 12, life 118, raw 83, promo 22.
 */

const PPV_NUMBERS = [...numberRange(1, 76), ...numberRange(81, 94)]
const BG_MASTERS = numberRange(83, 94)
const FYP_NUMBERS = numberRange(1, 803, [100, 200, 300, 400, 650, 700, 750])
const STEADY_CONTENT = numberRange(451, 600)
const SET_NUMBERS = numberRange(1, 74, [50])
const SEXTING_NUMBERS = [...numberRange(1, 9), 12, 13, 14]
const LIFE_NUMBERS = sparseNumbers('lora-life-numbers', 118, 191, [141, 191])
const RAW_NUMBERS = sparseNumbers('lora-raw-numbers', 83, 214, [34, 213, 214])
const PHOTO_CUSTOMS = [45, 102, 133, 160, 171]
const BG_CUSTOMS = [120, 153]

export const LORA_CATALOG_PLAN: CatalogPlan = {
  seed: 'lora-2026-09-22',
  types: [
    { type: 'ppv', numbers: PPV_NUMBERS, arrived_from: '2024-11-04', arrived_to: '2026-09-16' },
    { type: 'fyp', numbers: FYP_NUMBERS, arrived_from: '2025-01-10', arrived_to: '2026-09-18' },
    {
      type: 'custom',
      numbers: numberRange(1, 197),
      arrived_from: '2025-02-01',
      arrived_to: '2026-09-18',
    },
    { type: 'set', numbers: SET_NUMBERS, arrived_from: '2025-01-06', arrived_to: '2026-09-12' },
    {
      type: 'sexting',
      numbers: SEXTING_NUMBERS,
      arrived_from: '2025-01-24',
      arrived_to: '2026-09-19',
    },
    { type: 'life', numbers: LIFE_NUMBERS, arrived_from: '2025-01-15', arrived_to: '2026-09-20' },
    { type: 'raw', numbers: RAW_NUMBERS, arrived_from: '2025-03-01', arrived_to: '2026-09-20' },
    {
      type: 'promo',
      numbers: numberRange(1, 22),
      arrived_from: '2025-12-20',
      arrived_to: '2026-09-18',
    },
  ],
}

type EntryPatch = Partial<CatalogEntry>

/** Objects of the §9.3 table, exactly as described. */
const DETAILED: Record<ItemId, EntryPatch> = {
  'PPV-073': {
    title: 'День рождения, торт, кружево',
    ppv_kind: 'bundle',
    duration_s: 804,
    photo_count: 21,
    has_teaser: true,
    version_count: 2,
    arrived_on: '2026-08-07',
    shot_on: '2026-08-06',
    tags: ['cake', 'lace', 'teasing', 'playful'],
    markup: 'confirmed',
    aliases: ['07.08 Birthday gift PPV'],
  },
  'PPV-074': {
    title: 'Кристаллы и каблуки',
    ppv_kind: 'bundle',
    duration_s: 581,
    // Два фото — те, что ушли в пост OF VIP «видео 9:41 и 2 фото» (DESIGN §6.9, §9.6).
    photo_count: 2,
    has_teaser: true,
    arrived_on: '2026-08-30',
    shot_on: '2026-08-28',
    tags: ['heels', 'teasing', 'bold'],
  },
  'PPV-075': {
    title: 'Коричневое кружево у зеркала',
    ppv_kind: 'dm',
    duration_s: 518,
    photo_count: 14,
    has_teaser: true,
    arrived_on: '2026-09-18',
    shot_on: '2026-09-16',
    tags: ['lace', 'mirror', 'teasing', 'tender'],
  },
  'PPV-076': {
    title: 'Нейлон и каблуки',
    ppv_kind: 'bundle',
    duration_s: 492,
    photo_count: 0,
    has_teaser: true,
    arrived_on: '2026-09-21',
    shot_on: '2026-09-12',
    tags: ['nylon', 'heels', 'teasing'],
    markup: 'draft',
  },
  'PPV-061': {
    title: 'Стиральная машина',
    ppv_kind: 'bundle',
    duration_s: 600,
    aliases: ['washing_machine'],
  },
  'PPV-032': {
    title: 'Молоко',
    aliases: ['PPV-032'],
    arrived_on: '2025-05-20',
    shot_on: '2025-05-18',
  },
  'PPV-081': {
    title: 'Хэллоуин',
    aliases: ['PPV-032'],
    arrived_on: '2025-05-20',
    shot_on: '2025-05-12',
  },
  'PPV-082': {
    title: 'Коричневый сет',
    aliases: ['PPV-032'],
    arrived_on: '2025-05-20',
    shot_on: '2025-05-15',
  },
  'PPV-067': {
    title: 'Мерцание, тизинг',
    duration_s: 300,
    arrived_on: '2026-04-10',
    shot_on: '2026-04-10',
    aliases: ['PPV-066'],
  },
  'CUS-197': {
    title: 'Босс',
    duration_s: 937,
    arrived_on: '2026-09-18',
    shot_on: '2026-09-17',
    delivered_on: '2026-09-18',
    fan_name: 'no',
    ppv_made_as: null,
    order_id: 'tg-1002627984998-12-9844',
  },
  'CUS-195': {
    title: 'Танец живота',
    duration_s: 221,
    arrived_on: '2026-09-19',
    shot_on: '2026-09-19',
    delivered_on: '2026-09-19',
    fan_name: 'unknown',
    ppv_made_as: null,
    version_count: 1,
    order_id: 'tg-1002627984998-12-9790',
  },
  'CUS-181': {
    title: 'Нейлон и каблуки',
    duration_s: 492,
    arrived_on: '2026-09-14',
    shot_on: '2026-09-12',
    delivered_on: '2026-09-14',
    fan_name: 'no',
    ppv_made_as: 'PPV-076',
  },
  'CUS-190': { title: 'Уборка', duration_s: 1068, ppv_made_as: null, fan_name: 'no' },
  'CUS-188': { title: 'Пов от девушки', duration_s: 1037, ppv_made_as: null, fan_name: 'yes' },
  'CUS-186': { title: 'Колготки', duration_s: 717, ppv_made_as: null, fan_name: 'no' },
  'CUS-184': { title: 'Йога с пробкой', duration_s: 336, ppv_made_as: null, fan_name: 'unknown' },
  'CUS-160': {
    title: '38 фото',
    duration_s: null,
    photo_count: 38,
    video_count: 0,
    photo_custom: true,
  },
  'SET-074': {
    title: 'Чтение книги, стринги',
    photo_count: 46,
    selected_count: 21,
    processed_count: 8,
    arrived_on: '2026-09-16',
    shot_on: '2026-09-16',
    tags: ['thong', 'bedroom', 'cozy'],
  },
  'SET-069': {
    title: 'Отель, красное платье у зеркала',
    arrived_on: '2026-08-05',
    shot_on: '2026-08-05',
    tags: ['hotel', 'red', 'mirror'],
  },
  'SET-073': {
    title: 'После душа',
    photo_count: 28,
    selected_count: 0,
    processed_count: 0,
    arrived_on: '2026-09-19',
    shot_on: '2026-09-02',
    markup: 'draft',
  },
  'SET-072': {
    title: 'Утро в постели',
    photo_count: 38,
    selected_count: 22,
    arrived_on: '2026-09-09',
    shot_on: '2026-09-08',
  },
  'SXT-012': {
    title: 'Чулки, каблуки',
    photo_count: 12,
    video_count: 3,
    arrived_on: '2026-05-31',
    shot_on: '2026-05-31',
    aliases: ['S12', 'S12 - Чулки, каблуки'],
  },
  'SXT-005': { title: 'Розовые стринги', aliases: ['S5'], arrived_on: '2025-03-14' },
  'FYP-0801': {
    title: 'Зеркало, чёрное боди',
    duration_s: 9,
    arrived_on: '2026-08-10',
    shot_on: '2026-08-09',
    tags: ['mirror', 'bodysuit', 'black'],
    markup: 'confirmed',
  },
  'FYP-0797': { title: 'Нейлон, офис', duration_s: 11, arrived_on: '2026-08-03' },
  'FYP-0799': { title: 'Халат у окна', duration_s: 9, arrived_on: '2026-08-06' },
  'FYP-0802': { title: 'Йога в леггинсах', duration_s: 8, arrived_on: '2026-09-10' },
  'FYP-0803': { title: 'Кружево утром', duration_s: 10, arrived_on: '2026-09-21', markup: 'draft' },
  'FYP-0412': { title: 'Йога у зеркала', duration_s: 10, tags: ['yoga', 'mirror', 'playful'] },
  'LIFE-191': {
    title: 'Завтрак у окна',
    tags: ['breakfast', 'window', 'morning', 'homey', 'cozy'],
    photo_count: 16,
    video_count: 2,
    life_unassigned: 4,
    life_chat_count: 6,
    life_feed_count: 6,
    arrived_on: '2026-09-21',
    shot_on: '2026-09-07',
  },
  'LIFE-141': {
    title: 'Сбор яблок',
    photo_count: 22,
    video_count: 0,
    life_unassigned: 0,
    life_chat_count: 9,
    life_feed_count: 13,
    shot_on: '2025-09-20',
  },
  'RAW-0214': {
    title: 'Съёмка 21 сентября',
    photo_count: 10,
    video_count: 12,
    raw_purpose: 'fyp',
    arrived_on: '2026-09-21',
    shot_on: '2026-09-21',
  },
  'RAW-0213': { title: 'Съёмка 20 сентября', arrived_on: '2026-09-20', shot_on: '2026-09-20' },
  'RAW-0034': {
    title: 'Съёмка 6 августа',
    photo_count: 24,
    video_count: 12,
    raw_purpose: 'ppv',
    arrived_on: '2026-08-06',
    shot_on: '2026-08-06',
  },
}

/** По названию на каждый мастер со вторым человеком — ряд PPV не повторяет одно и то же. */
const BG_TITLES = [
  'Вдвоём в спальне',
  'Вдвоём в душе',
  'Вдвоём на диване',
  'Вдвоём утром',
  'Вдвоём в отеле',
  'Вдвоём у зеркала',
  'Вдвоём на кухне',
  'Вдвоём, красное бельё',
  'Вдвоём в чулках',
  'Вдвоём в ванной',
  'Вдвоём вечером',
  'Вдвоём, массаж',
]

function shapePpv(entries: CatalogEntry[]) {
  const random = createRandom('lora-ppv-kinds')
  const ppv = entries.filter((entry) => entry.type === 'ppv')
  const pool = ppv.filter((entry) => DETAILED[entry.id]?.ppv_kind === undefined)
  const dmIds = new Set(['PPV-075', ...random.sample(pool, 37).map((entry) => entry.id)])
  for (const entry of ppv) {
    entry.ppv_kind = dmIds.has(entry.id) ? 'dm' : 'bundle'
    if (entry.ppv_kind === 'dm') entry.duration_s = Math.round(random.triangular(5, 9, 16) * 60)
  }
  const titles = createRandom('lora-bg-titles').shuffle(BG_TITLES)
  for (const [index, number] of BG_MASTERS.entries()) {
    const entry = entries.find((candidate) => candidate.id === formatItemId('ppv', number))
    if (!entry) continue
    entry.second_person = true
    entry.title = titles[index % titles.length] ?? entry.title
    entry.arrived_on = addDays('2025-03-01', random.int(0, 460))
    entry.shot_on = entry.arrived_on
  }
}

function shapeFyp(entries: CatalogEntry[]) {
  const random = createRandom('lora-fyp-steady')
  for (const number of STEADY_CONTENT) {
    const entry = entries.find((candidate) => candidate.id === formatItemId('fyp', number))
    if (!entry) continue
    entry.steady_content = true
    entry.duration_s = random.int(6, 48)
  }
}

function shapeCustoms(entries: CatalogEntry[]) {
  const random = createRandom('lora-customs')
  for (const number of PHOTO_CUSTOMS) {
    const entry = entries.find((candidate) => candidate.id === formatItemId('custom', number))
    if (!entry) continue
    entry.photo_custom = true
    entry.duration_s = null
    entry.photo_count = random.int(12, 30)
    entry.video_count = 0
  }
  for (const number of BG_CUSTOMS) {
    const entry = entries.find((candidate) => candidate.id === formatItemId('custom', number))
    if (entry) entry.second_person = true
  }
  const eligible = entries.filter(
    (entry) =>
      entry.type === 'custom' &&
      !entry.photo_custom &&
      !entry.second_person &&
      entry.id !== 'CUS-044' &&
      Number(entry.id.slice(4)) < 175,
  )
  const madeFrom = random.sample(eligible, 37)
  const ppvNumbers = random.sample(numberRange(24, 72, [32, 61, 67]), 37)
  madeFrom.forEach((entry, index) => {
    entry.ppv_made_as = formatItemId('ppv', ppvNumbers[index] ?? 24)
  })
}

function shapeSextings(entries: CatalogEntry[]) {
  for (const entry of entries) {
    if (entry.type !== 'sexting') continue
    const number = Number(entry.id.slice(4))
    if (number <= 12) entry.aliases = [`S${number}`]
  }
}

function shapePromo(entries: CatalogEntry[]) {
  for (const spec of LORA_COLLECTIONS) {
    const entry = entries.find((candidate) => candidate.id === collectionId(spec))
    if (!entry) continue
    entry.title = spec.title
    entry.channel = spec.channel
    entry.video_count = spec.videos
    entry.photo_count = spec.photos
    entry.size_bytes = spec.size_bytes
    entry.arrived_on = spec.added_on
    entry.shot_on = null
    entry.cover = { key: entry.id, ratio: spec.channel === 'youtube' ? '16:9' : '3:4' }
  }
}

function applyDetailed(entries: CatalogEntry[]) {
  for (const entry of entries) {
    const patch = DETAILED[entry.id]
    if (patch) Object.assign(entry, patch)
  }
}

export function buildLoraCatalog(): CatalogEntry[] {
  const entries = generateCatalog(LORA_CATALOG_PLAN)
  shapePpv(entries)
  shapeFyp(entries)
  shapeCustoms(entries)
  shapeSextings(entries)
  shapePromo(entries)
  applyDetailed(entries)
  return entries
}

/** IDs of the §9.3 table; tests check they are all present. */
export const LORA_DETAILED_IDS: readonly ItemId[] = Object.keys(DETAILED)
