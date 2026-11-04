import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type LegacyListingEntry, relativePath } from '@contentops/legacy'
import type { FakeTree } from '@contentops/sources/testing'
import { writeZip } from '../media/zip'
import type { SnapshotEntry } from './snapshot'

/**
 * A fictional old disk on the fake Yandex Disk (PLAN этап 3: fictional names in the shapes of
 * the real ones) for the tests and the dev stand (`scripts/dev-legacy.ts`).
 */

/** A stored ZIP of members with fixed bytes, as an archive of the old disk. */
export async function zipOf(members: Record<string, Buffer>): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'legacy-zip-'))
  try {
    const files = await Promise.all(
      Object.entries(members).map(async ([name, bytes], n) => {
        const path = join(dir, String(n))
        await writeFile(path, bytes)
        return { name, path }
      }),
    )
    await writeZip(join(dir, 'out.zip'), files)
    return await readFile(join(dir, 'out.zip'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const relative = (path: string) => path.replace(/^disk:\//, '')

/**
 * Plants a listing under `root`: folders, files of their size (equal md5 of the listing — equal
 * bytes), upload and shot times; `bytes` replaces the content of a path (archives).
 */
export function plantDisk(
  tree: FakeTree,
  root: string,
  listing: readonly LegacyListingEntry[],
  bytes: Record<string, Buffer> = {},
): void {
  for (const entry of listing) {
    const path = `${root}/${relative(entry.path)}`
    if (entry.isDir) {
      tree.addFolder(path)
      continue
    }
    const given = bytes[relative(entry.path)]
    const size = entry.size ?? 1000
    const content = given ?? (entry.md5 ? Buffer.alloc(size, entry.md5) : size)
    tree.addFile(path, content, {
      ...(entry.createdAt ? { created: new Date(entry.createdAt) } : {}),
      ...(entry.shotAt ? { shotAt: new Date(entry.shotAt) } : {}),
    })
  }
}

/**
 * A listing as a snapshot of it reads (`snapshot.ts`): the files with their ids and every folder
 * above them, by root-relative path — the input of the units of the dry run.
 */
export function snapshotListing(entries: readonly LegacyListingEntry[]): {
  listing: SnapshotEntry[]
  byPath: Map<string, SnapshotEntry>
} {
  const listing: SnapshotEntry[] = []
  const byPath = new Map<string, SnapshotEntry>()
  for (const entry of entries) {
    const relative = relativePath(entry.path)
    const row = {
      ...entry,
      path: relative,
      relative,
      raw: entry.path,
      objectId: `obj:${relative}`,
      revisionId: `rev:${relative}`,
      resourceId: `id:${relative}`,
    }
    listing.push(row)
    byPath.set(relative, row)
    const parts = relative.split('/')
    for (let n = 1; n < parts.length; n++) {
      const dir = parts.slice(0, n).join('/')
      if (byPath.has(dir)) continue
      const folder = {
        path: dir,
        relative: dir,
        raw: `/${dir}`,
        isDir: true,
        objectId: `obj:${dir}`,
        revisionId: null,
      }
      listing.push(folder)
      byPath.set(dir, folder)
    }
  }
  return { listing, byPath }
}
