import { randomUUID } from 'node:crypto'
import type { ItemId, ItemType } from '@contentops/contracts/domain/item-type'
import { type Db, withActorTx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { dbType } from '../catalog/ids'
import {
  type CreatedItem,
  createCatalogItems,
  FIXTURE_ACTOR,
  type FixtureFile,
  type FixtureItem,
  type FixtureLink,
  linkCatalogItems,
} from './catalog-factory'

/**
 * The full-volume catalog of Лора for the interface measurement (DESIGN §9.3, PLAN 4
 * «Скорость и плавность»): 1 391 objects with the type counts of the real library — PPV 90
 * (52 bundles, 38 in DM), FYP 796 (150 SteadyContent), customs 197 (5 photo customs, 38
 * already in PPV), sets 73, sextings 12, life 118, raw 83, promo 22 — fictional titles of
 * two to four Russian words, tags of the shared dictionary, and the placements that give
 * «Ещё не залито» its numbers of §9.3. Deterministic.
 *
 * Only for its own test database (`tools/perf/stack.mjs`), never for the pilot's base.
 */

function random(seed: string) {
  let state = [...seed].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 11)
  const next = () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1))
  return {
    next,
    int,
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T,
    chance: (share: number) => next() < share,
    shuffle: <T>(list: readonly T[]): T[] => {
      const copy = [...list]
      for (let i = copy.length - 1; i > 0; i--) {
        const j = int(0, i)
        ;[copy[i], copy[j]] = [copy[j] as T, copy[i] as T]
      }
      return copy
    },
  }
}

type Random = ReturnType<typeof random>

const OUTFITS = [
  'Чёрное кружево',
  'Белое кружево',
  'Красное платье',
  'Нейлон и каблуки',
  'Колготки',
  'Боди в сетку',
  'Шёлковая пижама',
  'Офисная юбка',
  'Джинсовые шорты',
  'Чулки',
  'Купальник',
  'Розовые стринги',
  'Леггинсы',
  'Белая рубашка',
  'Коричневое кружево',
  'Латекс',
]
const PLACES = [
  'у зеркала',
  'в отеле',
  'в спальне',
  'в душе',
  'на кухне',
  'на балконе',
  'на диване',
  'в ванной',
  'в офисе',
  'у окна',
]
const ACTIONS = ['примерка', 'стриптиз', 'танец', 'йога', 'игрушка', 'тизинг', 'масло', 'сквирт']
const LIFE_TITLES = [
  'Завтрак у окна',
  'Прогулка в парке',
  'Утро в постели',
  'Кофе на балконе',
  'Вечер с книгой',
  'Зал, тренировка',
  'Поездка за город',
  'Готовит ужин',
  'Сбор яблок',
  'Маникюр',
]
const ACTION_TAGS = ['teasing', 'striptease', 'dance', 'yoga', 'toy', 'try-on', 'shower', 'dildo']
const ATTRIBUTE_TAGS = [
  'lingerie',
  'stockings',
  'lace',
  'heels',
  'bodysuit',
  'thong',
  'nylon',
  'tights',
  'mirror',
  'bedroom',
  'hotel',
  'red',
  'black',
]
const MOOD_TAGS = ['tender', 'playful', 'bold', 'cozy', 'evening', 'sensual']
const SEGMENTS = ['приветствие', 'раздевается', 'крупно, бельё', 'у зеркала', 'игрушка', 'финал']

function title(rnd: Random): string {
  const outfit = rnd.pick(OUTFITS)
  const draw = rnd.next()
  if (draw < 0.4) return `${outfit} ${rnd.pick(PLACES)}`
  if (draw < 0.75) return `${outfit}, ${rnd.pick(ACTIONS)}`
  return outfit
}

function tags(rnd: Random): string[] {
  const list = new Set([rnd.pick(ACTION_TAGS), rnd.pick(ATTRIBUTE_TAGS), rnd.pick(ATTRIBUTE_TAGS)])
  if (rnd.chance(0.5)) list.add(rnd.pick(MOOD_TAGS))
  return [...list]
}

function confirmed(rnd: Random): FixtureItem['confirmed'] {
  const draw = rnd.next()
  if (draw < 0.55) return 'all'
  if (draw < 0.8) return ['title', 'tags']
  return []
}

/** Arrival spread over two years before «сегодня» of the prototype (22.09.2026). */
function arrived(share: number, rnd: Random): string {
  const end = Date.UTC(2026, 8, 22)
  const span = 730 * 86_400_000
  const day = Math.floor(end - span * (1 - share))
  return new Date(day + rnd.int(6, 18) * 3_600_000 + rnd.int(0, 59) * 60_000).toISOString()
}

const pics = (count: number): FixtureFile[] =>
  Array.from({ length: count }, () => ({ role: 'pic' }))
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)

/** Objects of §9.3's table by their titles; the rest are drawn. */
const NAMED: Partial<Record<ItemId, string>> = {
  'PPV-073': 'День рождения, торт, кружево',
  'PPV-074': 'Кристаллы и каблуки',
  'PPV-075': 'Коричневое кружево у зеркала',
  'PPV-076': 'Нейлон и каблуки',
  'PPV-061': 'Стиральная машина',
  'PPV-032': 'Молоко',
  'PPV-081': 'Хэллоуин',
  'PPV-082': 'Коричневый сет',
  'PPV-067': 'Мерцание, тизинг',
  'CUS-197': 'Босс',
  'CUS-195': 'Танец живота',
  'CUS-181': 'Нейлон и каблуки',
  'CUS-190': 'Уборка',
  'CUS-188': 'Пов от девушки',
  'CUS-186': 'Колготки',
  'CUS-184': 'Йога с пробкой',
  'SET-074': 'Чтение книги, стринги',
  'SET-069': 'Отель, красное платье у зеркала',
  'SET-073': 'После душа',
  'SXT-012': 'Чулки, каблуки',
  'SXT-005': 'Розовые стринги',
  'FYP-0801': 'Зеркало, чёрное боди',
  'FYP-0797': 'Нейлон, офис',
  'FYP-0802': 'Йога в леггинсах',
  'FYP-0412': 'Йога у зеркала',
  'LIFE-191': 'Завтрак у окна',
  'LIFE-141': 'Сбор яблок',
  'RAW-0214': 'Съёмка 21 сентября',
  'RAW-0034': 'Съёмка 6 августа',
}

function named(id: ItemId, rnd: Random, draw: (rnd: Random) => string): string {
  return NAMED[id] ?? draw(rnd)
}

function raws(rnd: Random): FixtureItem[] {
  return [34, ...range(133, 214)].map((number, index, all) => {
    const files = rnd.int(4, 20)
    const videos = rnd.int(1, files)
    return {
      type: 'raw',
      number,
      title: named(`RAW-${String(number).padStart(4, '0')}` as ItemId, rnd, () => 'Съёмка'),
      rawPurpose: rnd.pick(['fyp', 'ppv', 'mass_dm', 'unknown'] as const),
      createdAt: arrived(index / all.length, rnd),
      files: Array.from({ length: files }, (_, file) => ({
        role: 'raw' as const,
        media: file < videos ? ('video' as const) : ('image' as const),
        durationS: file < videos ? rnd.int(8, 90) : undefined,
      })),
    }
  })
}

/** PPV 1–90: 52 bundles and 38 in DM; PPV-067 without photos (chip «Без фото»). */
function ppvs(rnd: Random): FixtureItem[] {
  const dm = new Set(rnd.shuffle(range(1, 90).filter((n) => n !== 73 && n !== 74)).slice(0, 37))
  dm.add(75)
  return range(1, 90).map((number) => {
    const id = `PPV-${String(number).padStart(3, '0')}` as ItemId
    const showcase = number === 73
    const durationS = showcase ? 804 : rnd.int(4, 18) * 60 + rnd.int(0, 59)
    const photos = showcase ? 21 : number === 74 ? 2 : number === 67 ? 0 : rnd.int(0, 24)
    return {
      type: 'ppv',
      number,
      title: named(id, rnd, title),
      titleEn: rnd.chance(0.4) ? 'birthday-lace' : null,
      description: rnd.chance(0.5) ? 'Медленно раздевается, потом на кровати.' : null,
      ppvKind: dm.has(number) ? 'dm' : 'bundle',
      tags: tags(rnd),
      confirmed: confirmed(rnd),
      createdAt: arrived(number / 90, rnd),
      platformTexts: rnd.chance(0.5)
        ? { wall: 'Something special for you', message: 'Wanna see the rest?' }
        : undefined,
      aliases: [
        ...(number === 81 || number === 82
          ? [{ kind: 'legacy_id' as const, value: 'PPV-032' }]
          : []),
        ...(number === 67 ? [{ kind: 'legacy_name' as const, value: '[PPV-066]_shimmer' }] : []),
        ...(number === 61 ? [{ kind: 'legacy_name' as const, value: 'used2' }] : []),
      ],
      files: [
        {
          role: 'master',
          durationS,
          versions: showcase || rnd.chance(0.12) ? 2 : 1,
          chronology: rnd.chance(0.5)
            ? SEGMENTS.map((text, index) => ({ atS: Math.floor((durationS / 6) * index), text }))
            : undefined,
        },
        ...(showcase || rnd.chance(0.85) ? [{ role: 'teaser' as const, durationS: 32 }] : []),
        ...pics(photos),
      ],
    }
  })
}

/** Customs 1–197: CUS-160 and four more are photo customs. */
function customs(rnd: Random): FixtureItem[] {
  const photo = new Set([160, 92, 117, 133, 151])
  return range(1, 197).map((number) => ({
    type: 'custom',
    number,
    title: named(`CUS-${String(number).padStart(3, '0')}` as ItemId, rnd, title),
    nameInMedia: rnd.pick(['yes', 'no', 'unknown'] as const),
    tags: tags(rnd),
    confirmed: confirmed(rnd),
    createdAt: arrived(number / 197, rnd),
    files: photo.has(number)
      ? pics(number === 160 ? 38 : rnd.int(6, 20))
      : [{ role: 'master', durationS: rnd.int(3, 18) * 60, versions: rnd.chance(0.1) ? 2 : 1 }],
  }))
}

/** FYP 10–805, 150 of them SteadyContent; every third has versions for Fansly 2 and 3. */
function fyps(rnd: Random): FixtureItem[] {
  const steady = new Set(rnd.shuffle(range(10, 805)).slice(0, 150))
  return range(10, 805).map((number, index) => ({
    type: 'fyp',
    number,
    title: named(
      `FYP-${String(number).padStart(4, '0')}` as ItemId,
      rnd,
      (r) => `${r.pick(OUTFITS)}, ${r.pick(ACTIONS)}`,
    ),
    tags: steady.has(number) ? [...tags(rnd), 'steadycontent'] : tags(rnd),
    confirmed: confirmed(rnd),
    createdAt: arrived(index / 796, rnd),
    files: [
      { role: 'master', durationS: rnd.int(6, 15), width: 1080, height: 1920 },
      ...(index % 3 === 0 || number === 801
        ? [
            { role: 'master' as const, variant: 1, uniqLevel: 'soft' as const, durationS: 9 },
            { role: 'master' as const, variant: 2, uniqLevel: 'trim' as const, durationS: 8 },
          ]
        : []),
    ],
  }))
}

/** Sets 2–74. */
function sets(rnd: Random): FixtureItem[] {
  return range(2, 74).map((number) => {
    const frames = number === 74 ? 46 : rnd.int(14, 40)
    const picked = number === 74 ? 21 : Math.round(frames * 0.45)
    return {
      type: 'set',
      number,
      title: named(`SET-${String(number).padStart(3, '0')}` as ItemId, rnd, title),
      tags: tags(rnd),
      confirmed: confirmed(rnd),
      createdAt: arrived(number / 74, rnd),
      files: [
        ...Array.from({ length: frames }, (_, frame) => ({
          role: 'raw' as const,
          selected: frame < picked,
        })),
        ...Array.from({ length: number === 74 ? 8 : rnd.int(0, 8) }, (_, frame) => ({
          role: 'ed' as const,
          ordinal: frame + 1,
        })),
      ],
    }
  })
}

function sextings(rnd: Random): FixtureItem[] {
  return range(1, 12).map((number) => ({
    type: 'sexting',
    number,
    title: named(`SXT-${String(number).padStart(3, '0')}` as ItemId, rnd, title),
    tags: tags(rnd),
    confirmed: confirmed(rnd),
    createdAt: arrived(number / 12, rnd),
    aliases:
      number === 12 ? [{ kind: 'vault_album' as const, value: '🖤S12 - Чулки, каблуки' }] : [],
    files: [
      ...pics(rnd.int(20, 36)),
      ...Array.from({ length: rnd.int(4, 8) }, () => ({ role: 'clip' as const, durationS: 25 })),
    ],
  }))
}

/** Life 74–191: every one has frames «в чаты», so it belongs to «Ещё не залито» of Fansly. */
function lifes(rnd: Random): FixtureItem[] {
  return range(74, 191).map((number) => ({
    type: 'life',
    number,
    title: named(`LIFE-${String(number).padStart(3, '0')}` as ItemId, rnd, (r) =>
      r.pick(LIFE_TITLES),
    ),
    tags: [rnd.pick(['cozy', 'tender', 'playful', 'homey'])],
    confirmed: confirmed(rnd),
    createdAt: arrived((number - 73) / 118, rnd),
    files: [
      { role: 'pic' as const, lifeUse: 'chats' as const },
      ...Array.from({ length: number === 191 ? 15 : rnd.int(3, 15) }, (_, frame) => ({
        role: 'pic' as const,
        lifeUse:
          number === 191 && frame < 4 ? null : rnd.pick(['feed', 'chats', 'both', null] as const),
      })),
      ...(rnd.chance(0.3) ? [{ role: 'clip' as const, durationS: 14 }] : []),
    ],
  }))
}

const PROMO_TITLES: Record<number, [string, string, number]> = {
  11: ['gif-sites', 'Гиф-сайты, пак 1', 60],
  12: ['twitter', 'Twitter, июнь', 12],
  13: ['reddit', 'Reddit, сентябрь', 20],
  14: ['reddit', 'Reddit, август', 18],
  15: ['instagram', 'КП2 офис нейлон', 60],
  16: ['gif-sites', 'Гиф-сайты, пак 2', 100],
}

/** Collections 1–22: links to FYP montages of the same call, never copies. */
function promos(rnd: Random): FixtureItem[] {
  const channels = ['instagram', 'reddit', 'twitter', 'gif-sites', 'sfs']
  return range(1, 22).map((number) => {
    const [channel, label, count] = PROMO_TITLES[number] ?? [
      rnd.pick(channels),
      `${rnd.pick(OUTFITS)}, подборка`,
      rnd.int(5, 30),
    ]
    const start = rnd.int(10, 805 - count)
    return {
      type: 'promo',
      number,
      title: label,
      promoChannel: channel,
      createdAt: arrived(number / 22, rnd),
      references: range(start, start + count - 1).map((fyp) => ({
        item: `FYP-${String(fyp).padStart(4, '0')}` as ItemId,
        handle: 'master',
      })),
    }
  })
}

/** 38 customs already turned into PPV; PPV-076 ← CUS-181 among them. */
function links(rnd: Random): FixtureLink[] {
  const customsUsed = rnd.shuffle(range(1, 180).filter((n) => n !== 160)).slice(0, 37)
  const ppvsUsed = rnd.shuffle(range(1, 90).filter((n) => n !== 76)).slice(0, 37)
  return [
    { child: 'PPV-076', parent: 'CUS-181', relation: 'ppv_from_custom' },
    { child: 'PPV-073', parent: 'RAW-0034', relation: 'montage_from' },
    ...customsUsed.map(
      (custom, index): FixtureLink => ({
        child: `PPV-${String(ppvsUsed[index]).padStart(3, '0')}` as ItemId,
        parent: `CUS-${String(custom).padStart(3, '0')}` as ItemId,
        relation: 'ppv_from_custom',
      }),
    ),
  ]
}

export function fullCatalogItems(model: string): FixtureItem[] {
  const rnd = random(`${model}:full`)
  return [
    ...raws(rnd),
    ...ppvs(rnd),
    ...customs(rnd),
    ...fyps(rnd),
    ...sets(rnd),
    ...sextings(rnd),
    ...lifes(rnd),
    ...promos(rnd),
  ]
}

/**
 * «Ещё не залито» of §9.3 by page and type: how many objects stay without a placement. The
 * rest gets a confirmed placement on the page's surface (a set on the wall, a FYP in FYP,
 * PPV, sextings and life in the vault).
 */
const NOT_UPLOADED: Record<string, Partial<Record<ItemType, number>>> = {
  'lora-1': { ppv: 6, set: 11, life: 9, sexting: 0, fyp: 512 },
  'lora-2': { ppv: 4, set: 14, life: 12, sexting: 0, fyp: 488 },
  'lora-3': { ppv: 5, set: 14, life: 12, sexting: 0, fyp: 491 },
  'lora-vip-of': { ppv: 21, set: 30, sexting: 7 },
  'lora-of': { ppv: 38, set: 41, sexting: 12 },
}

const SURFACE: Partial<Record<ItemType, string>> = {
  ppv: 'vault',
  sexting: 'vault',
  life: 'vault',
  set: 'wall',
  fyp: 'fyp',
}

async function placeCatalog(db: Db, model: string, created: readonly CreatedItem[]) {
  const rnd = random(`${model}:placements`)
  let count = 0
  await withActorTx(
    db,
    { actor: FIXTURE_ACTOR, action: 'fixtures.seed', requestId: randomUUID() },
    async (tx) => {
      const { rows: surfaces } = await tx.execute<{
        model_id: string
        account_id: string
        surface_id: string
        account: string
        kind: string
      }>(sql`
        SELECT s.model_id, s.account_id, s.id AS surface_id, a.code AS account, s.kind
          FROM surfaces s
          JOIN accounts a ON a.model_id = s.model_id AND a.id = s.account_id
          JOIN models m ON m.id = s.model_id
         WHERE m.code = ${model}`)
      const { rows: people } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM principals WHERE kind = 'person' ORDER BY created_at LIMIT 1`)
      const by = people[0]?.id ?? null
      for (const [account, plan] of Object.entries(NOT_UPLOADED)) {
        for (const [type, left] of Object.entries(plan) as [ItemType, number][]) {
          const surface = surfaces.find(
            (candidate) => candidate.account === account && candidate.kind === SURFACE[type],
          )
          if (!surface) throw new Error(`perf catalog: ${account} has no ${SURFACE[type]}`)
          const items = rnd.shuffle(created.filter((item) => item.type === type))
          for (const item of items.slice(0, Math.max(0, items.length - left))) {
            const at = arrived(0.3 + rnd.next() * 0.7, rnd)
            const views =
              type === 'fyp' && rnd.chance(0.6) ? rnd.int(800, 60_000) : (null as number | null)
            const { rows } = await tx.execute<{ id: string }>(sql`
              INSERT INTO placements (model_id, account_id, surface_id, occurrence_kind, manual_key,
                                      item_id, item_type, occurred_at, event_precision,
                                      occurred_source, surface_source, origin, views, stats_at,
                                      created_by)
              VALUES (${surface.model_id}::uuid, ${surface.account_id}::uuid,
                      ${surface.surface_id}::uuid, 'manual', ${`perf:${randomUUID()}`},
                      ${item.uid}::uuid, ${dbType(type)},
                      ${at}::timestamptz, 'day', 'km', 'km', 'manual', ${views},
                      ${views === null ? null : at}::timestamptz, ${by}::uuid)
              RETURNING id`)
            await tx.execute(sql`
              INSERT INTO placement_evidence (model_id, placement_id, source, kind, strength,
                                              payload, event_at, recorded_by, dedup_key)
              VALUES (${surface.model_id}::uuid, ${rows[0]?.id}::uuid, 'manual', 'manual_confirm',
                      'exact', ${JSON.stringify({ basis: 'execution_report' })}::jsonb,
                      ${at}::timestamptz, ${by}::uuid, ${`perf:${randomUUID()}`})`)
            count++
          }
        }
      }
    },
  )
  return count
}

export interface FullSeedResult {
  created: number
  placements: number
  skipped: boolean
}

/** Fills an empty model with the full-volume catalog; a model with objects is left as it is. */
export async function seedFullCatalog(
  db: Db,
  model: string,
  options: { media?: (items: readonly FixtureItem[]) => FixtureItem[] } = {},
): Promise<FullSeedResult> {
  const { rows } = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM content_items i JOIN models m ON m.id = i.model_id
     WHERE m.code = ${model}`)
  if ((rows[0]?.count ?? 0) > 0) return { created: 0, placements: 0, skipped: true }
  const items = fullCatalogItems(model)
  const created = await createCatalogItems(db, model, options.media ? options.media(items) : items)
  await linkCatalogItems(db, model, links(random(`${model}:links`)))
  const placements = await placeCatalog(db, model, created)
  await withActorTx(
    db,
    { actor: FIXTURE_ACTOR, action: 'fixtures.seed', requestId: randomUUID() },
    (tx) =>
      tx.execute(sql`
        UPDATE id_counters SET legacy_reserved_at = now()
         WHERE legacy_reserved_at IS NULL
           AND model_id = (SELECT id FROM models WHERE code = ${model})`),
  )
  return { created: created.length, placements, skipped: false }
}
