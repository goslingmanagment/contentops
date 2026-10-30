import { dayMonthYear, MONTH_WORD, makeDate, monthOf, yearDate } from './dates.ts'
import { claimKey, hasLetter, languageOf, PARSER_VERSION, splitExtension } from './text.ts'
import {
  ACCOUNT_RULE,
  type ClaimKind,
  type ItemTypeCode,
  type LegacyArea,
  type LegacyClaim,
  type LegacyDate,
  type ProposedAccount,
  type UsagePayload,
} from './types.ts'

/**
 * One name of the old disk → claims (SPEC §6.3, legacy §8). The name is scanned by rules in a
 * fixed order; every rule consumes the characters it understood. What is left becomes the
 * title (words), an ordinal (a number at the edge) or an `unknown` claim with the raw
 * fragment — nothing is dropped silently.
 */

interface Draft {
  kind: ClaimKind
  start: number
  raw: string
  payload: unknown
}

const CONSUMED = '\uE000'

class Scanner {
  readonly text: string
  private readonly used: boolean[]
  readonly drafts: Draft[] = []

  constructor(text: string) {
    this.text = text
    this.used = Array.from({ length: text.length }, () => false)
  }

  masked(): string {
    let out = ''
    for (let i = 0; i < this.text.length; i++) out += this.used[i] ? CONSUMED : this.text[i]
    return out
  }

  consume(start: number, end: number): void {
    for (let i = start; i < end; i++) this.used[i] = true
  }

  claim(kind: ClaimKind, start: number, end: number, payload: unknown): void {
    this.drafts.push({ kind, start, raw: this.text.slice(start, end), payload })
  }

  /**
   * Runs a global pattern over the unconsumed text. The handler returns `false` to leave the
   * match alone; anything else consumes it.
   */
  take(pattern: RegExp, handler: (m: RegExpExecArray) => boolean | undefined): void {
    if (!pattern.global) throw new Error(`pattern must be global: ${pattern.source}`)
    const masked = this.masked()
    pattern.lastIndex = 0
    const matches: RegExpExecArray[] = []
    for (let m = pattern.exec(masked); m !== null; m = pattern.exec(masked)) {
      if (m[0] === '') {
        pattern.lastIndex++
        continue
      }
      matches.push(m)
    }
    for (const m of matches) {
      const start = m.index
      const end = start + m[0].length
      if (this.isUsed(start, end)) continue
      if (handler(m) !== false) this.consume(start, end)
    }
  }

  isUsed(start: number, end: number): boolean {
    for (let i = start; i < end; i++) if (this.used[i]) return true
    return false
  }

  /** Unconsumed runs with their offsets. */
  spans(): { start: number; text: string }[] {
    const out: { start: number; text: string }[] = []
    let start = -1
    for (let i = 0; i <= this.text.length; i++) {
      const free = i < this.text.length && !this.used[i]
      if (free && start < 0) start = i
      if (!free && start >= 0) {
        out.push({ start, text: this.text.slice(start, i) })
        start = -1
      }
    }
    return out
  }
}

// ── Patterns ────────────────────────────────────────────────────────────────────────────

const TYPE_CODES = '(PPV|SET|SXT|CUS|CST|FYP|LIFE|RAW|PRM)'
const BRACKET_ID = new RegExp(`\\[\\s*${TYPE_CODES}\\s*[-_ ]?\\s*(\\d{1,6})\\s*\\]`, 'giu')
const LOOSE_ID = new RegExp(
  `(?<![\\p{L}\\d])${TYPE_CODES}[\\s_-]?(\\d{1,6})(?![\\p{L}\\d.,:])`,
  'giu',
)

const CAPCUT = /lv_0_(\d{14})/giu
const IOS_COPY = /copy_[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/giu
const UUID =
  /(?<![0-9A-F])[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}(?![0-9A-F])/giu
const CONTRACTOR_EXPORT = new RegExp(
  `^${MONTH_WORD}_(?:photo|video)_(\\d{1,4})_(?:[a-z0-9]+_)*[0-9a-f]{8,12}$`,
  'iu',
)
/** `5400000000000000001.jpg`, `1000100001.jpg` — ids of a messenger or an Android gallery. */
const LONG_NUMBER = /^\d{7,20}(?:\s*\(\d{1,2}\))?$/u
const MESSENGER_PHOTO = /(?:photo|video)_(\d{4})-(\d{2})-(\d{2})_\d{2}-\d{2}-\d{2}/giu
const SCREENSHOT =
  /(?:Снимок экрана|Screenshot|Screen Shot)\s*(\d{4})-(\d{2})-(\d{2})(?:\s*(?:в|at)\s*\d{1,2}[.:]\d{2}[.:]\d{2})?/giu
const TIMESTAMP_NAME = /(?<!\d)(\d{4})-(\d{2})-(\d{2})[ _](\d{2})[.\-:](\d{2})[.\-:](\d{2})(?!\d)/gu
const RECOVERED = /^\$R[0-9A-Z]{5,7}$/u
const CAMERA =
  /(IMG_E?\d{3,5}|DSC[_F]?\d{3,5}|MVI_\d{3,5}|VID_\d{3,8}|PMR\d{3,6})(?:\s*\(\d{1,2}\))*(?:\s+\d{1,2}(?![\d.:]))?(?:\s*[—-]\s*копия)?/giu
const DUPLICATE_SUFFIX = /\s*\(\d{1,2}\)(?=\s*$)/gu

const NON_USED = /non[\s_]?used/giu
const USAGE_STEM = /(\d)?\s?(used|ued|usd|posted)/giu

const DATE_CORE = '(\\d{1,2})(?:\\.\\.|[.,])(\\d{1,2})(?:[.,](20\\d{2}|\\d{2}))?'
/** A date ends at a non-digit, or runs into a clock (`3.10.2510:41`) or a label (`11.091used`). */
const DATE_END = '(?=$|[^\\d]|\\d{1,2}:\\d{2}|\\d\\s?(?:used|ued|usd))'
const K_DATE = new RegExp(`(\\d{1,2})_[_.\\s]*${DATE_CORE}${DATE_END}`, 'y')
const DATE_ONLY = new RegExp(`${DATE_CORE}${DATE_END}`, 'y')
const GLUED_K_DATE = new RegExp(
  `(\\d)(\\d{2})[.,](\\d{1,2})(?:[.,](20\\d{2}|\\d{2}))?${DATE_END}`,
  'y',
)
const UNDERSCORE_DATE = /(\d{1,2})_(\d{1,2})[.,](\d{2})(?!\d)/y
const K_ONLY = /(\d{1,2})_?(?=$|\)|\uE000)/y
const USAGE_N = /_?(\d{1,2})(?![\d:.,])/y
const USAGE_ALL = /_?all(?![a-zа-я])/iy
const POSTED_ALL_LIFE = /_?al(?=life)|_?all(?=life)/iy

const FYP_BATCH = [
  /FYP_(\d{1,2})_(\d{1,2})[.,](\d{1,2})[.,](\d{2,4})(?:_(\d{1,2})(?!\d))?/gu,
  /FYP_(\d{1,2})[.,](\d{1,2})[.,](\d{2,4})_(\d{1,2})(?!\d)/gu,
  /FYP_(\d{1,2})_(\d{1,2})[.,](\d{1,2})(?![\d.,])/gu,
]
const SEXTING_NUMBER = /sexting\s*_\s*(\d{1,3})(?!\d)/giu
const OLD_FORMAT_NUMBER = /(?<=^[\s_\uE000()]*)(\d{3})(?=[\s_]|$)/gu

const NOT_SET = /X\.X\.X|(?<=_)X$/gu
const DATE_RANGE = new RegExp(`(?<![\\d.,])${DATE_CORE}\\s*-\\s*${DATE_CORE}(?![\\d])`, 'gu')
const ISO_DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/gu
const UNDERSCORE_FULL_DATE = /(?<!\d)(\d{2})_(\d{2})_(\d{2})(?!\d)/gu
const DATE = new RegExp(`(?<![\\d.,])${DATE_CORE}${DATE_END}`, 'gu')
const MONTH_YEAR = new RegExp(
  `(?<![\\p{L}])(${MONTH_WORD})\\s*(20\\d{2}|\\d{2}(?!\\d))?(?![\\p{L}])`,
  'giu',
)
const YEAR_MONTH_GLUED =
  /(?<![\p{L}\d])(\d{2})(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?![\p{L}])/giu
const YEAR_ONLY = /(?<![\d.,])(20\d{2})(?![\d.,])/gu

const CLOCK = /(?<![\d:.])(\d{1,2}):(\d{2})(?::(\d{2}))?(?![\d:])/gu
const MINUTES =
  /(?<![\d.,])(\d{1,3})(?:[.,](\d{1,2}))?\s*_?\s*(минут[аы]?|мин|minutes?|mins?)(?![\p{L}])/giu
const COUNT = /(?<![\d])(\d{1,4})\s*(шт|фото|видео|videos|photos)(?![\p{L}])/giu
const FOLDER_COUNT = /\(\s*(\d{1,4})\s*\)\s*$/gu

const PREFIX_MARKER =
  /(?<=^[\uE000_\s()]*)(set|life|custom|ppv|sexting|bundles|bundle|bndl|fyp)(?=[_\s\uE000)]|$)/giu
const CUSTOM_FAN = /кастом_([\p{L}][\p{L}\d.]*)/giu
const CUSTOM_WORD = /(?<![\p{L}])кастом(?![\p{L}])/giu
const ROLE_WORD =
  /(?<![\p{L}])(\d{1,2})?[\s_-]?(promo|промо|тизер|teaser|preview|prewiew|превью)[\s_]?(\d{1,2})?(?![\p{L}])/giu
const FULL = /^full(\d{0,2})$/iu
const LEADING_ORDINAL = /^(\d{1,3})(?=[\s_(]+\p{L})/gu
const TRAILING_ORDINAL = /(?<=\p{L}[\s_])(\d{1,3})$/gu
const ORDINAL_FYP = /^(\d{1,3})fyp$/iu
const BG_WORD = /(?<![\p{L}])(BG|bg)(?![\p{L}])/gu

/** Whole names of structural folders: no claims, nothing unknown. */
const STRUCTURAL = [
  /^\d+\.\s*(PPV|FYP|Customs|Sets|Sextings|Life|Pictures|Other|SMM)$/iu,
  /^Старый формат$/iu,
  /^New Folder( With Items)?$/iu,
  /^Новая папка$/iu,
  /^отобранное на PPV$/iu,
  /^Под рассылки$/iu,
  /^Gif сайты$/iu,
  /^(Twitter|Instagram|REDDIT|Reddit|SFS|YT|TikTok|Флешинги)$/iu,
]
const FOLDER_ROLE: readonly [RegExp, 'ed' | 'raw'][] = [
  [/^(ed|отобрано|отобранное)$/iu, 'ed'],
  [/^(original|originals|оригиналы|оригинал|исходники|исходник)$/iu, 'raw'],
]
const TAG_FOLDER = /^(optional|extra|нюды)$/iu
const VENDOR = /^SteadyContent$/iu

/** Words that carry no information alone: a span made only of them is understood. */
const NOISE = new Set([
  'photos',
  'photo',
  'videos',
  'video',
  'vids',
  'vid',
  'pics',
  'pic',
  'фото',
  'видео',
  'mp4',
  'mov',
  'archive',
  'sets',
  'set',
  'копия',
  'реддит',
  'twitter',
  'instagram',
  'reddit',
  'gif',
  'сайты',
  'и',
])

// ── Usage labels ────────────────────────────────────────────────────────────────────────

function accountOf(label: string): ProposedAccount {
  const n = /^used(\d+)$/.exec(label)
  if (n) return { kind: 'index', index: Number(n[1]) }
  if (label === 'used_all' || label === 'posted_all') return { kind: 'all' }
  if (label === 'posted') return { kind: 'index', index: 1 }
  return { kind: 'unknown' }
}

function usage(label: string, postOfDay: number | null, date: LegacyDate | null, notes: string[]) {
  const payload: UsagePayload = {
    label,
    account: accountOf(label),
    account_rule: ACCOUNT_RULE,
    post_of_day: postOfDay,
    date,
    notes,
  }
  return payload
}

function sticky(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at
  return pattern.exec(text)
}

const dateOf = (m: RegExpExecArray, i: number) => dayMonthYear(m[i] ?? '', m[i + 1] ?? '', m[i + 2])

/**
 * `used3_04.08.26`, `2used_15.07`, `used1_1_28.07`, `used_all_124.08`, `posted_all_3.10.25`,
 * `(used2)(used3)`, `usd2_1_27,09`… One pass, left to right, so `…25used3` cannot take the
 * year digit as a prefix.
 */
function scanUsage(s: Scanner): void {
  const text = s.masked()
  USAGE_STEM.lastIndex = 0
  // End of the previous label: `12.091used` — the digit after its date is this label's prefix.
  let previousEnd = -1
  for (let m = USAGE_STEM.exec(text); m !== null; m = USAGE_STEM.exec(text)) {
    let start = m.index
    let prefix = m[1] ? Number(m[1]) : null
    const stem = (m[2] ?? '').toLowerCase()
    const stemStart = m.index + m[0].length - stem.length
    if (prefix !== null) {
      const before = text[start - 1] ?? ''
      const afterLabel = start === previousEnd
      if ((/[\d.,]/.test(before) && !afterLabel) || stem === 'posted') {
        prefix = null
        start = stemStart
      }
    }
    const letterBefore = /\p{L}/u.test(text[stemStart - 1] ?? '')
    let at = stemStart + stem.length
    const notes: string[] = []
    if (stem === 'ued' || stem === 'usd') notes.push('typo')
    if (prefix !== null) notes.push('prefix')
    let label: string
    if (stem === 'posted') {
      const life = sticky(POSTED_ALL_LIFE, text, at)
      const all = life ?? sticky(USAGE_ALL, text, at)
      label = all ? 'posted_all' : 'posted'
      if (all) at += all[0].length
    } else {
      const n = prefix === null ? sticky(USAGE_N, text, at) : null
      if (n) at += n[0].length
      const all = sticky(USAGE_ALL, text, at)
      if (all) at += all[0].length
      const number = prefix ?? (n ? Number(n[1]) : null)
      if (all) label = number === null ? 'used_all' : `used${number}_all`
      else label = number === null ? 'used' : `used${number}`
      // `orionUSED1` is a label glued to a nick; a bare `used` after letters is a word.
      if (letterBefore && number === null && !all) {
        USAGE_STEM.lastIndex = at
        continue
      }
    }
    let post: number | null = null
    let date: LegacyDate | null = null
    const sep = /[_\s.]*/y
    sep.lastIndex = at
    const afterSep = at + (sep.exec(text)?.[0].length ?? 0)
    const kDate = sticky(K_DATE, text, afterSep)
    const kDateValue = kDate ? dateOf(kDate, 2) : null
    const plain = kDateValue ? null : sticky(DATE_ONLY, text, afterSep)
    const plainValue = plain ? dateOf(plain, 1) : null
    const glued = kDateValue || plainValue ? null : sticky(GLUED_K_DATE, text, afterSep)
    const gluedValue = glued ? dateOf(glued, 2) : null
    const typo =
      kDateValue || plainValue || gluedValue ? null : sticky(UNDERSCORE_DATE, text, afterSep)
    const typoValue = typo ? dayMonthYear(typo[1] ?? '', typo[2] ?? '', typo[3]) : null
    if (kDate && kDateValue) {
      post = Number(kDate[1])
      date = kDateValue
      at = afterSep + kDate[0].length
    } else if (plain && plainValue) {
      date = plainValue
      at = afterSep + plain[0].length
    } else if (glued && gluedValue) {
      post = Number(glued[1])
      date = gluedValue
      notes.push('glued')
      at = afterSep + glued[0].length
    } else if (typo && typoValue) {
      date = typoValue
      notes.push('date_typo')
      at = afterSep + typo[0].length
    } else {
      const k = sticky(K_ONLY, text, afterSep)
      if (k && Number(k[1]) <= 20) {
        post = Number(k[1])
        at = afterSep + (k[1] ?? '').length
      }
    }
    const kind = stem === 'posted' ? 'posted' : 'used'
    s.claim(kind, start, at, usage(label, post, date, notes))
    s.consume(start, at)
    previousEnd = at
    USAGE_STEM.lastIndex = at
  }
}

// ── Leftovers ───────────────────────────────────────────────────────────────────────────

const EDGE = /^[\s_\-–—.,()[\]\uE000]+|[\s_\-–—.,()[\]\uE000]+$/gu

function cleanTitle(text: string): string {
  return text
    .replaceAll('_', ' ')
    .replace(/\s+-\s+|\s+—\s+/g, ' ')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isJunkWord(word: string): boolean {
  return /^[a-z]{1,3}$/.test(word)
}

function leftovers(s: Scanner, ordinalAllowed: boolean): void {
  // `all`, `ife` between usage labels are debris; in other names a short word is a title.
  const usageName = s.drafts.some((d) => d.kind === 'used' || d.kind === 'posted')
  const spans = s
    .spans()
    .map((span) => {
      const lead = /^[\s_\-–—.,()[\]]*/u.exec(span.text)?.[0].length ?? 0
      return { start: span.start + lead, text: span.text.replace(EDGE, '') }
    })
    .filter((span) => span.text !== '')
  const titles: { start: number; text: string }[] = []
  spans.forEach((span, i) => {
    const words = span.text.split(/[\s_]+/u).filter(Boolean)
    if (/^\d+$/.test(span.text)) {
      const edge = i === 0 || i === spans.length - 1
      if (ordinalAllowed && edge && span.text.length <= 3) {
        s.claim('role', span.start, span.start + span.text.length, {
          role: null,
          ordinal: Number(span.text),
          word: span.text,
        })
      } else {
        s.claim('unknown', span.start, span.start + span.text.length, { reason: 'number' })
      }
      return
    }
    if (words.every((w) => NOISE.has(w.toLowerCase()))) return
    if (
      words.length === 1 &&
      ((usageName && isJunkWord(span.text)) || /^\d+\p{L}{1,3}$/u.test(span.text))
    ) {
      s.claim('unknown', span.start, span.start + span.text.length, { reason: 'fragment' })
      return
    }
    if (!hasLetter(span.text)) {
      s.claim('unknown', span.start, span.start + span.text.length, { reason: 'symbols' })
      return
    }
    titles.push(span)
  })
  const first = titles[0]
  if (!first) return
  const text = cleanTitle(titles.map((t) => t.text).join(' '))
  if (text === '') return
  const last = titles[titles.length - 1] ?? first
  s.drafts.push({
    kind: 'title',
    start: first.start,
    raw: s.text.slice(first.start, last.start + last.text.length),
    payload: { text, lang: languageOf(text) },
  })
}

// ── The parser ──────────────────────────────────────────────────────────────────────────

export interface NameContext {
  isDir: boolean
  /** Area of the old disk, only «Старый формат» changes how numbers are read. */
  area?: LegacyArea
  /** Area under BG or «Старый формат»: the type of an old `NNN` number. */
  subArea?: LegacyArea
}

const OLD_FORMAT_TYPE: Partial<Record<LegacyArea, ItemTypeCode>> = {
  ppv: 'PPV',
  sets: 'SET',
  customs: 'CUS',
  sextings: 'SXT',
  fyp: 'FYP',
  life: 'LIFE',
}

function toClaims(name: string, drafts: Draft[]): LegacyClaim[] {
  const sorted = [...drafts].sort(
    (a, b) => a.start - b.start || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  )
  const seen = new Map<string, number>()
  return sorted.map((d) => {
    const base = claimKey(name, d.kind, d.start)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return {
      kind: d.kind,
      raw_fragment: d.raw,
      claim_key: n === 1 ? base : `${base}:${n}`,
      parser_version: PARSER_VERSION,
      payload: d.payload,
    } as LegacyClaim
  })
}

const typeOf = (code: string): ItemTypeCode => {
  const upper = code.toUpperCase()
  return (upper === 'CST' ? 'CUS' : upper) as ItemTypeCode
}

export function parseLegacyName(name: string, ctx: NameContext): LegacyClaim[] {
  const { stem } = splitExtension(name, ctx.isDir)
  const s = new Scanner(stem)
  const whole = stem.trim()

  if (STRUCTURAL.some((p) => p.test(whole))) return []
  if (ctx.isDir) {
    for (const [pattern, role] of FOLDER_ROLE) {
      if (pattern.test(whole)) {
        s.claim('role', 0, stem.length, { role, ordinal: null, word: whole })
        return toClaims(name, s.drafts)
      }
    }
    if (TAG_FOLDER.test(whole)) {
      s.claim('tag', 0, stem.length, { tag: whole.toLowerCase() })
      return toClaims(name, s.drafts)
    }
  }
  if (VENDOR.test(whole)) {
    s.claim('tag', 0, stem.length, { tag: 'steadycontent' })
    return toClaims(name, s.drafts)
  }
  if (LONG_NUMBER.test(whole)) {
    s.claim('origin', 0, stem.length, { origin: 'messenger' })
    return toClaims(name, s.drafts)
  }
  if (RECOVERED.test(whole)) {
    s.claim('origin', 0, stem.length, { origin: 'recovered' })
    return toClaims(name, s.drafts)
  }
  const contractor = CONTRACTOR_EXPORT.exec(whole)
  if (contractor) {
    s.claim('origin', 0, stem.length, { origin: 'contractor_export' })
    s.claim('role', 0, stem.length, { role: null, ordinal: Number(contractor[1]), word: whole })
    return toClaims(name, s.drafts)
  }

  // «MM:SS хвост» — the tail is the title as is (SPEC §6.3, решение 30.10.2026).
  const custom = /^(\d{1,2}):(\d{2})\s+([^_]*\p{L}[^_]*)$/u.exec(stem)
  if (custom && Number(custom[2]) < 60) {
    const clock = `${custom[1]}:${custom[2]}`
    s.claim('duration', 0, clock.length, {
      seconds: Number(custom[1]) * 60 + Number(custom[2]),
      approximate: false,
    })
    const tail = (custom[3] ?? '').trim()
    const tailStart = stem.indexOf(tail, clock.length)
    s.claim('title', tailStart, tailStart + tail.length, { text: tail, lang: languageOf(tail) })
    return toClaims(name, s.drafts)
  }

  const full = FULL.exec(whole)
  if (full) {
    s.claim('role', 0, stem.length, {
      role: 'master',
      ordinal: full[1] ? Number(full[1]) : null,
      word: whole,
    })
    return toClaims(name, s.drafts)
  }

  // `12.mov`, `1.2.mov`, `11-3.MOV` — ordinals of a vendor or a sexting.
  const numeric = /^(\d{1,4})(?:[.-]([1-9]\d?))?$/u.exec(whole)
  if (numeric && !/^0\d[.]/.test(whole) && !/^20\d\d$/.test(whole)) {
    const ordinal = Number(numeric[1])
    s.claim('role', 0, stem.length, { role: null, ordinal, word: whole })
    return toClaims(name, s.drafts)
  }
  const fypOrdinal = ORDINAL_FYP.exec(whole)
  if (fypOrdinal) {
    s.claim('role', 0, stem.length, { role: null, ordinal: Number(fypOrdinal[1]), word: whole })
    return toClaims(name, s.drafts)
  }

  s.take(BRACKET_ID, (m) => {
    const type = typeOf(m[1] ?? '')
    s.claim('number', m.index, m.index + m[0].length, {
      type,
      number: Number(m[2]),
      form: 'bracket',
      reserves: true,
    })
  })

  // Origins of the bytes (naming §8): evidence, not a classification.
  s.take(CAPCUT, (m) => {
    s.claim('role', m.index, m.index + m[0].length, { role: 'teaser', ordinal: null, word: 'lv_0' })
    s.claim('origin', m.index, m.index + m[0].length, { origin: 'capcut' })
  })
  s.take(IOS_COPY, (m) => {
    s.claim('origin', m.index, m.index + m[0].length, { origin: 'ios_copy' })
  })
  s.take(MESSENGER_PHOTO, (m) => {
    s.claim('origin', m.index, m.index + m[0].length, { origin: 'messenger' })
  })
  s.take(SCREENSHOT, (m) => {
    s.claim('origin', m.index, m.index + m[0].length, { origin: 'screenshot' })
  })
  s.take(TIMESTAMP_NAME, (m) => {
    const date = makeDate(Number(m[1]), Number(m[2]), Number(m[3]))
    if (!date) return false
    s.claim('origin', m.index, m.index + m[0].length, { origin: 'export' })
    s.claim('date', m.index, m.index + m[0].length, { date, unset: false, until: null })
  })
  s.take(/archive-(\d{4})-(\d{2})-(\d{2})_\d{2}-\d{2}-\d{2}/giu, (m) => {
    const date = makeDate(Number(m[1]), Number(m[2]), Number(m[3]))
    s.claim('origin', m.index, m.index + m[0].length, { origin: 'export' })
    if (date) s.claim('date', m.index, m.index + m[0].length, { date, unset: false, until: null })
  })
  s.take(UUID, (m) => {
    s.claim('origin', m.index, m.index + m[0].length, { origin: 'export' })
  })
  s.take(CAMERA, (m) => {
    const vendor = /^PMR/i.test(m[1] ?? '')
    s.claim('origin', m.index, m.index + m[0].length, {
      origin: vendor ? 'vendor_camera' : 'camera',
    })
  })
  s.take(DUPLICATE_SUFFIX, () => true)

  s.take(NON_USED, () => true)
  scanUsage(s)

  for (const pattern of FYP_BATCH) {
    s.take(pattern, (m) => {
      const fromDateFirst = pattern === FYP_BATCH[1]
      const number = Number(fromDateFirst ? m[4] : m[1])
      const date = fromDateFirst ? dateOf(m, 1) : dateOf(m, 2)
      if (!date) return false
      const end = m.index + m[0].length
      s.claim('number', m.index, end, { type: 'FYP', number, form: 'fyp_batch', reserves: false })
      s.claim('posted', m.index, end, usage('fyp_batch', null, date, []))
    })
  }

  s.take(SEXTING_NUMBER, (m) => {
    s.claim('number', m.index, m.index + m[0].length, {
      type: 'SXT',
      number: Number(m[1]),
      form: 'sexting',
      reserves: true,
    })
  })

  if (ctx.area === 'old_format') {
    s.take(OLD_FORMAT_NUMBER, (m) => {
      const type = OLD_FORMAT_TYPE[ctx.subArea ?? 'unknown']
      const digits = m[1] ?? ''
      const start = m.index + m[0].length - digits.length
      if (!type) {
        s.claim('unknown', start, start + digits.length, { reason: 'old_number_without_type' })
        return
      }
      s.claim('number', start, start + digits.length, {
        type,
        number: Number(digits),
        form: 'old_format',
        reserves: false,
      })
    })
  }

  s.take(LOOSE_ID, (m) => {
    s.claim('number', m.index, m.index + m[0].length, {
      type: typeOf(m[1] ?? ''),
      number: Number(m[2]),
      form: 'loose',
      reserves: false,
    })
  })

  s.take(NOT_SET, (m) => {
    s.claim('date', m.index, m.index + m[0].length, { date: null, unset: true, until: null })
  })
  s.take(DATE_RANGE, (m) => {
    const from = dateOf(m, 1)
    const until = dateOf(m, 4)
    if (!from || !until) return false
    s.claim('date', m.index, m.index + m[0].length, { date: from, unset: false, until })
  })
  s.take(ISO_DATE, (m) => {
    const date = makeDate(Number(m[1]), Number(m[2]), Number(m[3]))
    if (!date) return false
    s.claim('date', m.index, m.index + m[0].length, { date, unset: false, until: null })
  })
  s.take(UNDERSCORE_FULL_DATE, (m) => {
    const date = dayMonthYear(m[1] ?? '', m[2] ?? '', m[3])
    if (!date) return false
    s.claim('date', m.index, m.index + m[0].length, { date, unset: false, until: null })
  })
  s.take(DATE, (m) => {
    const date = dateOf(m, 1)
    if (!date) return false
    s.claim('date', m.index, m.index + m[0].length, { date, unset: false, until: null })
  })
  s.take(YEAR_MONTH_GLUED, (m) => {
    const month = monthOf(m[2] ?? '')
    if (month === null) return false
    const date = makeDate(2000 + Number(m[1]), month, null)
    s.claim('date', m.index, m.index + m[0].length, { date, unset: false, until: null })
  })
  s.take(MONTH_YEAR, (m) => {
    const month = monthOf(m[1] ?? '')
    if (month === null) return false
    const year = m[2] ? (m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2])) : null
    const date = makeDate(year, month, null)
    s.claim('date', m.index, m.index + m[0].length, { date, unset: false, until: null })
  })
  s.take(YEAR_ONLY, (m) => {
    s.claim('date', m.index, m.index + m[0].length, {
      date: yearDate(Number(m[1])),
      unset: false,
      until: null,
    })
  })

  s.take(CLOCK, (m) => {
    const seconds = m[3]
      ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
      : Number(m[1]) * 60 + Number(m[2])
    if (Number(m[2]) >= 60 || (m[3] !== undefined && Number(m[3]) >= 60)) return false
    s.claim('duration', m.index, m.index + m[0].length, { seconds, approximate: false })
  })
  s.take(MINUTES, (m) => {
    const minutes = Number(m[1])
    const extra = m[2] ? Number(m[2].padEnd(2, '0')) : 0
    s.claim('duration', m.index, m.index + m[0].length, {
      seconds: minutes * 60 + (extra < 60 ? extra : 0),
      approximate: !m[2],
    })
  })
  s.take(COUNT, () => true)
  if (ctx.isDir) s.take(FOLDER_COUNT, () => true)

  s.take(CUSTOM_FAN, (m) => {
    s.claim('origin', m.index, m.index + m[0].length, { origin: 'custom', fan: m[1] })
  })
  s.take(CUSTOM_WORD, (m) => {
    s.claim('origin', m.index, m.index + m[0].length, { origin: 'custom' })
  })
  s.take(PREFIX_MARKER, () => true)
  s.take(BG_WORD, (m) => {
    s.claim('tag', m.index, m.index + m[0].length, { tag: 'bg' })
  })
  s.take(ROLE_WORD, (m) => {
    const word = (m[2] ?? '').toLowerCase()
    const ordinal = m[1] ?? m[3]
    s.claim('role', m.index, m.index + m[0].length, {
      role: 'teaser',
      ordinal: ordinal ? Number(ordinal) : null,
      word,
    })
  })
  for (const pattern of [LEADING_ORDINAL, TRAILING_ORDINAL]) {
    s.take(pattern, (m) => {
      s.claim('role', m.index, m.index + m[0].length, {
        role: null,
        ordinal: Number(m[1]),
        word: m[1],
      })
    })
  }

  leftovers(s, true)
  return toClaims(name, servicePosted(s.drafts, ctx.isDir))
}

/**
 * `Posted/`, `Posted sets/`, `May 2025(posted)/`, `6. Life/posted/` — a service folder: the
 * material went out, the page is unknown (SPEC §6.3).
 */
function servicePosted(drafts: Draft[], isDir: boolean): Draft[] {
  if (!isDir) return drafts
  const content = drafts.some((d) => d.kind !== 'posted' && d.kind !== 'date')
  if (content) return drafts
  return drafts.map((d) => {
    if (d.kind !== 'posted') return d
    const payload = d.payload as UsagePayload
    if (payload.label !== 'posted' || payload.date !== null) return d
    return { ...d, payload: usage('posted_folder', null, null, payload.notes) }
  })
}
