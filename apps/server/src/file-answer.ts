import { createReadStream } from 'node:fs'
import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * A handler's answer that is a file (SPEC §9.1, §11.2): `web` checks the rights, then nginx
 * sends the bytes from an internal location named in `X-Accel-Redirect`. Development and
 * tests without nginx (`FILES_DIRECT=1`) stream the file from `web` itself.
 */
export class FileAnswer {
  readonly file: FileAnswerInit

  constructor(file: FileAnswerInit) {
    this.file = file
  }
}

export interface FileAnswerInit {
  /** Internal nginx address: `/_accel/derived/gen/<id>/thumb-640.webp`. */
  accel: string
  /** Absolute path, for direct sending without nginx. */
  path: string
  mime: string
  bytes?: number
  /** Strong validator: the SHA-256 of the bytes. */
  etag?: string
  /** The address never serves other bytes (rendition generations). */
  immutable?: boolean
  /** Download name (`Content-Disposition: attachment`). */
  downloadName?: string
}

/** RFC 6266: an ASCII fallback and the exact UTF-8 name. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  answer: FileAnswer,
  direct: boolean,
): FastifyReply {
  const file = answer.file
  const etag = file.etag ? `"${file.etag}"` : undefined
  reply.header(
    'cache-control',
    file.immutable ? 'private, max-age=31536000, immutable' : 'private, no-cache',
  )
  if (etag) reply.header('etag', etag)
  if (file.downloadName) reply.header('content-disposition', contentDisposition(file.downloadName))
  if (etag && request.headers['if-none-match'] === etag) return reply.code(304).send()
  reply.header('content-type', file.mime)
  if (direct) {
    if (file.bytes !== undefined) reply.header('content-length', String(file.bytes))
    return reply.code(200).send(createReadStream(file.path))
  }
  reply.header('x-accel-redirect', file.accel)
  return reply.code(200).send('')
}
