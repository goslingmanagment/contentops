import { apiToLocalPath } from './local-path.ts'
import { relativePath } from './text.ts'

/**
 * The Windows listing of the local Я.Диск copy (`ops/winpc/ydisk-copy-list.ps1`, SPEC §12.2).
 * Through cifs the VM does not see the Cloud Files attributes, and reading a placeholder there
 * would make the client download it. So bytes come from the copy only for a file of the list
 * with its bytes on disk and the size the API reports; placeholders, partial, changed and
 * unlisted files go through the API (§6.3). The MD5 check against the API stays either way.
 */

/** File name on the host share (`/host/` in the containers). */
export const COPY_LIST_FILE = 'ydisk-copy-list.jsonl'

/** One line of the list. */
export interface CopyListEntry {
  /** Relative to the copy root, `/` separators, names as on disk. */
  path: string
  is_dir: boolean
  size: number
  last_write_utc: string
  /** Raw Win32 attributes from the directory enumeration. */
  attributes: number
  /** Files: none of RECALL_ON_DATA_ACCESS, RECALL_ON_OPEN, OFFLINE, SPARSE_FILE. */
  bytes_present?: boolean
  /** Directories: enumerated (false: not populated by the client, an error). */
  listed?: boolean
}

/** A file of the copy as the list saw it. */
export interface CopyFile {
  /** As on disk, relative to the copy root: join with `LEGACY_SOURCE_ROOT` to read. */
  localPath: string
  size: number
  bytesPresent: boolean
  attributes: number
}

const isInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

/** JSON Lines → entries; a malformed line throws with its number (a list is all or nothing). */
export function parseCopyList(text: string): CopyListEntry[] {
  const entries: CopyListEntry[] = []
  const lines = text.split('\n')
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim()
    if (line === '') continue
    let e: Partial<CopyListEntry>
    try {
      e = JSON.parse(line) as Partial<CopyListEntry>
    } catch {
      throw new Error(`copy list line ${i + 1}: not JSON`)
    }
    const ok =
      typeof e === 'object' &&
      e !== null &&
      typeof e.path === 'string' &&
      e.path !== '' &&
      typeof e.is_dir === 'boolean' &&
      isInt(e.size) &&
      isInt(e.attributes) &&
      typeof e.last_write_utc === 'string' &&
      (e.is_dir ? typeof e.listed === 'boolean' : typeof e.bytes_present === 'boolean')
    if (!ok) throw new Error(`copy list line ${i + 1}: not an entry of the copy list`)
    entries.push(e as CopyListEntry)
  }
  return entries
}

/** Files of the list by copy path: answers «bytes on disk? size?» for an API path. */
export class CopyList {
  /** `null`: two names on disk with one NFC form — neither is trusted. */
  private readonly files = new Map<string, CopyFile | null>()

  constructor(entries: Iterable<CopyListEntry>) {
    for (const e of entries) {
      if (e.is_dir) continue
      const key = relativePath(e.path)
      const file: CopyFile = {
        localPath: e.path,
        size: e.size,
        bytesPresent: e.bytes_present === true,
        attributes: e.attributes,
      }
      this.files.set(key, this.files.has(key) ? null : file)
    }
  }

  static parse(text: string): CopyList {
    return new CopyList(parseCopyList(text))
  }

  get size(): number {
    return this.files.size
  }

  /** The copy file of an API path (`disk:/…` or root-relative); `null` — not in the list. */
  fileOf(apiPath: string): CopyFile | null {
    return this.files.get(apiToLocalPath(apiPath)) ?? null
  }

  /** The copy may be read for this API file: listed, bytes on disk, the size the API reports. */
  readable(apiPath: string, apiSize: number): CopyFile | null {
    const file = this.fileOf(apiPath)
    return file?.bytesPresent && file.size === apiSize ? file : null
  }
}
