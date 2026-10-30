import { relativePath } from './text.ts'

/**
 * The local copy of Я.Диск (desktop client on NTFS, SPEC §6.3) keeps some names differently:
 * the copy path is the API path with `:` → `-` and a space at the end of any part → `-`
 * (349 files, 44 % of bytes, checked 30.09.2026). Only the bytes come from the copy; the
 * metadata stays with the API path.
 */

/** `disk:/3. Customs/13:03 tail .mov` → `3. Customs/13-03 tail .mov`. */
export function apiToLocalPath(apiPath: string): string {
  return relativePath(apiPath)
    .split('/')
    .map((part) => part.replaceAll(':', '-').replace(/ +$/u, (spaces) => '-'.repeat(spaces.length)))
    .join('/')
}

/** `LEGACY_SOURCE_ROOT` + the API path → the file in the copy (`/mnt/ydisk/…`). */
export function localCopyPath(root: string, apiPath: string): string {
  const base = root.replace(/[\\/]+$/u, '')
  return `${base}/${apiToLocalPath(apiPath)}`
}

/**
 * The way back is ambiguous — a `-` could have been written by the model — so it goes through
 * the listing: every API path of the snapshot under its copy path.
 */
export class LocalPathIndex {
  private readonly byLocal = new Map<string, string[]>()

  constructor(apiPaths: Iterable<string>) {
    for (const api of apiPaths) {
      const rel = relativePath(api)
      const local = apiToLocalPath(rel)
      const list = this.byLocal.get(local) ?? []
      if (!list.includes(rel)) list.push(rel)
      this.byLocal.set(local, list)
    }
  }

  /** API paths a copy path may stand for; more than one is a collision of the copy. */
  apiPathsOf(localPath: string, root = ''): string[] {
    let rel = localPath.replaceAll('\\', '/')
    const base = root.replaceAll('\\', '/').replace(/\/+$/u, '')
    if (base !== '' && rel.startsWith(`${base}/`)) rel = rel.slice(base.length + 1)
    return [...(this.byLocal.get(relativePath(rel)) ?? [])].sort()
  }
}
