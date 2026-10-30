/**
 * Manual live check of the Yandex Disk client — read-only, never in CI. Prints counts only:
 * no names, paths or tokens.
 *
 *   node packages/sources/scripts/live-smoke.ts [--root disk:/] [--keychain-account ydisk]
 *
 * The token comes from YANDEX_DISK_TOKEN or the macOS Keychain (service `ydisk-audit`).
 * It lists one folder (the root by default) and stops; `recent` asks for 20 files; the
 * smallest file seen (up to 20 MB) is downloaded into a temp dir — aborted after
 * the first chunk and resumed with Range — verified and deleted.
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createYandexDiskSource, downloadVerified, type SourceEntry } from '../src/index.ts'

const { values } = parseArgs({
  options: {
    root: { type: 'string', default: 'disk:/' },
    'keychain-account': { type: 'string', default: 'ydisk' },
  },
})

function token(): string {
  if (process.env.YANDEX_DISK_TOKEN) return process.env.YANDEX_DISK_TOKEN
  return execFileSync(
    '/usr/bin/security',
    ['find-generic-password', '-s', 'ydisk-audit', '-a', values['keychain-account'], '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim()
}

const src = createYandexDiskSource({ token: token(), root: values.root, recentLimit: 20 })

const space = await src.space()
console.log(`space: used ${(space.usedRatio * 100).toFixed(1)} %, line shown: ${space.nearlyFull}`)

const recent = await src.recent(null)
const count = (list: SourceEntry[], pick: (e: SourceEntry) => unknown) => list.filter(pick).length
const has = (list: SourceEntry[]) =>
  `${count(list, (e) => e.id)} with resource_id, ${count(list, (e) => e.md5)} with md5, ` +
  `${count(list, (e) => e.sha256)} with sha256`
console.log(`recent: ${recent.entries.length} under the root of 20 asked (${has(recent.entries)})`)

const seen: SourceEntry[] = []
for await (const event of src.traverse()) {
  if (event.type === 'entry') seen.push(event.entry)
  if (event.type === 'dir') {
    const files = seen.filter((e) => !e.isDir)
    console.log(
      `traverse, first folder: ${event.children} children, complete ${event.complete}; ` +
        `${files.length} files, ${seen.length - files.length - 1} folders (${has(files)}, ` +
        `${count(files, (e) => e.createdAt)} with created, ` +
        `${count(files, (e) => e.shotAt)} with exif time, ` +
        `${count(files, (e) => e.previewUrl)} with preview)`,
    )
    break
  }
}

const small = [...seen, ...recent.entries]
  .filter((e) => !e.isDir && e.size != null && e.size > 0 && e.size <= 20_000_000)
  .sort((a, b) => (a.size ?? 0) - (b.size ?? 0))[0]
if (small) {
  const dir = await mkdtemp(join(tmpdir(), 'sources-smoke-'))
  try {
    const ac = new AbortController()
    await downloadVerified(src, small, {
      targetDir: dir,
      fileName: 'smoke.bin',
      signal: ac.signal,
      onProgress: () => ac.abort(),
    }).catch(() => undefined)
    const r = await downloadVerified(src, small, { targetDir: dir, fileName: 'smoke.bin' })
    console.log(
      r.status === 'verified'
        ? `download: verified (md5 and sha256 match), resumed from byte ${r.resumedFrom}`
        : `download: ${r.status}`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
