/**
 * The address of an order is its Telegram card (SPEC §4.1, §8.2): `tg:<chat>/<topic>/<message>`.
 * People paste `https://t.me/c/<chat>/<topic>/<message>`, agents may write the `tg:` form or a
 * Bot API chat id (`-100…`); all of them are the same card. In paths the order is
 * `tg-<chat>-<topic>-<message>` (`tg-<chat>-<message>` without a topic).
 */
export interface TelegramMessageRef {
  /** Channel id without `-100` (as in `t.me/c/…`) or a lowercase public username. */
  chat: string
  topic: number | null
  message: number
}

const USERNAME = /^[a-z][a-z0-9_]{3,}$/

/** `-1002627984998` → `2627984998`; `LoraChat` → `lorachat`. */
function normalChat(raw: string): string | null {
  const value = raw.trim()
  if (/^-?\d+$/.test(value)) {
    const digits = value.replace(/^-/, '')
    return digits.length >= 13 && digits.startsWith('100') ? digits.slice(3) : digits
  }
  const name = value.replace(/^@/, '').toLowerCase()
  return USERNAME.test(name) ? name : null
}

function positive(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function fromParts(chat: string, rest: readonly string[]): TelegramMessageRef | null {
  const normal = normalChat(chat)
  if (!normal || rest.length < 1 || rest.length > 2) return null
  const numbers = rest.map(positive)
  if (numbers.some((value) => value === null)) return null
  const [first, second] = numbers as number[]
  return second === undefined
    ? { chat: normal, topic: null, message: first as number }
    : { chat: normal, topic: first as number, message: second }
}

/**
 * Any spelling of a message link: `https://t.me/c/123/45/678`, `t.me/name/678`,
 * `tg:123/45/678`, `tg-123-45-678`. Anything else is `null`.
 */
export function parseTelegramRef(text: string): TelegramMessageRef | null {
  const value = text.trim()
  const tg = /^tg:([^/\s]+)\/(\d+)(?:\/(\d+))?$/i.exec(value)
  if (tg) return fromParts(tg[1] as string, [tg[2], tg[3]].filter(Boolean) as string[])
  const address = /^tg-([a-z0-9_]+)-(\d+)(?:-(\d+))?$/i.exec(value)
  if (address) {
    return fromParts(address[1] as string, [address[2], address[3]].filter(Boolean) as string[])
  }
  const url = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(.+)$/i.exec(value)
  if (!url) return null
  const path = (url[1] as string).split(/[?#]/)[0]?.replace(/\/+$/, '') ?? ''
  const parts = path.split('/')
  if (parts[0] === 'c')
    return /^\d+$/.test(parts[1] ?? '') ? fromParts(parts[1] as string, parts.slice(2)) : null
  return fromParts(parts[0] ?? '', parts.slice(1))
}

/** `tg:2627984998/12/9844` — the stored form. */
export function telegramRefText(ref: TelegramMessageRef): string {
  return ref.topic === null
    ? `tg:${ref.chat}/${ref.message}`
    : `tg:${ref.chat}/${ref.topic}/${ref.message}`
}

/** The link that opens the message in Telegram. */
export function telegramUrl(ref: TelegramMessageRef): string {
  const chat = /^\d+$/.test(ref.chat) ? `c/${ref.chat}` : ref.chat
  return ref.topic === null
    ? `https://t.me/${chat}/${ref.message}`
    : `https://t.me/${chat}/${ref.topic}/${ref.message}`
}

/** `tg-2627984998-12-9844`: the order in paths and in the interface's addresses. */
export function orderAddress(ref: TelegramMessageRef): string {
  return ref.topic === null
    ? `tg-${ref.chat}-${ref.message}`
    : `tg-${ref.chat}-${ref.topic}-${ref.message}`
}

/** A stored `tg:` reference as a link; a reference of another kind has none. */
export function telegramUrlOf(stored: string): string | null {
  const ref = parseTelegramRef(stored)
  return ref ? telegramUrl(ref) : null
}
