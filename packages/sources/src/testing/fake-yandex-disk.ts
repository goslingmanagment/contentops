import {
  type FailureRule,
  FakeHttpServer,
  type LoggedRequest,
  MALFORMED_JSON,
  type Reply,
  rangeReply,
} from './fake-server.ts'
import { type FakeNode, FakeTree, md5Hex, sha256Hex } from './fake-tree.ts'

export interface FakeYandexDiskOptions {
  token?: string
  totalSpace?: number
  /** Used space; the sum of file sizes by default. */
  usedSpace?: number
  tree?: FakeTree
}

/**
 * Fake Yandex Disk REST (`cloud-api.yandex.net`) over an in-memory tree: `/v1/disk`,
 * `/v1/disk/resources` with `offset/limit` paging, `last-uploaded`, `download` (an href to
 * `/dl/<id>` with Range) and `preview` links. Any other method or path answers 405/404 and
 * is logged, so a test can prove the client never tried.
 */
export class FakeYandexDisk extends FakeHttpServer {
  readonly tree: FakeTree
  token: string
  totalSpace: number
  usedSpace: number | null
  /** Download host answers 200 with the whole file even when asked for a range. */
  ignoreRange = false

  constructor(o: FakeYandexDiskOptions = {}) {
    super()
    this.tree = o.tree ?? new FakeTree({ idPrefix: '4000000:' })
    this.token = o.token ?? 'yandex-test-token'
    this.totalSpace = o.totalSpace ?? 1_000_000_000
    this.usedSpace = o.usedSpace ?? null
  }

  protected endpointOf(_method: string, pathname: string): string {
    if (pathname.startsWith('/dl/')) return 'download'
    if (pathname.startsWith('/preview/')) return 'preview'
    return pathname
  }

  protected failure(rule: FailureRule): Reply {
    switch (rule.kind) {
      case 'rate_limit':
        return {
          status: 429,
          headers: { 'retry-after': String(rule.retryAfter ?? 1) },
          body: error('TooManyRequestsError', 'Слишком много запросов.'),
        }
      case 'server_error':
        return {
          status: 503,
          body: error('ServiceUnavailableError', 'Сервис временно недоступен.'),
        }
      case 'unauthorized':
        return { status: 401, body: error('UnauthorizedError', 'Не авторизован.') }
      case 'forbidden':
        return { status: 403, body: error('ForbiddenError', 'Нет доступа.') }
      default:
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: MALFORMED_JSON,
        }
    }
  }

  protected handle(req: LoggedRequest): Reply {
    if (req.endpoint === 'download') return this.#download(req)
    const authorized = req.headers.authorization === `OAuth ${this.token}`
    if (!authorized) return { status: 401, body: error('UnauthorizedError', 'Не авторизован.') }
    if (req.method !== 'GET') {
      return { status: 405, body: error('MethodNotAllowedError', 'Fake: read-only.') }
    }
    switch (req.endpoint) {
      case '/v1/disk':
        return {
          status: 200,
          body: {
            total_space: this.totalSpace,
            used_space: this.usedSpace ?? this.tree.usedBytes(),
            trash_size: 0,
            is_paid: false,
          },
        }
      case '/v1/disk/resources':
        return this.#resources(req)
      case '/v1/disk/resources/last-uploaded': {
        const limit = Number(req.query.get('limit') ?? 20)
        const items = this.tree
          .files()
          .sort((a, b) => b.created.getTime() - a.created.getTime())
          .slice(0, limit)
          .map((n) => this.resource(n))
        return { status: 200, body: { items, limit } }
      }
      case '/v1/disk/resources/download': {
        const node = this.tree.get(req.query.get('path') ?? '')
        if (!node) return notFound()
        if (node.isDir) return { status: 400, body: error('DiskNotFileError', 'Not a file.') }
        return {
          status: 200,
          body: {
            href: `${this.url}/dl/${encodeURIComponent(node.id)}`,
            method: 'GET',
            templated: false,
          },
        }
      }
      case 'preview': {
        const id = decodeURIComponent(req.path.slice('/preview/'.length))
        const node = this.tree.getById(id)
        if (!node) return notFound()
        return {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
          body: Buffer.from(`fake-preview:${id}:${req.query.get('size')}`),
        }
      }
      default:
        return { status: 404, body: error('NotFoundError', `Fake: no ${req.path}`) }
    }
  }

  /** The API's view of a node. */
  resource(n: FakeNode): Record<string, unknown> {
    const base: Record<string, unknown> = {
      name: n.name,
      path: `disk:${n.path}`,
      type: n.isDir ? 'dir' : 'file',
      resource_id: n.id,
      created: n.created.toISOString().replace('.000Z', '+00:00'),
      modified: n.modified.toISOString().replace('.000Z', '+00:00'),
      revision: Number.parseInt(n.rev, 16),
    }
    if (n.path === '/') base.name = 'disk'
    if (n.isDir || !n.bytes) return base
    const previewable = n.mediaType === 'image' || n.mediaType === 'video'
    return {
      ...base,
      size: n.bytes.length,
      md5: md5Hex(n.bytes),
      sha256: sha256Hex(n.bytes),
      media_type: n.mediaType ?? 'unknown',
      mime_type: n.mimeType ?? 'application/octet-stream',
      ...(previewable
        ? { preview: `${this.url}/preview/${encodeURIComponent(n.id)}?size=S&crop=0` }
        : {}),
      ...(n.shotAt
        ? { exif: { date_time: n.shotAt.toISOString().replace('.000Z', '+00:00') } }
        : { exif: {} }),
    }
  }

  #resources(req: LoggedRequest): Reply {
    const node = this.tree.get(req.query.get('path') ?? '')
    if (!node) return notFound()
    const body = this.resource(node)
    if (node.isDir) {
      const limit = Number(req.query.get('limit') ?? 20)
      const offset = Number(req.query.get('offset') ?? 0)
      const children = this.tree.children(node.path)
      body._embedded = {
        items: children.slice(offset, offset + limit).map((c) => this.resource(c)),
        limit,
        offset,
        total: children.length,
        path: body.path,
        sort: '',
      }
    }
    return { status: 200, body }
  }

  #download(req: LoggedRequest): Reply {
    const node = this.tree.getById(decodeURIComponent(req.path.slice('/dl/'.length)))
    if (!node?.bytes) return { status: 404, body: '' }
    const range = this.ignoreRange ? undefined : (req.headers.range as string | undefined)
    return rangeReply(node.bytes, range, {
      'content-type': node.mimeType ?? 'application/octet-stream',
    })
  }
}

function error(code: string, message: string): Record<string, string> {
  return { message, description: message, error: code }
}

function notFound(): Reply {
  return { status: 404, body: error('DiskNotFoundError', 'Не удалось найти запрошенный ресурс.') }
}

export async function startFakeYandexDisk(o: FakeYandexDiskOptions = {}): Promise<FakeYandexDisk> {
  return new FakeYandexDisk(o).start()
}
