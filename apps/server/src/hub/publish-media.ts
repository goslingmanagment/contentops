import { createReadStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { type Db, enqueueWork, WorkError } from '@contentops/db'
import { stripPhotoMetadata, type ToolVersions } from '@contentops/media'
import { sql } from 'drizzle-orm'
import type { FileRow } from '../media/downloads'
import { currentDigests } from '../media/pipeline'
import { readyGeneration } from '../media/renditions'
import { type BlobStore, shaBytes, shaHex } from '../media/storage'
import { renderKey } from '../media/work/copies'

/**
 * The bytes a Hub publication uploads (SPEC §7, §9.3; naming §5–6): a video goes as its copy for
 * the platform (`platform.mp4`, metadata stripped — the same copy «Скачать для заливки» gives),
 * built by `render` when it is not there yet; a photo goes as its master without metadata.
 */

export interface PublishBytes {
  sha256: string
  size: number
  /** Frame and length of what goes out (the copy may be smaller than the master). */
  width: number | null
  height: number | null
  durationMs: number | null
  /** A fresh stream for every attempt of the upload. */
  open(): ReadableStream<Uint8Array>
  /** Removes what was built for the upload. */
  release(): Promise<void>
}

export interface PublishMedia {
  /** The bytes of the file as they go to the platform, or `building` — the copy is being made. */
  bytes(
    db: Db,
    input: { modelId: string; rowId: string; position: number; file: FileRow },
  ): Promise<PublishBytes | 'building'>
}

const stream = (path: string) => () =>
  Readable.toWeb(createReadStream(path, { highWaterMark: 1 << 20 })) as ReadableStream<Uint8Array>

async function blobPath(db: Db, store: BlobStore, master: Buffer): Promise<string> {
  const { rows } = await db.execute<{ storage_key: string }>(sql`
    SELECT storage_key FROM blobs WHERE sha256 = ${shaBytes(master)} AND state = 'present'`)
  const key = rows[0]?.storage_key
  if (!key || !(await store.exists(key))) {
    throw new WorkError('transient', 'input_missing', 'байты файла сейчас недоступны')
  }
  return store.path(key)
}

/** The product's bytes: platform copies from `derived/`, stripped photos in `TMP_ROOT`. */
export function storedMedia(store: BlobStore, versions?: ToolVersions): PublishMedia {
  return {
    async bytes(db, { modelId, rowId, position, file }) {
      if (file.media_kind === 'video') {
        const digests = await currentDigests(db)
        if (!digests) {
          throw new WorkError(
            'permanent',
            'pipeline_not_ready',
            'Медиаконвейер ещё не запускался: копию для платформы собрать некому',
          )
        }
        const ready = await readyGeneration(db, {
          kind: 'platform',
          recipeDigest: digests.platformStripped,
          metaStripped: true,
          masterSha256: file.master,
          inputSha256: file.master,
        })
        if (ready) {
          const { rows } = await db.execute<{
            storage_key: string
            output_sha256: Buffer
            byte_size: string
            width: number | null
            height: number | null
            duration_ms: string | null
          }>(sql`
            SELECT storage_key, output_sha256, byte_size, width, height, duration_ms
              FROM rendition_artifacts
             WHERE generation_id = ${ready.id}::uuid AND name = 'platform.mp4' AND state = 'ready'`)
          const artifact = rows[0]
          if (artifact) {
            return {
              sha256: shaHex(artifact.output_sha256),
              size: Number(artifact.byte_size),
              width: artifact.width ?? file.width,
              height: artifact.height ?? file.height,
              durationMs:
                artifact.duration_ms === null
                  ? file.duration_ms === null
                    ? null
                    : Number(file.duration_ms)
                  : Number(artifact.duration_ms),
              open: stream(store.path(artifact.storage_key)),
              release: async () => {},
            }
          }
        }
        // The copy is built the way «Скачать для заливки» builds it, then the work comes back.
        const { work } = await enqueueWork(db, {
          modelId,
          kind: 'render',
          workKey: renderKey(shaHex(file.master), digests.platformStripped),
          inputSha256: file.master,
          assetVersionId: file.version_id,
          scope: 'stripped',
          recipeDigest: digests.platformStripped,
          priority: 1_000_000,
        })
        if (work.state === 'failed' || work.state === 'cancelled') {
          throw new WorkError(
            'permanent',
            'copy_failed',
            `Копия для платформы не собралась: ${work.errorText ?? 'ошибка сборки'}`,
          )
        }
        return 'building'
      }
      const dir = join(store.roots.tmpRoot, 'hub', rowId, String(position))
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      const built = await stripPhotoMetadata({
        input: await blobPath(db, store, file.master),
        outDir: dir,
        ...(versions ? { versions } : {}),
      })
      return {
        sha256: built.file.sha256,
        size: built.file.bytes,
        width: built.file.width || file.width,
        height: built.file.height || file.height,
        durationMs: null,
        open: stream(built.file.path),
        release: () => rm(dir, { recursive: true, force: true }),
      }
    },
  }
}
