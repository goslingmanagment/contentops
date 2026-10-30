import { headerJson } from '../dropbox.ts'
import { dropboxContentHash } from '../hashes.ts'
import {
  type FailureRule,
  FakeHttpServer,
  type LoggedRequest,
  MALFORMED_JSON,
  type Reply,
  rangeReply,
} from './fake-server.ts'
import { type FakeNode, FakeTree } from './fake-tree.ts'

export interface FakeDropboxOptions {
  token?: string
  /** Enables `oauth2/token` with this refresh token and app key. */
  refresh?: { refreshToken: string; appKey: string }
  allocated?: number
  used?: number
  /** `team` allocation instead of `individual`. */
  team?: boolean
  tree?: FakeTree
  /** A real JPEG for `get_thumbnail_v2` (a development stack); a text marker by default. */
  thumbnail?: (node: FakeNode) => Buffer | null
}

interface Cursor {
  /** Epoch: `resetCursors()` bumps it and old cursors answer `reset`. */
  e: number
  /** Lookup key of the listed folder. */
  k: string
  r: boolean
  /** Change sequence the cursor has seen. */
  s: number
  /** Offset inside the initial listing while it is being paged. */
  o?: number
  l: number
}

/**
 * Fake Dropbox API v2 (`api.dropboxapi.com` and `content.dropboxapi.com` on one server)
 * over an in-memory, case-insensitive tree: `list_folder` (+ `continue`, cursors, `reset`),
 * `get_latest_cursor`, `get_metadata`, `download` (Range, `rev:` paths, `Dropbox-API-Result`),
 * `get_thumbnail_v2`, `get_space_usage` and the `oauth2/token` refresh. Other endpoints
 * answer 404 and are logged.
 */
export class FakeDropbox extends FakeHttpServer {
  readonly tree: FakeTree
  token: string
  allocated: number
  used: number | null
  team: boolean
  #expired = false
  #epoch = 0
  #issued = 0
  readonly #refresh: FakeDropboxOptions['refresh']
  readonly #thumbnail: FakeDropboxOptions['thumbnail']

  constructor(o: FakeDropboxOptions = {}) {
    super()
    this.tree = o.tree ?? new FakeTree({ caseInsensitive: true, idPrefix: 'id:a4ayc_' })
    this.token = o.token ?? 'dropbox-test-token'
    this.allocated = o.allocated ?? 2_000_000_000
    this.used = o.used ?? null
    this.team = o.team ?? false
    this.#refresh = o.refresh
    this.#thumbnail = o.thumbnail
  }

  /** Old cursors answer `reset` from now on. */
  resetCursors(): void {
    this.#epoch++
  }

  /** The current access token answers `expired_access_token` until refreshed. */
  expireToken(): void {
    this.#expired = true
  }

  protected endpointOf(_method: string, pathname: string): string {
    if (pathname.startsWith('/2/')) return pathname.slice(3)
    return pathname.replace(/^\//, '')
  }

  protected failure(rule: FailureRule): Reply {
    switch (rule.kind) {
      case 'rate_limit': {
        const after = rule.retryAfter ?? 1
        return {
          status: 429,
          headers: { 'retry-after': String(after) },
          body: {
            error_summary: 'too_many_requests/',
            error: { reason: { '.tag': 'too_many_requests' }, retry_after: after },
          },
        }
      }
      case 'server_error':
        return {
          status: 500,
          headers: { 'content-type': 'text/plain' },
          body: 'Internal Server Error',
        }
      case 'unauthorized':
        return authError('invalid_access_token')
      case 'forbidden':
        return {
          status: 403,
          body: { error_summary: 'missing_scope/', error: { '.tag': 'missing_scope' } },
        }
      default:
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: MALFORMED_JSON,
        }
    }
  }

  protected handle(req: LoggedRequest): Reply {
    if (req.endpoint === 'oauth2/token') return this.#token(req)
    if (req.method !== 'POST') return { status: 405, body: 'Fake: POST only' }
    if (req.headers.authorization !== `Bearer ${this.token}`)
      return authError('invalid_access_token')
    if (this.#expired) return authError('expired_access_token')
    const argHeader = req.headers['dropbox-api-arg']
    let args: Record<string, unknown>
    try {
      const raw = typeof argHeader === 'string' ? argHeader : req.body
      args = (raw ? JSON.parse(raw) : null) ?? {}
    } catch {
      return { status: 400, body: 'Error in call: could not decode input as JSON' }
    }
    switch (req.endpoint) {
      case 'files/list_folder':
        return this.#listFolder(args)
      case 'files/list_folder/continue':
        return this.#continue(args)
      case 'files/list_folder/get_latest_cursor': {
        const node = this.#resolve(String(args.path ?? ''))
        if (!node) return lookupError('not_found')
        const cursor: Cursor = {
          e: this.#epoch,
          k: this.#keyOf(node),
          r: Boolean(args.recursive),
          s: this.tree.seq,
          l: 2000,
        }
        return { status: 200, body: { cursor: enc(cursor) } }
      }
      case 'files/get_metadata': {
        const node = this.#resolve(String(args.path ?? ''))
        if (!node || node.path === '/') return lookupError('not_found')
        return { status: 200, body: this.meta(node, Boolean(args.include_media_info)) }
      }
      case 'files/download':
        return this.#download(String(args.path ?? ''), req.headers.range as string | undefined)
      case 'files/get_thumbnail_v2': {
        const resource = args.resource as { path?: string } | undefined
        const node = this.#resolve(String(resource?.path ?? ''))
        if (!node || node.isDir) return lookupError('not_found')
        if (node.mediaType !== 'image' && node.mediaType !== 'video') {
          return {
            status: 409,
            body: {
              error_summary: 'unsupported_extension/',
              error: { '.tag': 'unsupported_extension' },
            },
          }
        }
        return {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'dropbox-api-result': headerJson(this.meta(node)),
          },
          body:
            this.#thumbnail?.(node) ??
            Buffer.from(`fake-thumbnail:${node.id}:${String(args.size)}`),
        }
      }
      case 'users/get_space_usage': {
        const used = this.used ?? this.tree.usedBytes()
        const allocation = this.team
          ? { '.tag': 'team', used, allocated: this.allocated, user_within_team_space_allocated: 0 }
          : { '.tag': 'individual', allocated: this.allocated }
        return { status: 200, body: { used, allocation } }
      }
      default:
        return { status: 404, body: `Fake: unknown endpoint ${req.endpoint}` }
    }
  }

  /** The API's view of a node. */
  meta(n: FakeNode, mediaInfo = false): Record<string, unknown> {
    const common = {
      name: n.name,
      id: n.id,
      path_lower: this.tree.key(n.path).toLowerCase(),
      path_display: n.path,
    }
    if (n.isDir) return { '.tag': 'folder', ...common }
    const bytes = n.bytes ?? Buffer.alloc(0)
    return {
      '.tag': 'file',
      ...common,
      client_modified: dbxTime(n.clientModified),
      server_modified: dbxTime(n.modified),
      rev: n.rev,
      size: bytes.length,
      is_downloadable: true,
      content_hash: dropboxContentHash(bytes),
      ...(mediaInfo && n.shotAt
        ? {
            media_info: {
              '.tag': 'metadata',
              metadata: {
                '.tag': n.mediaType === 'video' ? 'video' : 'photo',
                time_taken: dbxTime(n.shotAt),
              },
            },
          }
        : {}),
    }
  }

  #listFolder(args: Record<string, unknown>): Reply {
    const node = this.#resolve(String(args.path ?? ''))
    if (!node) return lookupError('not_found')
    if (!node.isDir) return lookupError('not_folder')
    const cursor: Cursor = {
      e: this.#epoch,
      k: this.#keyOf(node),
      r: Boolean(args.recursive),
      s: this.tree.seq,
      o: 0,
      l: Math.min(2000, Number(args.limit ?? 2000)),
    }
    return this.#listingPage(node, cursor)
  }

  #continue(args: Record<string, unknown>): Reply {
    const cursor = dec(String(args.cursor ?? ''))
    if (!cursor) return { status: 400, body: 'Error in call: invalid cursor' }
    if (cursor.e !== this.#epoch)
      return { status: 409, body: { error_summary: 'reset/', error: { '.tag': 'reset' } } }
    const node = this.tree.get(cursor.k)
    if (cursor.o != null) {
      if (!node) return lookupError('not_found')
      return this.#listingPage(node, cursor)
    }
    const changes = this.tree
      .changesSince(cursor.s, cursor.k)
      .filter(
        (c) =>
          cursor.r ||
          c.key.split('/').length === cursor.k.split('/').length + (cursor.k === '/' ? 0 : 1),
      )
    const taken = changes.slice(0, cursor.l)
    const entries = taken.map((c) => {
      const n = this.tree.get(c.key)
      if (n) return this.meta(n)
      const name = c.key.slice(c.key.lastIndexOf('/') + 1)
      return { '.tag': 'deleted', name, path_lower: c.key.toLowerCase(), path_display: c.key }
    })
    const more = changes.length > taken.length
    const s = more ? (taken.at(-1)?.seq ?? cursor.s) : this.tree.seq
    return { status: 200, body: { entries, cursor: enc({ ...cursor, s }), has_more: more } }
  }

  #listingPage(node: FakeNode, cursor: Cursor): Reply {
    const all = cursor.r
      ? [...(node.path === '/' ? [] : [node]), ...this.tree.descendants(node.path)]
      : this.tree.children(node.path)
    const from = cursor.o ?? 0
    const page = all.slice(from, from + cursor.l)
    const more = from + page.length < all.length
    const next: Cursor = { ...cursor }
    if (more) next.o = from + page.length
    else delete next.o
    return {
      status: 200,
      body: { entries: page.map((n) => this.meta(n)), cursor: enc(next), has_more: more },
    }
  }

  #download(path: string, range: string | undefined): Reply {
    let node: FakeNode | undefined
    let bytes: Buffer | null = null
    let meta: Record<string, unknown> | null = null
    if (path.startsWith('rev:')) {
      const rev = this.tree.revisions.get(path.slice(4))
      if (!rev) return lookupError('not_found')
      node = rev.node
      bytes = rev.bytes
      meta = {
        ...this.meta(node),
        rev: path.slice(4),
        size: bytes.length,
        content_hash: dropboxContentHash(bytes),
        server_modified: dbxTime(rev.modified),
      }
    } else {
      node = this.#resolve(path)
      if (!node) return lookupError('not_found')
      if (node.isDir) return lookupError('not_file')
      bytes = node.bytes ?? Buffer.alloc(0)
      meta = this.meta(node)
    }
    return rangeReply(bytes, range, {
      'content-type': 'application/octet-stream',
      'dropbox-api-result': headerJson(meta),
    })
  }

  #token(req: LoggedRequest): Reply {
    const form = new URLSearchParams(req.body)
    const ok =
      this.#refresh &&
      form.get('grant_type') === 'refresh_token' &&
      form.get('refresh_token') === this.#refresh.refreshToken &&
      form.get('client_id') === this.#refresh.appKey
    if (!ok)
      return {
        status: 400,
        body: { error: 'invalid_grant', error_description: 'refresh token is invalid' },
      }
    this.token = `dropbox-short-lived-${++this.#issued}`
    this.#expired = false
    return {
      status: 200,
      body: { access_token: this.token, token_type: 'bearer', expires_in: 14_400 },
    }
  }

  #resolve(path: string): FakeNode | undefined {
    if (path === '' || path === '/') return this.tree.get('/')
    if (path.startsWith('id:')) return this.tree.getById(path)
    return this.tree.get(path)
  }

  #keyOf(node: FakeNode): string {
    return this.tree.key(node.path)
  }
}

function enc(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url')
}

function dec(s: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Cursor
    return typeof c.s === 'number' && typeof c.k === 'string' ? c : null
  } catch {
    return null
  }
}

function dbxTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function lookupError(tag: string): Reply {
  return {
    status: 409,
    body: { error_summary: `path/${tag}/`, error: { '.tag': 'path', path: { '.tag': tag } } },
  }
}

function authError(tag: string): Reply {
  return { status: 401, body: { error_summary: `${tag}/`, error: { '.tag': tag } } }
}

export async function startFakeDropbox(o: FakeDropboxOptions = {}): Promise<FakeDropbox> {
  return new FakeDropbox(o).start()
}
