import type { CatalogEntry, PpvKind } from './domain/catalog'
import type { ItemId, ItemType } from './domain/item-type'
import { normalizeQuery, parseIdQuery } from './resolve'

/**
 * One reading of a search query for every place that searches (DESIGN §4.7): the top
 * search with its suggestions, the results page, the server and the pickers in dialogs.
 *
 * - an ID in any form (`ппв 73`, `[PPV-073]`, `лайф 191`) is the object itself and the
 *   folders that had this number;
 * - type words become a type filter: «кастом в колготках» — customs with «колготк…»,
 *   «последние сексты» — all sextings, newest first;
 * - chatter words become a kind filter: «лонг ппв» — PPV in DMs;
 * - the other words match by stem or word start: «кружева» finds «кружево», «в чёрном
 *   белье» finds the tag «чёрное» and the title «Бельё, примерка», «колг» — «колготки».
 */
export interface SearchQuery {
  id: ItemId | null
  type: ItemType | null
  ppvKind: PpvKind | null
  /** Word stems; each must start some word of the object. */
  stems: readonly string[]
}

/** Where the words were found: the lower, the higher in the list (DESIGN §4.7). */
export const SEARCH_RANK = {
  /** The ID itself or an old number. */
  id: 0,
  /** ID, title, album names. */
  title: 1,
  tags: 2,
  /** Description, old names and paths: the server part. */
  extra: 3,
} as const
export type SearchRank = (typeof SEARCH_RANK)[keyof typeof SEARCH_RANK]

const NOUN_ENDINGS = ['', 'а', 'у', 'е', 'ы', 'и', 'ов', 'ам', 'ами', 'ах', 'ом'] as const

function forms(stems: readonly string[], endings: readonly string[] = NOUN_ENDINGS): string[] {
  return stems.flatMap((stem) => endings.map((ending) => stem + ending))
}

/** «кастом», «кастомы», «кастомов»… → type; `ё` is already `е`. */
const TYPE_BY_WORD = new Map<string, ItemType>([
  ...forms(['ppv', 'ппв', 'пвп'], ['']).map((word) => [word, 'ppv'] as const),
  ...forms(['fyp', 'фуп', 'фап']).map((word) => [word, 'fyp'] as const),
  ...forms(['cus', 'кас'], ['']).map((word) => [word, 'custom'] as const),
  ...forms(['кастом']).map((word) => [word, 'custom'] as const),
  ...forms(['set'], ['', 's']).map((word) => [word, 'set'] as const),
  ...forms(['сет']).map((word) => [word, 'set'] as const),
  ...forms(['sxt'], ['']).map((word) => [word, 'sexting'] as const),
  ...forms(['секст', 'секстинг']).map((word) => [word, 'sexting'] as const),
  ...forms(['life'], ['']).map((word) => [word, 'life'] as const),
  ...forms(['лайф']).map((word) => [word, 'life'] as const),
  ...forms(['raw'], ['']).map((word) => [word, 'raw'] as const),
  ...forms(['сырье', 'сырья', 'съемка', 'съемки', 'съемок'], ['']).map(
    (word) => [word, 'raw'] as const,
  ),
  ...forms(['prm', 'промо'], ['']).map((word) => [word, 'promo'] as const),
  ...forms(['подборк'], ['а', 'и', 'у', 'е', 'ой', 'ам', 'ах']).map(
    (word) => [word, 'promo'] as const,
  ),
])

/** Chatter words for the PPV kind: «лонг ппв» — in DMs, «бандлы» — for the wall. */
const PPV_KIND_BY_WORD = new Map<string, PpvKind>([
  ...[...forms(['лонг']), 'long', 'longs', 'личку', 'личка', 'лс', 'dm'].map(
    (word) => [word, 'dm'] as const,
  ),
  ...[...forms(['бандл']), 'bundle', 'bundles'].map((word) => [word, 'bundle'] as const),
])

/** Prepositions and chatter filler: they never narrow the search. */
const STOP_WORDS = new Set([
  'в',
  'во',
  'на',
  'и',
  'с',
  'со',
  'у',
  'по',
  'из',
  'для',
  'к',
  'ко',
  'о',
  'об',
  'от',
  'до',
  'за',
  'под',
  'при',
  'без',
  'а',
  'но',
  'или',
  'где',
  'что',
  'все',
  'это',
  'этом',
  'этот',
  'эти',
  'есть',
  'нет',
  'нету',
  'последние',
  'последний',
  'последних',
  'новые',
  'новых',
  'свежие',
])

/** Inflection endings, longest first; the stem keeps at least three letters. */
const ENDINGS = [
  'иями',
  'ями',
  'ами',
  'ого',
  'его',
  'ому',
  'ему',
  'ыми',
  'ими',
  'ая',
  'яя',
  'ое',
  'ее',
  'ые',
  'ие',
  'ый',
  'ий',
  'ой',
  'ей',
  'ую',
  'юю',
  'ом',
  'ем',
  'ам',
  'ям',
  'ах',
  'ях',
  'ов',
  'ев',
  'а',
  'я',
  'о',
  'е',
  'ы',
  'и',
  'у',
  'ю',
  'й',
] as const
const MIN_STEM = 3

/** «колготках» → «колготк», «чёрном» → «черн», «белье» → «бель», «анал» — as is. */
export function stemOf(word: string): string {
  if (!/^[а-я]+$/.test(word)) return word
  for (const ending of ENDINGS) {
    if (word.endsWith(ending) && word.length - ending.length >= MIN_STEM) {
      return word.slice(0, -ending.length)
    }
  }
  return word
}

/** Words of a text in the search form: lower case, `ё` as `е`, split at any sign. */
export function searchTokens(...parts: readonly string[]): string[] {
  return normalizeQuery(parts.join(' '))
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
}

export function parseSearchQuery(query: string): SearchQuery {
  const id = parseIdQuery(query)
  if (id) return { id, type: null, ppvKind: null, stems: [] }
  let type: ItemType | null = null
  let ppvKind: PpvKind | null = null
  const stems: string[] = []
  for (const word of searchTokens(query)) {
    const kind = PPV_KIND_BY_WORD.get(word)
    const wordType = TYPE_BY_WORD.get(word)
    if (kind) {
      ppvKind = kind
      type = 'ppv'
    } else if (wordType) {
      type = ppvKind ? 'ppv' : wordType
    } else if (!STOP_WORDS.has(word) && word.length > 1) {
      stems.push(stemOf(word))
    }
  }
  return { id: null, type, ppvKind, stems }
}

/** Nothing to look for: an empty query or only prepositions. */
export function isBlankSearch(query: SearchQuery): boolean {
  return !query.id && !query.type && !query.ppvKind && query.stems.length === 0
}

/** Words of one object, split by weight (§4.7: ID and title above tags). */
export interface SearchHaystack {
  title: readonly string[]
  tags: readonly string[]
  extra: readonly string[]
}

/**
 * Haystack of a catalog entry. `tagName` gives the Russian tag name; `extra` is what
 * only the server has: description, old names and paths.
 */
export function entryHaystack(
  entry: Pick<CatalogEntry, 'id' | 'title' | 'aliases' | 'tags'>,
  tagName: (key: string) => string,
  extra: readonly string[] = [],
): SearchHaystack {
  return {
    title: searchTokens(entry.id, entry.title, ...entry.aliases),
    tags: searchTokens(...entry.tags.map(tagName)),
    extra: searchTokens(...extra),
  }
}

const withoutLeadingZeros = (word: string) => word.replace(/^0+(?=\d)/, '')

/** «колготк» starts «колготки»; «73» starts «073» — numbers ignore leading zeros. */
export function stemMatches(stem: string, words: readonly string[]): boolean {
  if (/^\d+$/.test(stem)) {
    const number = withoutLeadingZeros(stem)
    return words.some((word) => withoutLeadingZeros(word).startsWith(number))
  }
  return words.some((word) => word.startsWith(stem))
}

function stemRank(stem: string, haystack: SearchHaystack): SearchRank | null {
  if (stemMatches(stem, haystack.title)) return SEARCH_RANK.title
  if (stemMatches(stem, haystack.tags)) return SEARCH_RANK.tags
  if (stemMatches(stem, haystack.extra)) return SEARCH_RANK.extra
  return null
}

/** Whether the object passes the type and kind the words asked for. */
export function passesSearchFilters(
  query: SearchQuery,
  entry: Pick<CatalogEntry, 'type' | 'ppv_kind'>,
): boolean {
  if (query.type && entry.type !== query.type) return false
  if (query.ppvKind && entry.ppv_kind !== query.ppvKind) return false
  return true
}

/** How well the object answers the query; `null` — it does not. */
export function searchRank(
  query: SearchQuery,
  entry: Pick<CatalogEntry, 'id' | 'type' | 'ppv_kind' | 'aliases'>,
  haystack: SearchHaystack,
): SearchRank | null {
  if (query.id) {
    return entry.id === query.id || entry.aliases.includes(query.id) ? SEARCH_RANK.id : null
  }
  if (isBlankSearch(query) || !passesSearchFilters(query, entry)) return null
  let rank: SearchRank = SEARCH_RANK.title
  for (const stem of query.stems) {
    const found = stemRank(stem, haystack)
    if (found === null) return null
    rank = Math.max(rank, found) as SearchRank
  }
  return rank
}

/** Order of found objects: by rank, inside a rank newest first. */
export function compareSearchHits(
  left: { rank: number; entry: Pick<CatalogEntry, 'id' | 'arrived_on'> },
  right: { rank: number; entry: Pick<CatalogEntry, 'id' | 'arrived_on'> },
): number {
  return (
    left.rank - right.rank ||
    right.entry.arrived_on.localeCompare(left.entry.arrived_on) ||
    right.entry.id.localeCompare(left.entry.id)
  )
}

/**
 * A timeline segment answers the query when one of its words is in the label and the
 * rest are in the label or the object: «анал кастом» → «CUS-181 · 04:10 — анал».
 */
export function timelineMatches(
  query: SearchQuery,
  label: string,
  haystack: SearchHaystack,
): boolean {
  if (query.id || query.stems.length === 0) return false
  const words = searchTokens(label)
  const inLabel = query.stems.filter((stem) => stemMatches(stem, words))
  return (
    inLabel.length > 0 &&
    query.stems.every((stem) => inLabel.includes(stem) || stemRank(stem, haystack) !== null)
  )
}

/** A draft in «Приехало» answers when every word is in its title. */
export function titleMatches(query: SearchQuery, title: string): boolean {
  if (query.id || query.stems.length === 0) return false
  const words = searchTokens(title)
  return query.stems.every((stem) => stemMatches(stem, words))
}
