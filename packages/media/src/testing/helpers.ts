import { execFileSync } from 'node:child_process'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { detectToolVersions, type ToolVersions } from '../tools.ts'

let counter = 0
/** A fresh, empty directory for one test. */
export async function freshDir(label = 'out'): Promise<string> {
  const dir = join(
    tmpdir(),
    'contentops-media-tests',
    `${process.pid}-${Date.now()}-${counter++}-${label}`,
  )
  await mkdir(dir, { recursive: true })
  return dir
}

/** Every file below `dir`, relative, sorted (dot-files included). */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort()
}

let versions: Promise<ToolVersions> | undefined
export function toolVersions(): Promise<ToolVersions> {
  versions ??= detectToolVersions()
  return versions
}

/** Fake versions for pure tests. */
export const FAKE_VERSIONS: ToolVersions = {
  ffmpeg: 'n8.1.2-50-g1a748fe2cd-20260831',
  ffprobe: 'n8.1.2-50-g1a748fe2cd-20260831',
  svtav1: 'v4.2.0-73-gfb0ed7e59',
  libvips: '8.16.1',
  sharp: '0.34.2',
  libheif: '1.23.6-2~deb13u1',
  libde265: '1.0.15-1+deb13u2',
  libwebp: '1.5.0-0.1',
  phash: 'sharp-phash@2.2.0',
}

/** Command lines of live processes that mention `text` (`/proc` in the image, `ps` elsewhere). */
export async function processesMentioning(text: string): Promise<string[]> {
  const pids = await readdir('/proc').catch(() => null)
  if (!pids) {
    return execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.includes(text))
  }
  const found: string[] = []
  for (const pid of pids.filter((p) => /^\d+$/.test(p))) {
    const cmd = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')
    if (cmd.includes(text)) found.push(cmd.replaceAll('\0', ' ').trim())
  }
  return found
}
