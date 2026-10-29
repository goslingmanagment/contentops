import type { AccountCode, LocalDate, LocalTime } from './domain/common'

/**
 * Имена скачиваний и экспортов по naming §4–6 — одно место правды для сервера,
 * подсказок «будущее имя» и квитанций:
 *
 * `ID[_slug]_role[NN][_uN][_vN][__account_YYYY-MM-DD[_HHMM]][__NmSSs].ext`
 *
 * Что именно отдаёт каждый вид скачивания — в `download-files.ts`.
 */

/** Закрытый словарь ролей (naming §3). */
export const NAME_ROLES = [
  'master',
  'teaser',
  'preview',
  'pic',
  'raw',
  'ed',
  'clip',
  'thumb',
  'cap',
] as const
export type NameRole = (typeof NAME_ROLES)[number]

/**
 * Опорное выражение EXPORT из naming §5: им проверяется каждое выданное имя. Аккаунт —
 * код страницы как есть, с несколькими дефисами (`lora-vip-of`, DESIGN §10).
 */
export const EXPORT_NAME_PATTERN =
  /^(?<id>(?:PPV|SET|SXT|CUS|FYP|LIFE|RAW|PRM)-\d{3,6})(?:_(?<slug>[a-z][a-z0-9]*(?:-[a-z0-9]+)*))?_(?<role>master|teaser|preview|pic|raw|ed|clip|thumb|cap)(?<ord>\d{2,3})?(?:_u(?<uniq>[1-9]\d*))?(?:_v(?<version>[2-9]|[1-9]\d+))?(?:__(?<account>[a-z0-9]+(?:-[a-z0-9]+)+)_(?<date>\d{4}-\d{2}-\d{2})(?:_(?<hhmm>\d{4}))?)?(?:__(?<dur>\d+m\d{2}s))?\.(?<ext>[a-z0-9]{2,4})$/

/** Лимит длины имени скачивания (naming §5). */
export const NAME_LIMIT = 100

/** Слова slug: до пяти и до 40 знаков (naming §4). */
const SLUG_WORDS = 5
const SLUG_CHARS = 40

/** Фиксированный транслит naming §4; прочие буквы — по обычной таблице. */
const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
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
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
}

/** Стоп-слова транслита: прежний список naming §11 от 28.09.2026. */
const TRANSLIT_STOP_WORDS = new Set([
  'a',
  'bez',
  'dlya',
  'do',
  'i',
  'ili',
  'iz',
  'k',
  'ko',
  'na',
  'nad',
  'ne',
  'no',
  'o',
  'ob',
  'ot',
  'po',
  'pod',
  'pri',
  'pro',
  's',
  'so',
  'u',
  'v',
  'vo',
  'za',
])

/** Стоп-слова английского названия (naming §4, решение 18.10.2026). */
const ENGLISH_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
  'without',
])

/** Слова названия латиницей по таблице naming §4, без знаков: «Чулки у окна» → chulki u okna. */
export function translitWords(title: string): string[] {
  return [...title.normalize('NFC').toLowerCase()]
    .map((char) => TRANSLIT[char] ?? char)
    .join('')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * Slug из короткого английского названия, иначе — транслит русского (naming §4).
 * Без стоп-слов, строчные ASCII-слова через `-`, начинается с буквы, до пяти слов
 * и 40 знаков. Вычисляется при скачивании, не хранится.
 */
export function slugOf(title: string, title_en?: string | null): string {
  const english = title_en?.trim()
  const stopWords = english ? ENGLISH_STOP_WORDS : TRANSLIT_STOP_WORDS
  const words = translitWords(english || title).filter((word) => !stopWords.has(word))
  const first = words.findIndex((word) => /^[a-z]/.test(word))
  const picked: string[] = []
  for (const word of first < 0 ? [] : words.slice(first, first + SLUG_WORDS)) {
    const next = [...picked, word].join('-')
    if (next.length > SLUG_CHARS) break
    picked.push(word)
  }
  return picked.length > 0 ? picked.join('-') : (words[first]?.slice(0, SLUG_CHARS) ?? '')
}

/** Строка плана в имени: аккаунт, плановый день и время слота (naming §5–6). */
export interface NameSlot {
  account: AccountCode
  date: LocalDate
  time: LocalTime | null
}

/** Части одного имени скачивания; пустое поле в имя не попадает. */
export interface NameParts {
  id: string
  title: string
  /** Короткое английское название; без него slug — транслит `title`. */
  title_en?: string | null
  role: NameRole
  /** Номер порядковой роли: `pic03`, `ed12`. */
  ordinal?: number | null
  /** Уникальная версия фупа: `_u2`. */
  uniq?: number | null
  /** Версия результата; первая без суффикса, `_v2` и дальше. */
  version?: number | null
  slot?: NameSlot | null
  /** Длительность файла — только у PPV и кастомов (naming §5). */
  duration_s?: number | null
  ext: string
}

/** `01…99`, дальше три цифры (ORD naming §5). */
export function ordinalToken(ordinal: number): string {
  return String(ordinal).padStart(2, '0')
}

/** `13m24s`: минуты без ограничения, секунды двумя цифрами. */
export function durationToken(seconds: number): string {
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, '0')}s`
}

/** Расширение по naming §5: нижний регистр, `.jpeg` → `.jpg`. */
export function normalizeExt(ext: string): string {
  const lower = ext.replace(/^\./, '').toLowerCase()
  return lower === 'jpeg' ? 'jpg' : lower
}

function slotToken(slot: NameSlot | null | undefined): string {
  if (!slot) return ''
  const time = slot.time ? `_${slot.time.replace(':', '')}` : ''
  return `__${slot.account}_${slot.date}${time}`
}

function assemble(parts: NameParts, slug: string): string {
  const ordinal = parts.ordinal ? ordinalToken(parts.ordinal) : ''
  const uniq = parts.uniq ? `_u${parts.uniq}` : ''
  const version = parts.version && parts.version > 1 ? `_v${parts.version}` : ''
  const duration =
    parts.duration_s !== null && parts.duration_s !== undefined
      ? `__${durationToken(parts.duration_s)}`
      : ''
  const head = slug ? `${parts.id}_${slug}` : parts.id
  return `${head}_${parts.role}${ordinal}${uniq}${version}${slotToken(parts.slot)}${duration}.${normalizeExt(parts.ext)}`
}

/**
 * Имя скачивания по грамматике naming §5. Если имя длиннее 100 знаков, slug теряет
 * слова с конца; ID, роль, версия и суффикс назначения не укорачиваются.
 */
export function exportName(parts: NameParts): string {
  const words = slugOf(parts.title, parts.title_en).split('-').filter(Boolean)
  for (let count = words.length; count > 0; count--) {
    const name = assemble(parts, words.slice(0, count).join('-'))
    if (name.length <= NAME_LIMIT) return name
  }
  return assemble(parts, '')
}

/**
 * Файл в ZIP промо-передачи (naming §6): номер подборки, порядковый номер и ID
 * источника с ролью, если это не мастер: `PRM-012_01_FYP-0412.mov`,
 * `PRM-012_02_SET-069-ed03.jpg`. Номер — две цифры, при сотне файлов и больше — три.
 */
export function promoMemberName(
  collectionId: string,
  index: number,
  total: number,
  source: { id: string; role: NameRole; ordinal: number | null },
  ext: string,
): string {
  const width = total > 99 ? 3 : 2
  const order = String(index).padStart(width, '0')
  const role =
    source.role === 'master'
      ? ''
      : `-${source.role}${source.ordinal ? ordinalToken(source.ordinal) : ''}`
  return `${collectionId}_${order}_${source.id}${role}.${normalizeExt(ext)}`
}

/** Манифест промо-передачи лежит в ZIP под этим именем (naming §6). */
export const PROMO_MANIFEST_NAME = 'manifest.csv'

/** Кастом для фана — нейтральное имя без ID: `lora-custom.mp4` (naming §6). */
export function fanFileName(model: string): string {
  return `${model}-custom.mp4`
}
