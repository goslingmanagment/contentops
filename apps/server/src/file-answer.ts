import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
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

export async function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  answer: FileAnswer,
  direct: boolean,
): Promise<FastifyReply> {
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
    // Without nginx the video seeks too: one byte range, as nginx answers it.
    const size = file.bytes ?? (await stat(file.path)).size
    reply.header('accept-ranges', 'bytes')
    const range = byteRange(request.headers.range, size)
    if (range === 'unsatisfiable') {
      return reply.code(416).header('content-range', `bytes */${size}`).send('')
    }
    if (range) {
      reply.header('content-range', `bytes ${range.start}-${range.end}/${size}`)
      reply.header('content-length', String(range.end - range.start + 1))
      return reply.code(206).send(createReadStream(file.path, range))
    }
    reply.header('content-length', String(size))
    return reply.code(200).send(createReadStream(file.path))
  }
  reply.header('x-accel-redirect', file.accel)
  return reply.code(200).send('')
}

/** `Range: bytes=a-b`, `a-`, `-n` of one range (RFC 9110 §14.1.2); others are served whole. */
export function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '')
  if (!match || (match[1] === '' && match[2] === '')) return null
  const [first, last] = [match[1] as string, match[2] as string]
  const start = first === '' ? Math.max(0, size - Number(last)) : Number(first)
  const end = first === '' || last === '' ? size - 1 : Math.min(Number(last), size - 1)
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}
