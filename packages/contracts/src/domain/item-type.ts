import { z } from 'zod'

/** Eight catalog types in the order people are used to (DESIGN §0). */
export const ITEM_TYPES = [
  'ppv',
  'fyp',
  'custom',
  'set',
  'sexting',
  'life',
  'raw',
  'promo',
] as const
export const ItemTypeSchema = z.enum(ITEM_TYPES)
export type ItemType = z.infer<typeof ItemTypeSchema>

interface ItemTypeInfo {
  /** ID prefix from naming: `PPV-073`, `FYP-0801`. */
  prefix: string
  digits: number
  /** Folder name in the Library. */
  folder: string
  /** Word inside a sentence: «фуп», «кастом». */
  noun: string
  /** Route segment: `#/lora/library/customs`. */
  slug: string
}

export const ITEM_TYPE_INFO: Record<ItemType, ItemTypeInfo> = {
  ppv: { prefix: 'PPV', digits: 3, folder: 'PPV', noun: 'PPV', slug: 'ppv' },
  fyp: { prefix: 'FYP', digits: 4, folder: 'FYP', noun: 'фуп', slug: 'fyp' },
  custom: { prefix: 'CUS', digits: 3, folder: 'Кастомы', noun: 'кастом', slug: 'customs' },
  set: { prefix: 'SET', digits: 3, folder: 'Сеты', noun: 'сет', slug: 'sets' },
  sexting: { prefix: 'SXT', digits: 3, folder: 'Секстинги', noun: 'секстинг', slug: 'sextings' },
  life: { prefix: 'LIFE', digits: 3, folder: 'Лайф', noun: 'лайф', slug: 'life' },
  raw: { prefix: 'RAW', digits: 4, folder: 'Сырьё', noun: 'сырьё', slug: 'raw' },
  promo: { prefix: 'PRM', digits: 3, folder: 'Промо', noun: 'подборка', slug: 'promo' },
}

/** `PPV-073`, `FYP-0801`, `LIFE-141`. */
export const ITEM_ID_PATTERN = /^(PPV|FYP|CUS|SET|SXT|LIFE|RAW|PRM)-\d{3,4}$/
export const ItemIdSchema = z.string().regex(ITEM_ID_PATTERN)
export type ItemId = z.infer<typeof ItemIdSchema>

const TYPE_BY_PREFIX = new Map<string, ItemType>(
  ITEM_TYPES.map((type) => [ITEM_TYPE_INFO[type].prefix, type]),
)

export function formatItemId(type: ItemType, number: number): ItemId {
  const info = ITEM_TYPE_INFO[type]
  return `${info.prefix}-${String(number).padStart(info.digits, '0')}`
}

export function parseItemId(id: string): { type: ItemType; number: number } | null {
  const match = /^([A-Z]+)-(\d+)$/.exec(id)
  if (!match) return null
  const type = TYPE_BY_PREFIX.get(match[1] ?? '')
  if (!type) return null
  const digits = match[2] ?? ''
  if (digits.length !== ITEM_TYPE_INFO[type].digits) return null
  return { type, number: Number(digits) }
}

export function itemTypeOf(id: ItemId): ItemType {
  const parsed = parseItemId(id)
  if (!parsed) throw new Error(`Не ID объекта: ${id}`)
  return parsed.type
}

export function itemTypeBySlug(slug: string): ItemType | null {
  return ITEM_TYPES.find((type) => ITEM_TYPE_INFO[type].slug === slug) ?? null
}
