import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Db, enqueueWork, SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { runToolChecked, sha256File, toolPaths } from '@contentops/media'
import { sql } from 'drizzle-orm'
import sharp from 'sharp'
import type { BlobStore } from '../media/storage'
import { shaBytes } from '../media/storage'
import { registerBlob } from '../media/storage-ops'
import type { FixtureFile, FixtureItem } from './catalog-factory'

/**
 * Real bytes for the fictional catalog (PLAN 2б, dev stand and the pilot's test runs before
 * stage 3): short videos and photos drawn by FFmpeg and sharp — test patterns, fractals,
 * gradients, no people and no filming (owner 30.10.2026). They become blobs, the seeded
 * objects' files point at them, and `derive_video` / `derive_image` works are put for the
 * worker roles, so the library and the card show real thumbnails, previews and frames.
 */

interface SeedVideo {
  sha256: string
  durationS: number
  width: number
  height: number
  bytes: number
}

interface SeedPhoto {
  sha256: string
  width: number
  height: number
  bytes: number
}

export interface SeedMedia {
  videos: SeedVideo[]
  photos: SeedPhoto[]
}

/** Sources of the videos: FFmpeg's own generators, each in a vertical 1080×1920 frame. */
const VIDEO_SOURCES = [
  'testsrc2=size=1080x1920:rate=30',
  'mandelbrot=size=1080x1920:rate=30:maxiter=200',
  'gradients=size=1080x1920:rate=30:speed=0.02:c0=0x7a2e8c:c1=0xf2a65a:c2=0x1d4e89',
  'smptehdbars=size=1080x1920:rate=30',
  'life=size=540x960:rate=30:mold=10:ratio=0.15:death_color=#203040:life_color=#e07050,scale=1080:1920:flags=neighbor',
  'gradients=size=1080x1920:rate=30:speed=0.03:c0=0x0b6e4f:c1=0xe6c229:c2=0xd1495b',
  'cellauto=size=1080x1920:rate=30:rule=110,format=yuv420p,colorchannelmixer=rr=0.2:gg=0.6:bb=0.9',
  'zoneplate=size=1080x1920:rate=30:kx2=200:ky2=200:kt2=1',
] as const

const PALETTES: readonly [string, string, string][] = [
  ['#2b2d42', '#ef233c', '#edf2f4'],
  ['#264653', '#e9c46a', '#f4a261'],
  ['#1d3557', '#a8dadc', '#e63946'],
  ['#3a0ca3', '#f72585', '#4cc9f0'],
  ['#283618', '#dda15e', '#fefae0'],
  ['#14213d', '#fca311', '#e5e5e5'],
  ['#6d597a', '#eaac8b', '#355070'],
  ['#0b3954', '#bfd7ea', '#ff5a5f'],
]

async function makeVideo(dir: string, index: number, seconds: number): Promise<string> {
  const source = VIDEO_SOURCES[index % VIDEO_SOURCES.length] as string
  const [generator, ...after] = source.split(',')
  const out = join(dir, `pattern-${index}.mp4`)
  await runToolChecked(toolPaths().ffmpeg, [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    generator as string,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${220 + index * 55}:sample_rate=48000`,
    '-t',
    String(seconds),
    ...(after.length > 0 ? ['-filter:v', after.join(',')] : []),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '26',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-movflags',
    '+faststart',
    '-metadata',
    'make=FixtureCam',
    out,
  ])
  return out
}

async function makePhoto(dir: string, index: number): Promise<string> {
  const [a, b, c] = PALETTES[index % PALETTES.length] as [string, string, string]
  const w = 1500
  const h = 2000
  const cx = 300 + ((index * 271) % 900)
  const cy = 400 + ((index * 389) % 1200)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="${index % 2}" y2="1">
      <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${cx}" cy="${cy}" r="${260 + (index % 5) * 40}" fill="${c}" fill-opacity="0.85"/>
    <rect x="${(cx + 500) % w}" y="${(cy + 700) % h}" width="420" height="420" fill="${a}" fill-opacity="0.6"
      transform="rotate(${index * 17} ${(cx + 710) % w} ${(cy + 910) % h})"/>
  </svg>`
  const out = join(dir, `photo-${index}.jpg`)
  await sharp(Buffer.from(svg))
    .jpeg({ quality: 88 })
    .withExif({ IFD0: { Make: 'FixtureCam', Model: 'Pattern 48' } })
    .toFile(out)
  return out
}

/** Draws the files once and registers them as blobs (`storage_operations.put`). */
export async function prepareSeedMedia(
  db: Db,
  store: BlobStore,
  options: { videos?: number; photos?: number; seconds?: number } = {},
): Promise<SeedMedia> {
  const dir = await mkdtemp(join(tmpdir(), 'contentops-seed-media-'))
  await mkdir(dir, { recursive: true })
  const seconds = options.seconds ?? 12
  try {
    const videos: SeedVideo[] = []
    for (let i = 0; i < (options.videos ?? VIDEO_SOURCES.length); i++) {
      const path = await makeVideo(dir, i, seconds)
      const sha256 = await sha256File(path)
      await registerBlob(db, store, {
        file: path,
        sha256,
        ext: 'mp4',
        mediaKind: 'video',
        owner: 'seed:media',
      })
      videos.push({
        sha256,
        durationS: seconds,
        width: 1080,
        height: 1920,
        bytes: (await stat(path)).size,
      })
    }
    const photos: SeedPhoto[] = []
    for (let i = 0; i < (options.photos ?? 16); i++) {
      const path = await makePhoto(dir, i)
      const sha256 = await sha256File(path)
      await registerBlob(db, store, {
        file: path,
        sha256,
        ext: 'jpg',
        mediaKind: 'image',
        owner: 'seed:media',
      })
      photos.push({ sha256, width: 1500, height: 2000, bytes: (await stat(path)).size })
    }
    return { videos, photos }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Points the files of the seeded objects at the drawn bytes, round robin: videos for
 * masters, teasers, clips and raw videos, photos for the rest. Versions beyond the current
 * one keep random hashes (only the current version is shown).
 */
export function withSeedMedia(items: readonly FixtureItem[], media: SeedMedia): FixtureItem[] {
  let v = 0
  let p = 0
  return items.map((item) => ({
    ...item,
    files: item.files?.map((file): FixtureFile => {
      const video =
        (file.media ?? (['master', 'teaser', 'clip'].includes(file.role) ? 'video' : 'image')) ===
        'video'
      const versions = file.versions ?? 1
      const random = (file.sha256 ?? []).slice(0, versions - 1)
      if (video) {
        const pick = media.videos[v++ % media.videos.length] as SeedVideo
        return {
          ...file,
          sha256: [
            ...random,
            ...Array.from({ length: versions - 1 - random.length }, () => randomSha()),
            shaBytes(pick.sha256),
          ],
          durationS: pick.durationS,
          width: pick.width,
          height: pick.height,
          bytes: pick.bytes,
          ext: 'mp4',
          mime: 'video/mp4',
        }
      }
      const pick = media.photos[p++ % media.photos.length] as SeedPhoto
      return {
        ...file,
        sha256: [
          ...random,
          ...Array.from({ length: versions - 1 - random.length }, () => randomSha()),
          shaBytes(pick.sha256),
        ],
        width: pick.width,
        height: pick.height,
        bytes: pick.bytes,
        ext: 'jpg',
        mime: 'image/jpeg',
      }
    }),
  }))
}

function randomSha(): Buffer {
  return randomBytes(32)
}

/** Renditions of the drawn bytes are built by the worker roles: one work per blob. */
export async function enqueueSeedRenditions(
  db: Db,
  model: string,
  media: SeedMedia,
): Promise<number> {
  return withActorTx(
    db,
    { actor: SYSTEM_ACTOR('фикстуры'), action: 'fixtures.media', requestId: randomUUID() },
    async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(
        sql`SELECT id FROM models WHERE code = ${model}`,
      )
      const modelId = rows[0]?.id
      if (!modelId) throw new Error(`no model ${model}`)
      let count = 0
      for (const [kind, list] of [
        ['derive_video', media.videos],
        ['derive_image', media.photos],
      ] as const) {
        for (const blob of list) {
          await enqueueWork(tx, {
            modelId,
            kind,
            workKey: `derive:${blob.sha256}`,
            inputSha256: shaBytes(blob.sha256),
            priority: 100,
          })
          count++
        }
      }
      return count
    },
  )
}
