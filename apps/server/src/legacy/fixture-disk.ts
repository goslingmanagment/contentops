import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LegacyListingEntry } from '@contentops/legacy'
import type { FakeTree } from '@contentops/sources/testing'
import { writeZip } from '../media/zip'

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
