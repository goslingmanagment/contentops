/**
 * Which order an old custom was delivered for (SPEC §6.3, §8.2; PLAN этап 7). Before the import
 * of customs the agent makes orders from the old cards in Telegram and keeps the model's lines
 * under each card («12:40 гимнастика») as delivery messages of the order; this rule links an old custom
 * of the disk to one of those orders, or leaves the choice to a person. A wrong link puts a fan's
 * video under another fan's order, so a link needs evidence of identity that one order alone has:
 *
 * - the model's line under the card is the name of the file or folder (legacy §9.2 «точное
 *   совпадение строки модели с именем файла»);
 * - or the buyer's name or nick is in the name, and no other open custom names him or carries
 *   the line of that order.
 *
 * Words of the name found in the brief make an order a candidate, never a link by themselves;
 * so do the duration and the date (SPEC §8.2: «совпадений только по длительности и близкой дате
 * недостаточно»). What rules an order out: a custom shorter than the ordered duration by more
 * than 10 % (legacy §9.2: длительность односторонне), a file that came before the card, a part
 * the order does not want. Several candidates, or one without identity — ◆ «Какой заказ?» for a
 * person; none — the custom stays without an order (no stub orders).
 */

export interface CustomFacts {
  /** As the model named it: the file without its extension, or the folder. */
  name: string
  /** Seconds of the video: its probe, else `MM:SS` at the start of the name. */
  durationS: number | null
  /** When it appeared in the source (`remote_created_at`). */
  at: string | null
  video: boolean
  photos: number
}

export interface OrderLine {
  /** The model's line as Telegram has it: «12:40 гимнастика». */
  text: string
  /** `tg:<chat>/<topic>/<message>` of the message. */
  ref: string
}

export interface OrderFacts {
  id: string
  buyer: string | null
  brief: string
  /** The card verbatim, when the order keeps it: the buyer's link and «Имя:» are there. */
  cardText: string | null
  cardAt: string
  minS: number | null
  durationRaw: string | null
  wantsVideo: boolean
  wantsPhotos: number
  lines: readonly OrderLine[]
}

export type Identity = 'line' | 'buyer'

export interface Candidate {
  order: OrderFacts
  /** In words, as «Какой заказ?» and the delivery show them. */
  signals: string[]
  identity: Identity | null
  /** The line that matched (`tg:…`), kept with the delivery. */
  evidence: string[]
  /** `tg:…` of the model's line that is this custom's name. */
  lineRef: string | null
}

/**
 * `acrossAlphabets` — words of the name match words of the brief written in the other alphabet
 * too («го хард» and «go hard»): the models name files in Russian, fans write the brief in
 * English. The intake of new customs asks so; the import keeps its own rule.
 */
export interface MatchOptions {
  acrossAlphabets?: boolean
}

export type Decision =
  | { kind: 'link'; candidate: Candidate }
  | { kind: 'ask'; candidates: Candidate[] }
  | { kind: 'none' }

const TIME_HEAD = /^(\d{1,2})[:.-](\d{2})(?!\d)/u

/** Lower case, `ё` → `е`, no Markdown stars, `13-03` → `13:03`, single spaces. */
export function normalName(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/\*\*|__|`/gu, '')
    .replace(/[_\s]+/gu, ' ')
    .trim()
    .replace(TIME_HEAD, '$1:$2')
}

/** `12:40 гимнастика` → 760 s; no time at the start — `null`. */
export function headSeconds(name: string): number | null {
  const match = TIME_HEAD.exec(normalName(name))
  if (!match) return null
  const seconds = Number(match[2])
  return seconds < 60 ? Number(match[1]) * 60 + seconds : null
}

function words(text: string): string[] {
  return normalName(text)
    .replace(TIME_HEAD, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

const CYRILLIC: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'i',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
}

/**
 * A name in either alphabet reduced to the same letters: «Глеб» and «Gleb» are `gleb`,
 * «Джордан» and «Jordan» are `jordan`. Only for comparing names, never shown.
 */
export function skeleton(word: string): string {
  return [...normalName(word)]
    .map((char) => CYRILLIC[char] ?? char)
    .join('')
    .replace(/dzh/gu, 'j')
    .replace(/zh/gu, 'j')
    .replace(/kh/gu, 'h')
    .replace(/ph/gu, 'f')
    .replace(/ck/gu, 'k')
    .replace(/[cq]/gu, 'k')
    .replace(/x/gu, 'ks')
    .replace(/w/gu, 'v')
    .replace(/y/gu, 'i')
    .replace(/[^a-z0-9]/gu, '')
    .replace(/(.)\1+/gu, '$1')
}

/** Parts of links and cards that name nobody. */
const NOT_A_NAME = new Set([
  'fansly',
  'onlyfans',
  'com',
  'posts',
  'https',
  'http',
  'www',
  'fan',
  'fans',
  'fani',
  'free',
  'vip',
  'sub',
  'tip',
])

const HANDLE = /(?:fansly\.com|onlyfans\.com)\/([\p{L}\p{N}_.-]+)/giu
const NAME_LINE = /^[\s*]*(?:имя(?:\s+фана)?|name)[\s*]*[:：][\s*]*(.+)$/gimu

/** The buyer's names and nicks: the field, the nicks of the links and «Имя:» of the card. */
export function buyerNames(order: Pick<OrderFacts, 'buyer' | 'cardText'>): string[] {
  const texts = [order.buyer ?? '']
  for (const text of [order.buyer ?? '', order.cardText ?? '']) {
    for (const match of text.matchAll(HANDLE)) texts.push(match[1] ?? '')
    for (const match of text.matchAll(NAME_LINE)) texts.push(match[1] ?? '')
  }
  const out = new Set<string>()
  for (const text of texts) {
    for (const word of text.split(/[^\p{L}\p{N}_]+/u)) {
      const key = skeleton(word.replace(/_/gu, ''))
      if (key.length < 3 || NOT_A_NAME.has(key) || /^(u|user)?\d+$/u.test(key)) continue
      out.add(key)
    }
  }
  return [...out]
}

/** Two names are one when equal, or one begins the other and the shorter has 5 letters. */
function sameName(a: string, b: string): boolean {
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= 5 && long.startsWith(short)
}

/** Words of a name that say nothing about the order. */
const COMMON = new Set([
  'кастом',
  'кастомы',
  'видео',
  'фото',
  'custom',
  'video',
  'photo',
  'минут',
  'минуты',
  'минута',
  'тизер',
  'тизеры',
  'часть',
  'финал',
  'версия',
  'новое',
  'новый',
  'исправленное',
  'исправленный',
  'переделка',
  'кадры',
  'дубль',
])

/** Two words of one stem: «зелёном» and «зелёное», «шпагат» and «ШПАГАТ», «платье» and «платьем». */
function sameStem(a: string, b: string): boolean {
  const short = Math.min(a.length, b.length)
  if (short < 4) return false
  let common = 0
  while (common < short && a[common] === b[common]) common += 1
  return common >= Math.min(5, short)
}

/** Words of the name found in the brief, when they are at least half of its meaningful words. */
export function briefWords(name: string, brief: string, options: MatchOptions = {}): string[] {
  const own = [...new Set(words(name))].filter(
    (word) => word.length >= 4 && !COMMON.has(word) && /\p{L}/u.test(word),
  )
  if (own.length === 0) return []
  const theirs = words(brief).filter((word) => word.length >= 4)
  const same = (word: string, other: string) =>
    sameStem(word, other) ||
    (options.acrossAlphabets === true && sameStem(skeleton(word), skeleton(other)))
  const found = own.filter((word) => theirs.some((other) => same(word, other)))
  return found.length * 2 >= own.length ? found : []
}

const TIME_ANY = /(?<![\d:])\d{1,2}[:.-]\d{2}(?!\d)/u
const NAMED = /назвал[аи]?\s*[-—–:]+\s*/iu

/**
 * What a message of the model calls a file: each of its lines, and the part after «назвала —»
 * («Загрузила на диск, назвала - 6:15 в синем»).
 */
function lineNames(line: string): string[] {
  const out = new Set<string>()
  for (const part of line.split('\n')) {
    const text = part.trim()
    if (!text) continue
    out.add(normalName(text))
    const named = NAMED.exec(text)
    if (named) out.add(normalName(text.slice(named.index + named[0].length)))
  }
  return [...out]
}

/** A name that can stand for one file: with a time in it, or of two words and more. */
function distinctive(own: string): boolean {
  return own.length >= 5 && (TIME_ANY.test(own) || own.split(' ').length >= 2)
}

/** The name is a line of the model's message, or such a line begins with it and goes on. */
export function sameLine(name: string, line: string): boolean {
  const own = normalName(name)
  if (!distinctive(own)) return false
  return lineNames(line).some(
    (said) => said === own || (said.startsWith(own) && /[\s,.;:(—-]/u.test(said[own.length] ?? '')),
  )
}

const DAY_MS = 86_400_000

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`
}

/** Why the order cannot be this custom's, or `null`. */
function ruledOut(custom: CustomFacts, order: OrderFacts): string | null {
  if (custom.video && !order.wantsVideo && custom.photos === 0) return 'видео не заказано'
  if (!custom.video && custom.photos > 0 && order.wantsPhotos === 0) return 'фото не заказаны'
  if (custom.video && custom.durationS !== null && order.minS !== null) {
    if (custom.durationS < order.minS * 0.9) return 'короче заказанного'
  }
  if (custom.at && Date.parse(custom.at) < Date.parse(order.cardAt) - DAY_MS) {
    return 'раньше карточки'
  }
  return null
}

/** The orders this custom may belong to, each with what matched. */
export function candidatesOf(
  custom: CustomFacts,
  orders: readonly OrderFacts[],
  options: MatchOptions = {},
): Candidate[] {
  const out: Candidate[] = []
  const nameKeys = words(custom.name).map(skeleton)
  for (const order of orders) {
    if (ruledOut(custom, order)) continue
    const signals: string[] = []
    const evidence: string[] = []
    let identity: Identity | null = null
    const line = order.lines.find((one) => sameLine(custom.name, one.text))
    if (line) {
      identity = 'line'
      signals.push(`строка модели «${line.text.trim()}»`)
      evidence.push(line.ref)
    }
    const buyer = buyerNames(order).find((key) => nameKeys.some((own) => sameName(own, key)))
    if (buyer) {
      identity = identity ?? 'buyer'
      const shown = words(custom.name).find((word) => sameName(skeleton(word), buyer)) ?? buyer
      signals.push(`покупатель в имени: «${shown}»`)
    }
    const brief = briefWords(custom.name, order.brief, options)
    if (brief.length > 0) signals.push(`в ТЗ: ${brief.map((word) => `«${word}»`).join(', ')}`)
    if (signals.length === 0) continue
    if (custom.video && custom.durationS !== null && order.durationRaw) {
      signals.push(`${clock(custom.durationS)} при заказанных «${order.durationRaw}»`)
    }
    if (custom.at) {
      const days = Math.max(
        0,
        Math.round((Date.parse(custom.at) - Date.parse(order.cardAt)) / DAY_MS),
      )
      signals.push(`через ${days} дн. после карточки`)
    }
    out.push({ order, signals, identity, evidence, lineRef: line?.ref ?? null })
  }
  return out
}

/**
 * The rule: one candidate with identity — the link, unless another open custom has the same
 * claim on that order: the same line of the model (two files of one name), or — for a buyer
 * alone — any identity (a second clip, a fix, another order of the same fan without a card).
 * Anything else with candidates is a question; no candidates — no order.
 */
export function decide(
  custom: CustomFacts,
  orders: readonly OrderFacts[],
  others: readonly CustomFacts[],
  options: MatchOptions = {},
): Decision {
  const candidates = candidatesOf(custom, orders, options)
  if (candidates.length === 0) return { kind: 'none' }
  const [only] = candidates
  if (candidates.length > 1 || !only || only.identity === null) return { kind: 'ask', candidates }
  const rival = others.some(
    (other) =>
      other !== custom &&
      candidatesOf(other, [only.order], options).some((candidate) =>
        only.identity === 'line'
          ? candidate.lineRef !== null && normalName(other.name) === normalName(custom.name)
          : candidate.identity !== null,
      ),
  )
  return rival ? { kind: 'ask', candidates } : { kind: 'link', candidate: only }
}
