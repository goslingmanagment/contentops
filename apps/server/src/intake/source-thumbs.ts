import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Db } from '@contentops/db'
import { type SourceEntry, sourcePath } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { isUuid } from '../commands'
import type { Authenticate } from '../context'
import { ApiProblem } from '../errors'
import { type SourceFactory, sourceById } from './source-client'

/**
 * The source's own picture of a draft (SPEC §6.1 «картинка источника»: Yandex preview,
 * Dropbox `get_thumbnail_v2`) for «Приехало» until our previews exist. Read-only calls of
 * the source; the answer is kept in `TMP_ROOT/source-thumbs` by revision, so a list does not
 * ask the cloud again. Access is the model's: the same rule as the routes under `/{model}`.
 */

export function sourceThumbPath(model: string, draftId: string): string {
  return `/api/v1/${model}/inbox/thumbs/${draftId}`
}

interface ThumbOptions {
  db: Db
  authenticate: Authenticate
  factory: SourceFactory
  /** `TMP_ROOT`; without it nothing is cached. */
  cacheDir?: string
}

export function registerSourceThumbs(app: FastifyInstance, options: ThumbOptions): void {
  app.get<{ Params: { model: string; draft: string } }>(
    '/api/v1/:model/inbox/thumbs/:draft',
    { schema: { hide: true } },
    async (request, reply) => {
      const actor = await options.authenticate(request)
      if (!actor) throw new ApiProblem('unauthenticated', 'Нужно войти')
      const { model, draft } = request.params
      if (actor.role !== 'owner' && !actor.models.includes(model)) {
        throw new ApiProblem('forbidden', 'Нет доступа к этой модели')
      }
      if (!isUuid(draft)) throw new ApiProblem('not_found', 'Такого файла нет')
      const { rows } = await options.db.execute<{
        revision_id: string
        source_id: string
        resource_id: string
        current_path: string
        name: string
      }>(sql`
        SELECT r.id AS revision_id, o.source_id, o.resource_id, o.current_path, o.current_name AS name
          FROM inbox_drafts d
          JOIN models m ON m.id = d.model_id AND m.code = ${model}
          JOIN source_revisions r ON r.model_id = d.model_id AND r.id = d.source_revision_id
          JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
         WHERE d.id = ${draft}::uuid`)
      const [row] = rows
      if (!row) throw new ApiProblem('not_found', 'Такого файла нет')
      const cached = options.cacheDir
        ? join(options.cacheDir, 'source-thumbs', row.revision_id)
        : null
      if (cached) {
        const hit = await readFile(cached).catch(() => null)
        if (hit)
          return send(
            reply,
            hit,
            (await readFile(`${cached}.type`, 'utf8').catch(() => null)) ?? 'image/jpeg',
          )
      }
      const source = await sourceById(options.db, row.source_id)
      const client = source ? options.factory(source) : null
      if (!source || !client) throw new ApiProblem('not_found', 'Картинки источника нет')
      // Yandex hands out a preview link with the metadata; Dropbox draws by id.
      const entry: SourceEntry =
        source.kind === 'yandex_disk'
          ? await client.stat({ path: row.current_path })
          : {
              source: 'dropbox',
              id: row.resource_id,
              isDir: false,
              name: row.name,
              path: sourcePath(row.current_path, client.root),
              parentPath: null,
              size: null,
              md5: null,
              sha256: null,
              contentHash: null,
              rev: null,
              createdAt: null,
              modifiedAt: null,
              shotAt: null,
              mediaType: null,
              mimeType: null,
              previewUrl: null,
            }
      const picture = await client.thumbnail(entry, {
        size: source.kind === 'yandex_disk' ? 'M' : 'w480h320',
      })
      if (!picture) throw new ApiProblem('not_found', 'Картинки источника нет')
      const bytes = Buffer.from(picture.bytes)
      if (cached) {
        await mkdir(join(options.cacheDir as string, 'source-thumbs'), { recursive: true })
        await writeFile(`${cached}.type`, picture.contentType)
        await writeFile(`${cached}.part`, bytes)
        await rename(`${cached}.part`, cached)
      }
      return send(reply, bytes, picture.contentType)
    },
  )
}

function send(reply: import('fastify').FastifyReply, bytes: Buffer, type: string) {
  return reply
    .header('content-type', type)
    .header('cache-control', 'private, max-age=86400, immutable')
    .send(bytes)
}
