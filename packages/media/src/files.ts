import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Streaming SHA-256 of a file. */
export async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal, highWaterMark: 1 << 20 })) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/**
 * A dot-prefixed name next to the final file: same directory, same filesystem, so the
 * caller's rename is atomic and a crash leaves only an obviously temporary file.
 */
export function tempPathIn(dir: string, label: string, ext: string): string {
  return join(dir, `.${label}-${randomBytes(6).toString('hex')}.partial${ext}`)
}

export async function removeQuietly(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true }).catch(() => undefined)
}

/** Keeps the source date on a derived file (SPEC §9.2: «дату съёмки и mtime»). */
export async function copyMtime(from: string, to: string): Promise<void> {
  const s = await stat(from, { bigint: true })
  // Seconds as doubles keep sub-millisecond precision (a Date would cut it to whole ms).
  await utimes(to, Number(s.atimeNs) / 1e9, Number(s.mtimeNs) / 1e9)
}

/** Moves a finished temp file to its name inside the same directory. */
export async function publishWithin(tempPath: string, name: string): Promise<string> {
  const target = join(dirname(tempPath), name)
  await mkdir(dirname(target), { recursive: true })
  await rename(tempPath, target)
  return target
}

export function extOf(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/**
 * Collects paths created by a job so that a failure or an abort removes all of them and
 * nothing half-written stays behind (PLAN 2б).
 */
export class Scratch {
  readonly #paths: string[] = []
  track(path: string): string {
    this.#paths.push(path)
    return path
  }
  release(path: string): void {
    const i = this.#paths.indexOf(path)
    if (i >= 0) this.#paths.splice(i, 1)
  }
  async cleanup(): Promise<void> {
    for (const path of this.#paths.splice(0).reverse()) await removeQuietly(path)
  }
}
