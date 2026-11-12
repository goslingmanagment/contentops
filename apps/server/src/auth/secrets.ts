import { createHash, randomBytes } from 'node:crypto'

/** Session cookie of people (SPEC §12.0): an opaque random token, the server keeps its hash. */
export const SESSION_COOKIE = 'co_session'
export const SESSION_DAYS = 30
/** Bearer tokens of agents start with it, so a leaked one is easy to recognise. */
export const TOKEN_PREFIX = 'co_'
/** Characters of a token shown next to it in «Агенты и токены». */
export const TOKEN_PREFIX_LENGTH = 8

export function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest()
}

/**
 * A session opened through the hub (SPEC §11.1) has a token of its own form: this prefix (a
 * dot never occurs in `newSecret`) and a digest under its own label. An image without the
 * hub's re-check finds no row for such a token, so after a rollback it cannot outlive the
 * person's sign-out at the hub.
 */
export const HUB_SESSION_PREFIX = 'hub.'

/** What `sessions.token_hash` holds for a session cookie. */
export function sessionDigest(token: string): Buffer {
  return token.startsWith(HUB_SESSION_PREFIX) ? sha256(`hub-session\n${token}`) : sha256(token)
}

/** 32 random bytes, URL-safe: a session token or the secret of an agent token. */
export function newSecret(prefix = ''): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`
}

/** `k7m2-q9pd-3xa1-…`: a temporary password, shown once and never stored in the clear. */
export function temporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = randomBytes(16)
  const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length])
  return [0, 4, 8, 12].map((at) => chars.slice(at, at + 4).join('')).join('-')
}

interface CookieOptions {
  /** `PUBLIC_URL` is https: the browser sends the cookie only over TLS. */
  secure: boolean
}

function cookie(value: string, maxAgeSeconds: number, { secure }: CookieOptions): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

export function sessionCookie(token: string, options: CookieOptions): string {
  return cookie(token, SESSION_DAYS * 24 * 60 * 60, options)
}

export function clearedSessionCookie(options: CookieOptions): string {
  return cookie('', 0, options)
}

/** «Chrome на Mac» from the user agent; anything unknown is «Браузер». */
export function deviceOf(userAgent: string | null): string {
  const ua = userAgent ?? ''
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Браузер'
  const system = /iPhone|iPad/.test(ua)
    ? 'iPhone'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'Mac'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : null
  return system ? `${browser} на ${system}` : browser
}
