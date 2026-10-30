import { randomUUID } from 'node:crypto'
import type { ItemId } from '@contentops/contracts/domain/item-type'
import { type Db, withActorTx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import {
  createCatalogItems,
  FIXTURE_ACTOR,
  type FixtureFile,
  type FixtureItem,
  type FixtureLink,
  linkCatalogItems,
  tombstoneCatalogItem,
} from './catalog-factory'

/**
 * A believable catalog of one model for the screens and the test runs in the pilot VM before
 * stage 3 (PLAN 2а): all eight types, about a hundred objects with fictional titles, tags of
 * the shared dictionary, confirmed and draft markup, chronology, old numbers, provenance and
 * one deleted object. Deterministic: the same model gets the same catalog.
 */

function random(seed: string) {
  let state = [...seed].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7)
  const next = () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T,
    chance: (share: number) => next() < share,
  }
}

const OUTFITS = [
  'Красное платье',
  'Чёрное кружево',
  'Белая рубашка',
  'Колготки и каблуки',
  'Боди в сеточку',
  'Шёлковая пижама',
  'Офисная юбка',
  'Джинсовые шорты',
  'Нейлон и чулки',
  'Купальник',
]
const PLACES = ['зеркало', 'отель', 'спальня', 'душ', 'кухня', 'балкон', 'диван', 'ванная', 'офис']
const ACTIONS = ['примерка', 'стриптиз', 'танец', 'йога', 'игрушка', 'дразнит', 'масло', 'сквирт']
const LIFE_TITLES = [
  'Завтрак у окна',
  'Прогулка в парке',
  'Утро в постели',
  'Кофе на балконе',
  'Вечер с книгой',
  'Зал, тренировка',
  'Поездка за город',
  'Готовит ужин',
]
const ACTION_TAGS = ['teasing', 'striptease', 'dance', 'yoga', 'toy', 'try-on', 'shower', 'dildo']
const ATTRIBUTE_TAGS = [
  'stockings',
  'lace',
  'heels',
  'bodysuit',
  'nylon',
  'tights',
  'mirror',
  'bedroom',
  'hotel',
  'red',
  'black',
  'lingerie',
]
const MOOD_TAGS = ['tender', 'playful', 'bold', 'cozy', 'evening', 'sensual']
const EN_WORDS = ['red-dress', 'lace', 'mirror-tease', 'stockings', 'shower', 'try-on', 'yoga']
const SEGMENTS = [
  'приветствие, разговор',
  'медленно раздевается',
  'крупно, бельё',
  'у зеркала',
  'игрушка',
  'на кровати',
  'финал, улыбка',
]

type Random = ReturnType<typeof random>

function title(rnd: Random): string {
  return `${rnd.pick(OUTFITS)}, ${rnd.pick(PLACES)}, ${rnd.pick(ACTIONS)}`
}

function tags(rnd: Random): string[] {
  const list = new Set([rnd.pick(ACTION_TAGS), rnd.pick(ATTRIBUTE_TAGS), rnd.pick(ATTRIBUTE_TAGS)])
  if (rnd.chance(0.5)) list.add(rnd.pick(MOOD_TAGS))
  return [...list]
}

function confirmed(rnd: Random): FixtureItem['confirmed'] {
  const draw = rnd.next()
  if (draw < 0.45) return 'all'
  if (draw < 0.7) return ['title', 'tags']
  return []
}

function chronology(rnd: Random, durationS: number) {
  const count = rnd.int(3, 6)
  const step = Math.floor(durationS / count)
  return Array.from({ length: count }, (_, index) => ({
    atS: index * step,
    text: SEGMENTS[(index + rnd.int(0, 2)) % SEGMENTS.length] ?? 'кадр',
  }))
}

function pics(count: number, role: 'pic' | 'raw' = 'pic'): FixtureFile[] {
  return Array.from({ length: count }, () => ({ role }))
}

/** `2026-08-01` + days, at a believable hour in Moscow. */
function arrived(day: number, rnd: Random): string {
  const date = new Date(Date.UTC(2026, 7, 1 + day, rnd.int(6, 18), rnd.int(0, 59)))
  return date.toISOString()
}

function ppvs(rnd: Random): FixtureItem[] {
  return Array.from({ length: 26 }, (_, index) => {
    const number = 60 + index
    const durationS = rnd.int(4, 14) * 60 + rnd.int(0, 59)
    const showcase = number === 73
    return {
      type: 'ppv',
      number,
      title: showcase ? 'Вечеринка, блёстки, диван' : title(rnd),
      titleEn: showcase || rnd.chance(0.4) ? rnd.pick(EN_WORDS) : null,
      description: rnd.chance(0.5) || showcase ? 'Танцует в блёстках, потом на диване.' : null,
      ppvKind: rnd.chance(0.6) ? 'bundle' : 'dm',
      tags: showcase ? ['dance', 'lingerie', 'playful'] : tags(rnd),
      confirmed: showcase ? ['title', 'tags'] : confirmed(rnd),
      createdAt: arrived(index * 3, rnd),
      shotOn: arrived(index * 3 - 2, rnd).slice(0, 10),
      platformTexts:
        showcase || rnd.chance(0.4)
          ? { wall: 'Glitter party just for you', message: 'Wanna see how the party ended?' }
          : undefined,
      aliases: [
        ...(number === 66 || number === 71
          ? [{ kind: 'legacy_id' as const, value: 'PPV-032' }]
          : []),
        ...(number === 62 ? [{ kind: 'legacy_id' as const, value: 'PPV-012' }] : []),
        { kind: 'legacy_path', value: `1. PPV/[PPV-0${number}]_${rnd.pick(EN_WORDS)}` },
      ],
      files: [
        {
          role: 'master',
          durationS,
          versions: rnd.chance(0.12) ? 2 : 1,
          chronology: showcase || rnd.chance(0.5) ? chronology(rnd, durationS) : undefined,
        },
        ...(showcase || rnd.chance(0.85) ? [{ role: 'teaser' as const, durationS: 32 }] : []),
        ...pics(showcase ? 8 : rnd.chance(0.6) ? rnd.int(4, 12) : 0),
      ],
    }
  })
}

function customs(rnd: Random): FixtureItem[] {
  return Array.from({ length: 12 }, (_, index) => {
    const photo = index === 4
    return {
      type: 'custom',
      number: 170 + index,
      title: rnd.pick(['нейлон и каблуки', 'в душе, медленно', 'офис, юбка', 'йога в трико']),
      nameInMedia: rnd.pick(['yes', 'no', 'unknown'] as const),
      tags: tags(rnd),
      confirmed: confirmed(rnd),
      createdAt: arrived(index * 6 + 1, rnd),
      files: photo
        ? pics(rnd.int(6, 14))
        : [{ role: 'master', durationS: rnd.int(3, 12) * 60, versions: rnd.chance(0.15) ? 2 : 1 }],
    }
  })
}

function fyps(rnd: Random): FixtureItem[] {
  return Array.from({ length: 18 }, (_, index) => ({
    type: 'fyp',
    number: 401 + index,
    title: `${rnd.pick(OUTFITS)}, ${rnd.pick(ACTIONS)}`,
    tags: index % 6 === 0 ? [...tags(rnd), 'steadycontent'] : tags(rnd),
    confirmed: confirmed(rnd),
    createdAt: arrived(index * 4 + 2, rnd),
    files: [
      { role: 'master', durationS: rnd.int(6, 12), width: 1080, height: 1920 },
      ...(index % 3 === 0
        ? [
            { role: 'master' as const, variant: 1, uniqLevel: 'soft' as const, durationS: 9 },
            { role: 'master' as const, variant: 2, uniqLevel: 'trim' as const, durationS: 8 },
          ]
        : []),
    ],
  }))
}

function sets(rnd: Random): FixtureItem[] {
  return Array.from({ length: 12 }, (_, index) => {
    const frames = rnd.int(14, 30)
    const picked = Math.round(frames * 0.4)
    return {
      type: 'set',
      number: 60 + index,
      title: `${rnd.pick(OUTFITS)}, ${rnd.pick(PLACES)}`,
      tags: tags(rnd),
      confirmed: confirmed(rnd),
      createdAt: arrived(index * 7 + 3, rnd),
      files: [
        ...Array.from({ length: frames }, (_, frame) => ({
          role: 'raw' as const,
          selected: frame < picked,
        })),
        ...Array.from({ length: rnd.int(0, 4) }, (_, frame) => ({
          role: 'ed' as const,
          ordinal: frame + 1,
        })),
      ],
    }
  })
}

function sextings(rnd: Random): FixtureItem[] {
  return Array.from({ length: 6 }, (_, index) => ({
    type: 'sexting',
    number: 1 + index,
    title: `${rnd.pick(OUTFITS)}, переписка`,
    tags: tags(rnd),
    confirmed: confirmed(rnd),
    createdAt: arrived(index * 12 + 5, rnd),
    files: [
      ...pics(rnd.int(20, 36)),
      ...Array.from({ length: rnd.int(4, 8) }, () => ({ role: 'clip' as const, durationS: 25 })),
    ],
  }))
}

function lifes(rnd: Random): FixtureItem[] {
  return Array.from({ length: 12 }, (_, index) => ({
    type: 'life',
    number: 180 + index,
    title: rnd.pick(LIFE_TITLES),
    tags: [rnd.pick(['cozy', 'tender', 'playful'])],
    confirmed: confirmed(rnd),
    createdAt: arrived(index * 6 + 4, rnd),
    files: [
      ...Array.from({ length: rnd.int(4, 12) }, () => ({
        role: 'pic' as const,
        lifeUse: rnd.pick(['feed', 'chats', 'both', null] as const),
      })),
      ...(rnd.chance(0.3) ? [{ role: 'clip' as const, durationS: 14 }] : []),
    ],
  }))
}

function raws(rnd: Random): FixtureItem[] {
  return Array.from({ length: 10 }, (_, index) => {
    const day = index * 8
    const files = rnd.int(3, 12)
    const videos = rnd.int(1, files)
    return {
      type: 'raw',
      number: 30 + index,
      title: `Съёмка ${arrived(day, rnd).slice(8, 10)}.${arrived(day, rnd).slice(5, 7)}`,
      rawPurpose: rnd.pick(['fyp', 'ppv', 'mass_dm', 'unknown'] as const),
      createdAt: arrived(day, rnd),
      shotOn: arrived(day, rnd).slice(0, 10),
      files: Array.from({ length: files }, (_, file) => ({
        role: 'raw' as const,
        media: file < videos ? ('video' as const) : ('image' as const),
        durationS: file < videos ? rnd.int(8, 40) : undefined,
      })),
    }
  })
}

function promos(rnd: Random): FixtureItem[] {
  const channels = ['reddit', 'instagram', 'twitter', 'reddit']
  return channels.map((channel, index) => ({
    type: 'promo',
    number: 1 + index,
    title: `Подборка ${rnd.pick(['лето', 'бельё', 'танцы', 'зеркало'])}`,
    promoChannel: channel,
    createdAt: arrived(60 + index * 5, rnd),
    references: [
      { item: `PPV-0${62 + index * 3}` as ItemId, handle: 'master' },
      { item: `FYP-04${String(1 + index * 2).padStart(2, '0')}` as ItemId, handle: 'master' },
    ],
  }))
}

const LINKS: readonly FixtureLink[] = [
  { child: 'PPV-078', parent: 'CUS-175', relation: 'ppv_from_custom' },
  { child: 'FYP-0401', parent: 'RAW-0030', relation: 'montage_from' },
  { child: 'FYP-0402', parent: 'RAW-0030', relation: 'montage_from' },
  { child: 'FYP-0405', parent: 'RAW-0032', relation: 'montage_from', suggested: true },
  { child: 'PPV-073', parent: 'RAW-0033', relation: 'montage_from' },
  { child: 'SET-064', parent: 'RAW-0034', relation: 'extracted_from' },
]

export interface SeedResult {
  created: number
  skipped: boolean
}

/** Fills the model's catalog once; a model that already has objects is left as it is. */
export async function seedCatalog(
  db: Db,
  model: string,
  options: {
    /** Real bytes for the files (`media-seed.ts`); random hashes without bytes otherwise. */
    media?: (items: readonly FixtureItem[]) => FixtureItem[]
  } = {},
): Promise<SeedResult> {
  const { rows } = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM content_items i JOIN models m ON m.id = i.model_id
     WHERE m.code = ${model}`)
  if ((rows[0]?.count ?? 0) > 0) return { created: 0, skipped: true }
  const rnd = random(model)
  const items = [
    ...raws(rnd),
    ...ppvs(rnd),
    ...customs(rnd),
    ...fyps(rnd),
    ...sets(rnd),
    ...sextings(rnd),
    ...lifes(rnd),
    ...promos(rnd),
  ]
  const created = await createCatalogItems(db, model, options.media ? options.media(items) : items)
  await linkCatalogItems(db, model, LINKS)
  await tombstoneCatalogItem(db, model, 'LIFE-186')
  // No legacy in a fictional catalog: the counters issue new numbers right away (a type
  // change or a split in the dev stand), unlike a real model before stage 3.
  await withActorTx(
    db,
    { actor: FIXTURE_ACTOR, action: 'fixtures.seed', requestId: randomUUID() },
    (tx) =>
      tx.execute(sql`
        UPDATE id_counters SET legacy_reserved_at = now()
         WHERE legacy_reserved_at IS NULL
           AND model_id = (SELECT id FROM models WHERE code = ${model})`),
  )
  return { created: created.length, skipped: false }
}
