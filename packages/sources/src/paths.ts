import type { SourcePath } from './types.ts'

/**
 * Paths are kept as the source returned them: no trimming, no case folding, no
 * replacement of `:` (legacy-and-import §1: names with `:` and folders with a trailing
 * space exist). The NFC form is what ContentOps compares (schema §3.4 `source_paths`).
 */

export const nfc = (s: string): string => s.normalize('NFC')

const YANDEX_PREFIX = 'disk:'

/** `disk:/A/b`, `/A/b`, `A/b` → `disk:/A/b`; `disk:`, `/`, `''` → `disk:/`. */
export function yandexPath(path: string): string {
  let rest = path.startsWith(YANDEX_PREFIX) ? path.slice(YANDEX_PREFIX.length) : path
  if (!rest.startsWith('/')) rest = `/${rest}`
  if (rest.length > 1 && rest.endsWith('/')) rest = rest.slice(0, -1)
  return `${YANDEX_PREFIX}${rest}`
}

/** `''`, `/` → `''` (Dropbox root); `A/b`, `/A/b/` → `/A/b`. */
export function dropboxPath(path: string): string {
  if (path === '' || path === '/') return ''
  let p = path.startsWith('/') ? path : `/${path}`
  if (p.endsWith('/')) p = p.slice(0, -1)
  return p
}

/** Components of a path; empty for the root. Spaces inside and at the ends are kept. */
export function components(path: string): string[] {
  const rest = path.startsWith(YANDEX_PREFIX) ? path.slice(YANDEX_PREFIX.length) : path
  return rest.split('/').filter((part) => part !== '')
}

/** Raw parent path in the same notation; null for the top (`disk:/` or `''`). */
export function parentPath(path: string): string | null {
  const parts = components(path)
  if (parts.length === 0) return null
  const parent = parts.slice(0, -1).join('/')
  return path.startsWith(YANDEX_PREFIX) ? `${YANDEX_PREFIX}/${parent}` : parent ? `/${parent}` : ''
}

/** Joins a child name to a folder path in the same notation. */
export function childPath(folder: string, name: string): string {
  return folder.endsWith('/') ? `${folder}${name}` : `${folder}/${name}`
}

/**
 * True when `path` is the root or inside it. Yandex compares exactly; Dropbox compares
 * `path_lower` with the lower-cased root, as Dropbox itself does.
 */
export function isUnder(path: string, root: string, caseInsensitive = false): boolean {
  const fold = (s: string) => (caseInsensitive ? s.toLowerCase() : s)
  const p = components(path).map((c) => fold(nfc(c)))
  const r = components(root).map((c) => fold(nfc(c)))
  return r.length <= p.length && r.every((c, i) => c === p[i])
}

/**
 * Builds the path record. `relative` is cut by component count from `raw`, not by string
 * prefix, so a Dropbox `path_display` with a differently cased parent still works.
 */
export function sourcePath(raw: string, root: string, lower: string | null = null): SourcePath {
  const relative = components(raw).slice(components(root).length).join('/')
  return { raw, nfc: nfc(raw), lower, relative, relativeNfc: nfc(relative) }
}
