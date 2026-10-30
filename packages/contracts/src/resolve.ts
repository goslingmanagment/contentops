import type { ItemId, ItemType } from './domain/item-type'
import { formatItemId } from './domain/item-type'
import type { ResolveResult } from './domain/search'

/**
 * Understanding a search query before full-text search (DESIGN §4.7): IDs in any form
 * (`ппв 73`, `PPV 73`, `[PPV-073]`, `cus183`, `#cus183`, `фуп 412`, `съёмка 34`),
 * chatter words (`s5`, `S12`, «секст 5») and section names («план», «заказы»).
 */

const TYPE_WORDS: readonly [RegExp, ItemType][] = [
  [/^(ppv|ппв|пвп)$/, 'ppv'],
  [/^(fyp|фуп|фап)$/, 'fyp'],
  [/^(cus|кастом|кас)$/, 'custom'],
  [/^(set|сет)$/, 'set'],
  [/^(sxt|s|секст|секстинг|сексты)$/, 'sexting'],
  [/^(life|лайф)$/, 'life'],
  [/^(raw|сырьё|сырье|съёмка|съемка)$/, 'raw'],
  [/^(prm|промо)$/, 'promo'],
]

const SECTION_WORDS: readonly [RegExp, NonNullable<ResolveResult['section']>][] = [
  [/^(приехало|новое|приёмка|приемка)$/, 'inbox'],
  [/^(библиотека|каталог)$/, 'library'],
  [/^(план|задачи)$/, 'plan'],
  [/^(сверить|сверка)$/, 'check'],
  [/^(заказы|заказ)$/, 'orders'],
  [/^промо$/, 'promo'],
  [/^(журнал|история)$/, 'journal'],
]

/** Lower case, `ё` as `е`, single spaces. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ')
}

function typeOfWord(word: string): ItemType | null {
  const normalized = word.replaceAll('ё', 'е')
  for (const [pattern, type] of TYPE_WORDS) {
    if (pattern.test(word) || pattern.test(normalized)) return type
  }
  return null
}

/** `ппв 73` → `PPV-073`; `null` when the query is not an ID. */
export function parseIdQuery(query: string): ItemId | null {
  const match = /^#?\[?\s*([a-zа-яё]+)[\s_-]*(\d{1,6})\s*\]?$/iu.exec(query.trim().toLowerCase())
  if (!match) return null
  const type = typeOfWord(match[1] ?? '')
  const number = Number(match[2])
  if (!type || number < 1) return null
  return formatItemId(type, number)
}

export function sectionOfQuery(query: string): ResolveResult['section'] {
  const normalized = normalizeQuery(query)
  for (const [pattern, section] of SECTION_WORDS) if (pattern.test(normalized)) return section
  return null
}
