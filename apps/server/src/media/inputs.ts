import type { Queryable } from '@contentops/db'
import { WorkError } from '@contentops/db'
import {
  type FfprobeJson,
  type PhotoProbe,
  parseFfprobe,
  probePhoto,
  probeVideo,
  type VideoProbe,
} from '@contentops/media'
import { sql } from 'drizzle-orm'
import type { MediaEnv } from './pipeline'
import { shaBytes, shaHex } from './storage'

/**
 * Input bytes of a media work are named by `work_operations.input_sha256` and found in one
 * of two places: a blob in `blobs/` (a master, a web upload) or the staged source in
 * `TMP_ROOT/staging/<sha256>.<ext>` that intake leaves after fetching and checking it
 * (SPEC §9.1). Nothing else is read: never a path under `/mnt` (SPEC §12.0).
 */
export interface MediaInput {
  sha256: string
  path: string
  ext: string
  /** `blob` — registered bytes; `staging` — a source before its master. */
  from: 'blob' | 'staging'
  mediaKind: 'video' | 'image' | null
}

export async function locateInput(env: MediaEnv, sha: Buffer | string): Promise<MediaInput> {
  const hex = shaHex(sha)
  const { rows } = await env.db.execute<{ storage_key: string; ext: string; media_kind: string }>(
    sql`SELECT storage_key, ext, media_kind FROM blobs
         WHERE sha256 = ${shaBytes(hex)} AND state = 'present'`,
  )
  const blob = rows[0]
  if (blob && (await env.store.exists(blob.storage_key))) {
    return {
      sha256: hex,
      path: env.store.path(blob.storage_key),
      ext: blob.ext,
      from: 'blob',
      mediaKind: blob.media_kind as 'video' | 'image',
    }
  }
  const staged = await env.store.staged(hex)
  if (staged)
    return { sha256: hex, path: staged.path, ext: staged.ext, from: 'staging', mediaKind: null }
  // The bytes may come back (a fetch retried, a blob put again): retry later, then give up.
  throw new WorkError('transient', 'input_missing', `bytes ${hex.slice(0, 12)}… are not on disk`)
}

interface ProbeRow extends Record<string, unknown> {
  raw: { ffprobe?: FfprobeJson; sizeBytes?: number; photo?: PhotoProbe } | null
}

/**
 * ffprobe of a video, once per bytes and ffprobe build (`blob_probes`, SPEC §12.0): the
 * cached JSON is parsed again, so the typed result never drifts from a fresh probe.
 */
export async function probeVideoCached(
  env: MediaEnv,
  input: MediaInput,
  signal?: AbortSignal,
): Promise<VideoProbe> {
  const sha = shaBytes(input.sha256)
  const digest = env.recipes.probeVideo.digest
  const { rows } = await env.db.execute<ProbeRow>(sql`
    SELECT raw FROM blob_probes WHERE sha256 = ${sha} AND kind = 'ffprobe' AND recipe_digest = ${digest}`)
  const cached = rows[0]?.raw
  if (cached?.ffprobe && cached.sizeBytes !== undefined) {
    return parseFfprobe(cached.ffprobe, cached.sizeBytes)
  }
  const probe = await probeVideo(input.path, { signal })
  await saveVideoProbe(env.db, sha, digest, probe)
  return probe
}

export async function saveVideoProbe(
  q: Queryable,
  sha: Buffer,
  digest: string,
  probe: VideoProbe,
): Promise<void> {
  const v = probe.video
  await q.execute(sql`
    INSERT INTO blob_probes (
      sha256, kind, recipe_digest, duration_ms, width, height, rotation, fps_num, fps_den,
      video_codec, pix_fmt, bit_rate, is_hdr, audio_tracks, shot_at, shot_at_local, shot_tz,
      camera, raw
    ) VALUES (
      ${sha}, 'ffprobe', ${digest}, ${probe.durationMs}, ${v.displayWidth}, ${v.displayHeight},
      ${v.rotation}, ${v.fpsNum}, ${v.fpsDen}, ${v.codec}, ${v.pixFmt}, ${Math.round(probe.bitRate)},
      ${v.isHdr}, ${JSON.stringify(probe.audio)}::jsonb, ${probe.shotAt}::timestamptz,
      ${probe.shotAtLocal}::timestamp, ${probe.shotTz},
      ${probe.camera ? JSON.stringify(probe.camera) : null}::jsonb,
      ${JSON.stringify({ ffprobe: probe.raw, sizeBytes: probe.sizeBytes })}::jsonb
    )
    ON CONFLICT DO NOTHING`)
}

/** EXIF and size of a photo, once per bytes and reader build (`blob_probes`, kind `exif`). */
export async function probePhotoCached(env: MediaEnv, input: MediaInput): Promise<PhotoProbe> {
  const sha = shaBytes(input.sha256)
  const digest = env.recipes.probePhoto.digest
  const { rows } = await env.db.execute<ProbeRow>(sql`
    SELECT raw FROM blob_probes WHERE sha256 = ${sha} AND kind = 'exif' AND recipe_digest = ${digest}`)
  const cached = rows[0]?.raw?.photo
  if (cached) return cached
  const probe = await probePhoto(input.path)
  await savePhotoProbe(env.db, sha, digest, probe)
  return probe
}

export async function savePhotoProbe(
  q: Queryable,
  sha: Buffer,
  digest: string,
  probe: PhotoProbe,
): Promise<void> {
  await q.execute(sql`
    INSERT INTO blob_probes (
      sha256, kind, recipe_digest, width, height, rotation, shot_at, shot_at_local, shot_tz,
      camera, raw
    ) VALUES (
      ${sha}, 'exif', ${digest}, ${probe.width}, ${probe.height}, ${probe.rotation},
      ${probe.shotAt}::timestamptz, ${probe.shotAtLocal}::timestamp, ${probe.shotTz},
      ${probe.camera ? JSON.stringify(probe.camera) : null}::jsonb,
      ${JSON.stringify({ photo: probe })}::jsonb
    )
    ON CONFLICT DO NOTHING`)
}
