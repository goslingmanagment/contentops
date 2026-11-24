/**
 * The files `ops.js originals seed` reads (SPEC §9.4, ops/README.md «Оригиналы: два места»): they
 * are written on Windows by rclone and PowerShell and put into the share of the host, so every
 * parser takes a BOM, UTF-16 and CRLF. Paths come back as written; callers compare them in NFC.
 */

/** UTF-8 with or without BOM, or UTF-16 with its BOM; line ends become `\n`. */
export function decodeText(bytes: Uint8Array): string {
  let text: string
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = new TextDecoder('utf-16le').decode(bytes.subarray(2))
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    text = new TextDecoder('utf-16be').decode(bytes.subarray(2))
  } else {
    text = new TextDecoder('utf-8').decode(bytes)
  }
  return text.replace(/^﻿/u, '').replace(/\r\n?/gu, '\n')
}

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '')
}

/** A file of a MEGA folder as `rclone lsjson -R --files-only` lists it. */
export interface MegaEntry {
  /** Relative to the folder that was listed. */
  path: string
  size: number
  /** When the node appeared in MEGA (MEGA keeps no other time), ISO. */
  modTime: string | null
  /** The node ID. */
  id: string | null
}

export function parseMegaListing(text: string): MegaEntry[] {
  const body = text.trim()
  if (body === '') return []
  const parsed: unknown = JSON.parse(body)
  if (!Array.isArray(parsed))
    throw new Error('the MEGA listing is not a JSON array (rclone lsjson)')
  const out: MegaEntry[] = []
  for (const [n, raw] of parsed.entries()) {
    const item = raw as Record<string, unknown>
    if (!item || typeof item !== 'object' || item.IsDir === true) continue
    if (typeof item.Path !== 'string' || typeof item.Size !== 'number' || item.Size < 0) {
      throw new Error(`entry ${n + 1} of the MEGA listing has no Path or Size`)
    }
    const modTime =
      typeof item.ModTime === 'string' && !Number.isNaN(Date.parse(item.ModTime))
        ? new Date(item.ModTime).toISOString()
        : null
    out.push({
      path: item.Path,
      size: item.Size,
      modTime,
      id: typeof item.ID === 'string' && item.ID !== '' ? item.ID : null,
    })
  }
  return out
}

/** `rclone hashsum md5` / `md5sum`: `<md5>  <path>` (or `<md5> *<path>`) → path → md5 in hex. */
export function parseMd5Sums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of lines(text)) {
    const match = /^([0-9a-fA-F]{32}) [ *](.+)$/u.exec(line)
    if (match?.[1] && match[2]) out.set(match[2], match[1].toLowerCase())
  }
  return out
}

/**
 * `rclone check … --combined`: `= path` the same bytes, `* path` differ, `+ path` missing at the
 * destination, `- path` missing at the source, `! path` an error.
 */
export type CheckMark = '=' | '*' | '+' | '-' | '!'

export function parseCombined(text: string): { mark: CheckMark; path: string }[] {
  const out: { mark: CheckMark; path: string }[] = []
  for (const line of lines(text)) {
    const match = /^([=*+\-!]) (.+)$/u.exec(line)
    if (match?.[1] && match[2]) out.push({ mark: match[1] as CheckMark, path: match[2] })
  }
  return out
}

/** A line of Ari's manifest (`mega-copy.ps1`): where a file of her Dropbox lies in MEGA. */
export interface ManifestLine {
  /** Relative to the root of her Dropbox, as `rclone lsf` writes it (no leading `/`). */
  dropbox: string
  /** Relative to her MEGA folder. */
  mega: string
  size: number
  /** `catalog` (renamed to the catalog's name), `new`, `outside`, `copy`. */
  kind: string
}

export function parseManifest(text: string): ManifestLine[] {
  const out: ManifestLine[] = []
  for (const [n, line] of lines(text).entries()) {
    const [dropbox, mega, size, kind] = line.split('\t')
    const bytes = Number(size)
    if (!dropbox || !mega || size === undefined || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(`line ${n + 1} of the manifest is not «Dropbox path, MEGA path, size, kind»`)
    }
    out.push({ dropbox, mega, size: bytes, kind: (kind ?? '').trim() })
  }
  return out
}
