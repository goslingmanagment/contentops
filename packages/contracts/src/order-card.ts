import type { ParsedOrderCard } from './commands/orders'
import type { AccountCode, LocalDate } from './domain/common'
import type { Account, Platform } from './domain/model'

/**
 * Reading a Telegram order card into fields (DESIGN §4.16, «Новый заказ»): the person
 * pastes the text, checks the parsed fields and saves. Nothing is fetched from Telegram.
 */

export interface ParsedDuration {
  raw: string
  min_s: number | null
  max_s: number | null
}

/** «12-15 минут» → 12–15 мин; «около 15 минут» → 14–16 мин; «10 минут» → 9–11 мин. */
export function parseDuration(text: string): ParsedDuration | null {
  const match = /(около\s*)?(\d+)(?:\s*[-–]\s*(\d+))?\s*мин[а-я]*/iu.exec(text)
  if (!match) return null
  const from = Number(match[2])
  const to = match[3] ? Number(match[3]) : null
  const raw = match[0].trim()
  if (to !== null) return { raw, min_s: from * 60, max_s: to * 60 }
  return { raw, min_s: (from - 1) * 60, max_s: (from + 1) * 60 }
}

function deadlineOf(text: string, year: number): LocalDate | null {
  const match = /до\s*(\d{1,2})\.(\d{2})/u.exec(text)
  if (!match) return null
  return `${year}-${match[2]}-${String(match[1]).padStart(2, '0')}`
}

const TITLE_LENGTH = 60

/**
 * The order's short name (DESIGN §4.16, «Кастом «вся в красном»»): the quoted part of the
 * brief, else its first line, cut at a word to 60 characters.
 */
export function orderTitleOf(brief: string): string {
  const quoted = /«([^»]+)»/u.exec(brief)
  const line = (quoted?.[1] ?? brief.split('\n').find((part) => part.trim()) ?? '').trim()
  if (line.length <= TITLE_LENGTH) return line
  const cut = line.slice(0, TITLE_LENGTH)
  const space = cut.lastIndexOf(' ')
  return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** How chatters write a platform in a card: «Fansly 2», «фансли 2», «OF VIP», «онлифанс фри». */
const PLATFORM_WORDS: Record<Platform, readonly string[]> = {
  fansly: ['fansly', 'фансли', 'фанс'],
  onlyfans: ['onlyfans', 'of', 'оф', 'онлифанс', 'онли'],
}

/** Page names after the platform, in the other spelling: «VIP» / «вип», «Free» / «фри». */
const PAGE_WORD_SPELLINGS: Record<string, readonly string[]> = {
  vip: ['вип'],
  free: ['фри'],
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** «Fansly 2» → matches «Fansly 2», «fansly2», «фансли 2», but not «Fansly 21». */
function pagePattern(account: Pick<Account, 'platform' | 'label'>): RegExp {
  const [, ...rest] = account.label.trim().split(/\s+/u)
  const page = rest.join(' ')
  const pageWords = [page, ...(PAGE_WORD_SPELLINGS[page.toLowerCase()] ?? [])]
  const platform = PLATFORM_WORDS[account.platform].map(escapeRegExp).join('|')
  const name = pageWords.map(escapeRegExp).join('|')
  return new RegExp(`(?<![\\p{L}\\d])(?:${platform})\\s*(?:${name})(?![\\p{L}\\d])`, 'iu')
}

/** The page the card names; the first page of the model when the card does not say. */
function accountOf(text: string, accounts: readonly Account[]): AccountCode | null {
  const named = accounts.find((account) => pagePattern(account).test(text))
  return (named ?? accounts[0])?.code ?? null
}

export function parseOrderCard(
  text: string,
  messageUrl: string | null,
  year: number,
  accounts: readonly Account[],
): ParsedOrderCard {
  const buyer = /фан\s*№\s*(\d+)/u.exec(text)
  const photos = /(\d+)\s*фото/u.exec(text)
  const duration = parseDuration(text)
  const briefLine = text
    .split('\n')
    .find((line) => line.includes('📄') || /^тз/iu.test(line.trim()))
  const named = /«([^»]+)»/u.exec(text)?.[1] ?? null
  const briefText = briefLine
    ? briefLine
        .replace('📄', '')
        .replace(/^\s*тз:?/iu, '')
        .trim()
    : null
  // The name in quotes leads the brief: the order's title is taken from it.
  const brief =
    [named && !briefText?.includes(named) ? `«${named}»` : null, briefText]
      .filter(Boolean)
      .join(' ') || null
  return {
    buyer: buyer ? `фан №${buyer[1]}` : null,
    account: accountOf(text, accounts),
    brief,
    duration_raw: duration?.raw ?? '',
    wants_video: duration !== null || !photos,
    wants_photos: photos ? Number(photos[1]) : 0,
    deadline: deadlineOf(text, year),
    fan_name: 'unknown',
    message_url: messageUrl,
    card_text: text,
  }
}
