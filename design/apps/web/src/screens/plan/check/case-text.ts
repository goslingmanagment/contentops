import {
  type CatalogEntry,
  type CheckCase,
  type CheckCaseKind,
  formatClock,
  formatDate,
  formatDuration,
  formatNumber,
  formatWeekdayShort,
  type HubPost,
  type ItemId,
  type LocalDate,
  type LocalTime,
  mskDate,
  SURFACE_LABEL,
  type SurfaceKind,
} from '@contentops/contracts'

/** Слова строки и панели сверки (DESIGN §4.15): факт, без пересказа нормы. */

export interface CaseMoment {
  date: LocalDate
  time: LocalTime | null
}

/**
 * О чём случай, открытый или решённый: наш объект, место в плане и пост, который видел Hub.
 * У открытого пост — первый из вариантов, у решённого — тот, о котором решили.
 */
export interface CaseSubject {
  item_id: ItemId | null
  title: string
  surface: SurfaceKind
  slot: CaseMoment | null
  post: HubPost | null
}

export function subjectOf(entry: CheckCase): CaseSubject {
  return { ...entry, post: entry.posts[0] ?? null }
}

/** Когда случилось: строка плана, а без неё — время поста, который видел Hub. */
function subjectMoment(subject: CaseSubject): CaseMoment | null {
  if (subject.slot) {
    return subject.slot
  }
  const { post } = subject
  return post ? { date: mskDate(post.post_at), time: formatClock(post.post_at) } : null
}

export function caseMoment(entry: CheckCase): CaseMoment | null {
  return subjectMoment(subjectOf(entry))
}

/** «03:00» сегодня, «пн 21.09, 03:00» в другой день, «вс 20.09» без времени. */
export function momentLabel(moment: CaseMoment, today: LocalDate): string {
  if (moment.date === today) {
    return moment.time ?? 'сегодня'
  }
  const day = `${formatWeekdayShort(moment.date)} ${formatDate(moment.date, today)}`
  return moment.time ? `${day}, ${moment.time}` : day
}

/**
 * Как назвать случай: название нашего объекта, а у поста без плана своего названия нет —
 * подпись поста в кавычках («mirror mood 🖤») или его состав («видео 0:07»).
 */
export function subjectTitle(subject: CaseSubject): string {
  if (subject.item_id) {
    return subject.title
  }
  const { post } = subject
  if (post?.caption) {
    return `«${post.caption}»`
  }
  return post?.summary || subject.title
}

export function caseTitle(entry: CheckCase): string {
  return subjectTitle(subjectOf(entry))
}

/**
 * Вторая строка: «фуп · 03:00». У поста без плана с подписью — ещё и состав: «стена ·
 * 11:02 · видео 0:07». `where` — поверхность словом, если она уже известна.
 */
export function subjectSubtitle(subject: CaseSubject, today: LocalDate, where?: string): string {
  const moment = subjectMoment(subject)
  const { post } = subject
  const composition = !subject.item_id && post?.caption ? post.summary : null
  return [
    where ?? SURFACE_LABEL[subject.surface],
    moment ? momentLabel(moment, today) : null,
    composition,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** У «стена или фуп?» поверхность ещё не известна — пишется «пост». */
export function caseSubtitle(entry: CheckCase, today: LocalDate): string {
  return subjectSubtitle(subjectOf(entry), today, entry.kind === 'surface' ? 'пост' : undefined)
}

/** Как назвать случай в полоске после действия: «FYP-0801 версия 1» или «пост 11:02». */
export function caseLabel(entry: CheckCase): string {
  if (entry.version_label) {
    return entry.version_label
  }
  const post = entry.posts[0]
  return post ? `пост ${formatClock(post.post_at)}` : 'пост'
}

/** «+6 мин», «−2 мин», «в то же время». */
export function offsetLabel(minutes: number | null): string | null {
  if (minutes === null) {
    return null
  }
  if (minutes === 0) {
    return 'в то же время'
  }
  return `${minutes > 0 ? '+' : '−'}${Math.abs(minutes)} мин`
}

/**
 * Сколько наших фото идёт в пост: у сета — отобранные кадры (DESIGN §4.15), у остальных —
 * все фото. Пока в сете ничего не отобрано, сравнивать не с чем, кроме всего сета.
 */
function photosForPost(entry: CatalogEntry): number | null {
  if (entry.type === 'set' && entry.selected_count) {
    return entry.selected_count
  }
  return entry.photo_count
}

/**
 * Наш состав словами, как у поста: «видео 9:41 и 2 фото», «видео 0:09», «22 фото». У сета
 * с отобранными кадрами — и сколько отобрано: «38 фото, отобрано 22».
 */
export function compositionOf(entry: CatalogEntry): string | null {
  const video = entry.duration_s === null ? null : `видео ${formatDuration(entry.duration_s)}`
  const photos = entry.photo_count ? `${formatNumber(entry.photo_count)} фото` : null
  const selected = photosForPost(entry)
  const picked =
    photos && selected !== entry.photo_count
      ? `${photos}, отобрано ${formatNumber(selected ?? 0)}`
      : photos
  if (video && picked) {
    return `${video} и ${picked}`
  }
  return video ?? picked
}

export interface CompositionCheck {
  /** «видео 0:09 — совпадает», «видео 0:10 и 0:07 — не совпадает». */
  text: string
  matches: boolean
}

interface CompositionPart {
  noun: 'видео' | 'фото'
  ours: string
  theirs: string
  same: boolean
}

function compositionParts(ours: CatalogEntry, post: HubPost): CompositionPart[] {
  const parts: CompositionPart[] = []
  if (ours.duration_s !== null && post.duration_s !== null) {
    parts.push({
      noun: 'видео',
      ours: formatDuration(ours.duration_s),
      theirs: formatDuration(post.duration_s),
      same: ours.duration_s === post.duration_s,
    })
  }
  const photos = photosForPost(ours) ?? 0
  if (post.photo_count !== null && (photos > 0 || post.photo_count > 0)) {
    parts.push({
      noun: 'фото',
      ours: formatNumber(photos),
      theirs: formatNumber(post.photo_count),
      same: photos === post.photo_count,
    })
  }
  return parts
}

/**
 * Наше против поста (DESIGN §4.15): длительность видео и число фото, у сета — число
 * отобранных кадров. «видео 9:41 и 2 фото — совпадает», «видео 0:10 и 0:07 — не
 * совпадает», «фото 21 и 22 — не совпадает». `null` — сравнивать нечего: Hub не знает
 * состав поста или у нас нет ни видео, ни фото.
 */
export function compareComposition(ours: CatalogEntry, post: HubPost): CompositionCheck | null {
  const parts = compositionParts(ours, post)
  if (parts.length === 0) {
    return null
  }
  const differ = parts.filter((part) => !part.same)
  if (differ.length === 0) {
    const same = parts.map((part) =>
      part.noun === 'видео' ? `видео ${part.theirs}` : `${part.theirs} фото`,
    )
    return { text: `${same.join(' и ')} — совпадает`, matches: true }
  }
  const text = differ.map((part) => `${part.noun} ${part.ours} и ${part.theirs}`).join(', ')
  return { text: `${text} — не совпадает`, matches: false }
}

/** «Пост 17:58 (−2 мин)»: время поста и сдвиг от строки плана, как в одной фразе пары. */
export function postMoment(post: HubPost): string {
  const offset = offsetLabel(post.offset_min)
  return `Пост ${formatClock(post.post_at)}${offset ? ` (${offset})` : ''}`
}

/** «17:58 и 18:07», «17:58, 18:07 и 18:30». */
function joinAnd(parts: readonly string[]): string {
  const last = parts.at(-1)
  return parts.length > 1 && last ? `${parts.slice(0, -1).join(', ')} и ${last}` : (last ?? '')
}

type FactOf = (entry: CheckCase, ours: CatalogEntry | undefined) => string | null

/** «пост 03:06 · +6 мин · 0:09 = 0:09»: время поста и обе стороны цифрами. */
const postFact: FactOf = (entry, ours) => {
  const post = entry.posts[0]
  if (!post) {
    return null
  }
  const numbers = pairNumbers(entry, ours)
  return `пост ${formatClock(post.post_at)}${numbers ? ` · ${numbers}` : ''}`
}

const FACT: Record<CheckCaseKind, FactOf> = {
  candidate: postFact,
  mismatch: postFact,
  conflict: postFact,
  surface: postFact,
  variants: (entry) =>
    `посты ${joinAnd(entry.posts.map((post) => formatClock(post.post_at)).sort())}`,
  partial: (entry) => {
    const missing = entry.attachments.filter((attachment) => !attachment.ok)
    return missing.length > 0 ? `нет ${missing.map((item) => item.label).join(', ')}` : null
  },
  unplanned: () => null,
  vault_missing: () => null,
  vault_stale: () => null,
}

/**
 * Короткий факт под словом строки (DESIGN §4.15): цифры обеих сторон, чтобы решить пару
 * Fansly прямо в строке. У поста без плана и у vault слово говорит само, подробности — в
 * «почему».
 */
export function caseFact(entry: CheckCase, ours: CatalogEntry | undefined): string | null {
  return FACT[entry.kind](entry, ours)
}

/** «+6 мин · 0:09 = 0:09» у однозначной пары: время и длительность обеих сторон. */
export function pairNumbers(entry: CheckCase, ours: CatalogEntry | undefined): string | null {
  const post = entry.posts[0]
  if (!post) {
    return null
  }
  const parts = [offsetLabel(post.offset_min)]
  if (ours?.duration_s != null && post.duration_s !== null) {
    const same = ours.duration_s === post.duration_s
    parts.push(
      `${formatDuration(ours.duration_s)} ${same ? '=' : '≠'} ${formatDuration(post.duration_s)}`,
    )
  }
  return parts.filter(Boolean).join(' · ') || null
}
