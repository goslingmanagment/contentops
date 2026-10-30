import { z } from 'zod'
import { defineRoute } from '../route'

/**
 * Bytes of a model (SPEC §9.1, §11.2): there is no route to bytes by hash without a model.
 * The answer is the file itself — `web` checks the rights and answers with
 * `X-Accel-Redirect` to an internal nginx location; nginx sends the bytes (`sendfile`).
 */
export const FileBodySchema = z
  .string()
  .meta({ description: 'Файл: байты отдаёт nginx по X-Accel-Redirect', format: 'binary' })

export const mediaRoutes = {
  /**
   * A rendition file of a generation: `preview.mp4`, `poster.webp`, `thumb-640.webp`,
   * `preview-2048.webp`, `platform.mp4`. The address never serves other bytes: immutable,
   * with an ETag.
   */
  file: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/g/{generation}/{name}',
    response: FileBodySchema,
  }),
  /** An annotation frame of a generation: `frames/0042.webp`. */
  frame: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/g/{generation}/frames/{frame}',
    response: FileBodySchema,
  }),
  /**
   * `download_url` of a download (step two): the issued file or ZIP under its name from
   * the receipt (`Content-Disposition`); an issue with new bytes lives a day.
   */
  download: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/downloads/{receipt}',
    response: FileBodySchema,
  }),
}
