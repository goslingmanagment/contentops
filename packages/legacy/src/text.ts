import { createHash } from 'node:crypto'

/** Parser version: claims of the same input and version are identical (schema §9.7). */
export const PARSER_VERSION = 'legacy-names@1'

export const nfc = (s: string): string => s.normalize('NFC')

/**
 * `disk:/A/b`, `/A/b/`, `A\b` → `A/b`: root-relative, NFC, `/` separators. Spaces at the ends
 * of parts are kept (legacy §1: two folders end with a space).
 */
export function relativePath(path: string): string {
  let p = nfc(path).replaceAll('\\', '/')
  if (p.startsWith('disk:')) p = p.slice('disk:'.length)
  return p
    .split('/')
    .filter((part) => part !== '')
    .join('/')
}

const EXTENSION = /\.([A-Za-z][A-Za-z0-9]{1,4}|3gp)$/

/** `Какао .mov` → `{ stem: 'Какао ', ext: 'mov' }`; directories keep the whole name. */
export function splitExtension(name: string, isDir: boolean): { stem: string; ext: string | null } {
  if (isDir) return { stem: name, ext: null }
  const match = EXTENSION.exec(name)
  if (!match || match.index === 0) return { stem: name, ext: null }
  return { stem: name.slice(0, match.index), ext: (match[1] ?? '').toLowerCase() }
}

export const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz'])

/** First 10 hex of SHA-256: the name part of a claim key. */
export function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 10)
}

/**
 * Natural key of a claim: the name (a rename gives a new claim, a repeat does not), the kind
 * and the position of the fragment (schema §9.7).
 */
export function claimKey(name: string, kind: string, offset: number, extra = ''): string {
  return `${shortHash(nfc(name))}:${kind}:${offset}${extra ? `:${extra}` : ''}`
}

/** Lower case, `ё` → `е`, no separators: compares folder names of the disk and the registry. */
export function looseKey(text: string): string {
  return nfc(text)
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[\s_\-.,()[\]]+/g, '')
}

const CYRILLIC = /[Ѐ-ӿ]/
const LATIN = /[a-z]/i

export function languageOf(text: string): 'ru' | 'en' | 'mixed' {
  const ru = CYRILLIC.test(text)
  const en = LATIN.test(text)
  if (ru && en) return 'mixed'
  return ru ? 'ru' : 'en'
}

export const hasLetter = (text: string): boolean => /\p{L}/u.test(text)
