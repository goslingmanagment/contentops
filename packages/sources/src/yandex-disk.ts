import { isSourceError, kindForStatus, parseRetryAfter, SourceError } from './errors.ts'
import {
  guardBody,
  type HttpContext,
  iso,
  isRecord,
  num,
  rangeOf,
  readBytes,
  readJson,
  send,
  str,
  type TokenInput,
  tokenProvider,
} from './http.ts'
import { isUnder, parentPath, sourcePath, yandexPath } from './paths.ts'
import { DEFAULT_RETRY, type RetryPolicy, withRetry } from './retry.ts'
import type {
  CloudSource,
  DownloadBody,
  DownloadOptions,
  EntryRef,
  RecentResult,
  SourceEntry,
  SpaceInfo,
  Thumbnail,
  ThumbnailOptions,
  TraverseEvent,
  TraverseOptions,
} from './types.ts'

/**
 * Every Yandex Disk REST endpoint this client calls, all with GET. Upload, copy, move,
 * delete, publish and trash are not here and cannot be called: `get()` takes only these.
 * Besides them the client follows two URLs the API hands out: the download `href` and
 * the `preview` link.
 */
export const YANDEX_DISK_ENDPOINTS = [
  '/v1/disk',
  '/v1/disk/resources',
  '/v1/disk/resources/last-uploaded',
  '/v1/disk/resources/download',
] as const
export type YandexDiskEndpoint = (typeof YANDEX_DISK_ENDPOINTS)[number]

export interface YandexDiskOptions {
  /** OAuth token with read access (`cloud_api:disk.read`). */
  token: TokenInput
  /** The model's folder: `disk:/Folder` or `/` for the whole disk. */
  root: string
  apiBase?: string
  fetch?: typeof fetch
  retry?: RetryPolicy
  /** `limit` of a folder page in `traverse()`. */
  pageSize?: number
  /** Explicit `limit` of `last-uploaded` (SPEC §6.1). */
  recentLimit?: number
  /** `preview_size` asked with metadata. */
  previewSize?: string
  requestTimeoutMs?: number
}

const ITEM_FIELDS = [
  'resource_id',
  'name',
  'path',
  'type',
  'size',
  'md5',
  'sha256',
  'created',
  'modified',
  'exif',
  'media_type',
  'mime_type',
  'preview',
]
const SELF_FIELDS = ITEM_FIELDS.join(',')
const LIST_FIELDS = [
  ...ITEM_FIELDS,
  ...ITEM_FIELDS.map((f) => `_embedded.items.${f}`),
  '_embedded.limit',
  '_embedded.offset',
  '_embedded.total',
].join(',')
const RECENT_FIELDS = [...ITEM_FIELDS.map((f) => `items.${f}`), 'limit'].join(',')

/** Listing restarts when a folder changes while it is paged. */
const LISTING_ATTEMPTS = 3

export function createYandexDiskSource(options: YandexDiskOptions): CloudSource {
  return new YandexDiskSource(options)
}

interface Listing {
  self: Record<string, unknown>
  items: Record<string, unknown>[]
  complete: boolean
  reason?: string
}

class YandexDiskSource implements CloudSource {
  readonly kind = 'yandex_disk' as const
  readonly root: string
  readonly #api: string
  readonly #token
  readonly #http: HttpContext
  readonly #retry: RetryPolicy
  readonly #pageSize: number
  readonly #recentLimit: number
  readonly #previewSize: string

  constructor(o: YandexDiskOptions) {
    this.root = yandexPath(o.root)
    this.#api = (o.apiBase ?? 'https://cloud-api.yandex.net').replace(/\/$/, '')
    this.#token = tokenProvider(o.token)
    this.#http = {
      source: 'yandex_disk',
      fetch: o.fetch ?? fetch,
      timeoutMs: o.requestTimeoutMs ?? 60_000,
    }
    this.#retry = o.retry ?? DEFAULT_RETRY
    this.#pageSize = o.pageSize ?? 1000
    this.#recentLimit = o.recentLimit ?? 500
    this.#previewSize = o.previewSize ?? 'XL'
  }

  async recent(cursor: string | null, o: { signal?: AbortSignal } = {}): Promise<RecentResult> {
    const limit = this.#recentLimit
    const page = await this.#getJson(
      '/v1/disk/resources/last-uploaded',
      { limit: String(limit), fields: RECENT_FIELDS, preview_size: this.#previewSize },
      o.signal,
    )
    const items = isRecord(page) && Array.isArray(page.items) ? page.items : null
    if (!items) throw this.#bad('/v1/disk/resources/last-uploaded', 'no items')
    const entries = items.map((r) => this.#entry(r, '/v1/disk/resources/last-uploaded'))
    const watermark = cursor ? iso(cursor) : null
    const created = entries.map((e) => e.createdAt).filter((t): t is string => t != null)
    // A full page that does not reach back to the last scan may hide more: traverse now.
    const reachedBack = watermark != null && created.some((t) => t <= watermark)
    const newest = created.reduce((a, b) => (b > a ? b : a), watermark ?? '')
    return {
      entries: entries.filter((e) => isUnder(e.path.raw, this.root)),
      deleted: [],
      fullTraversal: watermark == null || (items.length >= limit && !reachedBack),
      cursor: newest || new Date(0).toISOString(),
    }
  }

  async *traverse(path?: string, o: TraverseOptions = {}): AsyncGenerator<TraverseEvent> {
    const start = yandexPath(path ?? this.root)
    if (!isUnder(start, this.root)) throw new TypeError(`${start} is outside ${this.root}`)
    const stack: { path: string; id: string | null }[] = [{ path: start, id: null }]
    let files = 0
    let dirs = 0
    let incompleteDirs = 0
    while (stack.length > 0) {
      const dir = stack.pop() as { path: string; id: string | null }
      let listing: Listing
      try {
        listing = await this.#list(dir.path, o.signal)
      } catch (e) {
        // The start folder must be readable; a vanished or unreadable subfolder only marks
        // itself incomplete. Auth, rate limit and outage stop the pass (thrown).
        if (dir.path === start || !isSourceError(e) || e.retryable || e.kind === 'auth_rejected')
          throw e
        dirs++
        incompleteDirs++
        yield {
          type: 'dir',
          path: sourcePath(dir.path, this.root),
          id: dir.id,
          complete: false,
          children: 0,
          reason: e.kind,
        }
        continue
      }
      if (dir.path === start) {
        const self = this.#entry(listing.self, '/v1/disk/resources')
        dir.id = self.id
        yield { type: 'entry', entry: self }
      }
      const subdirs: { path: string; id: string | null }[] = []
      for (const item of listing.items) {
        const entry = this.#entry(item, '/v1/disk/resources')
        if (entry.isDir) subdirs.push({ path: entry.path.raw, id: entry.id })
        else files++
        yield { type: 'entry', entry }
      }
      stack.push(...subdirs.reverse())
      dirs++
      if (!listing.complete) incompleteDirs++
      yield {
        type: 'dir',
        path: sourcePath(dir.path, this.root),
        id: dir.id,
        complete: listing.complete,
        children: listing.items.length,
        ...(listing.reason ? { reason: listing.reason } : {}),
      }
    }
    yield { type: 'end', complete: incompleteDirs === 0, files, dirs, incompleteDirs, cursor: null }
  }

  async stat(ref: EntryRef, o: { signal?: AbortSignal } = {}): Promise<SourceEntry> {
    if (ref.path == null) {
      throw new TypeError('Yandex Disk REST has no lookup by resource_id: pass the path')
    }
    const r = await this.#getJson(
      '/v1/disk/resources',
      { path: yandexPath(ref.path), fields: SELF_FIELDS, preview_size: this.#previewSize },
      o.signal,
    )
    return this.#entry(r, '/v1/disk/resources')
  }

  async download(entry: SourceEntry, o: DownloadOptions = {}): Promise<DownloadBody> {
    const endpoint = '/v1/disk/resources/download'
    const offset = o.offset ?? 0
    const link = await this.#getJson(endpoint, { path: entry.path.raw }, o.signal)
    const href = isRecord(link) ? str(link.href) : null
    if (!href) throw this.#bad(endpoint, 'no href')
    // The href is pre-signed: the token is not sent to the download host.
    const res = await withRetry(
      () =>
        send(
          this.#http,
          endpoint,
          href,
          {
            method: 'GET',
            headers: offset > 0 ? { range: `bytes=${offset}-` } : {},
            signal: o.signal,
            timeout: false,
          },
          (r, t) => this.#error(endpoint, r, t),
        ),
      this.#retry,
      o.signal,
    )
    return {
      ...rangeOf(res, offset),
      body: guardBody(this.#http, endpoint, res, o.signal),
      remote: null,
    }
  }

  async thumbnail(entry: SourceEntry, o: ThumbnailOptions = {}): Promise<Thumbnail | null> {
    if (!entry.previewUrl) return null
    const stale = (e: unknown) =>
      isSourceError(e) && (e.kind === 'not_found' || e.kind === 'auth_rejected')
    try {
      return await this.#preview(entry.previewUrl, o)
    } catch (e) {
      if (!stale(e)) throw e
    }
    // The link may have expired: a fresh one comes with the metadata, and the API (not the
    // preview host) is the one that says whether the token is rejected.
    let fresh: SourceEntry
    try {
      fresh = await this.stat({ path: entry.path.raw }, o)
    } catch (e) {
      if (isSourceError(e, 'not_found')) return null
      throw e
    }
    if (!fresh.previewUrl) return null
    try {
      return await this.#preview(fresh.previewUrl, o)
    } catch (e) {
      if (stale(e)) return null
      throw e
    }
  }

  async #preview(link: string, o: ThumbnailOptions): Promise<Thumbnail> {
    const endpoint = 'preview'
    const url = new URL(link)
    url.searchParams.set('size', o.size ?? this.#previewSize)
    // The preview link needs the token; it goes only to Yandex hosts (or the configured API).
    const trusted =
      url.origin === new URL(this.#api).origin || /(^|\.)yandex\.(ru|net|com)$/.test(url.hostname)
    const headers: Record<string, string> = trusted
      ? { authorization: `OAuth ${await this.#token.get()}` }
      : {}
    const res = await withRetry(
      () =>
        send(this.#http, endpoint, url.toString(), { headers, signal: o.signal }, (r, t) =>
          this.#error(endpoint, r, t),
        ),
      this.#retry,
      o.signal,
    )
    return {
      bytes: await readBytes(this.#http, endpoint, res, o.signal),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    }
  }

  async space(o: { signal?: AbortSignal } = {}): Promise<SpaceInfo> {
    const r = await this.#getJson('/v1/disk', { fields: 'total_space,used_space' }, o.signal)
    const total = isRecord(r) ? num(r.total_space) : null
    const used = isRecord(r) ? num(r.used_space) : null
    if (total == null || used == null) throw this.#bad('/v1/disk', 'no total_space/used_space')
    const usedRatio = total > 0 ? used / total : 0
    return { totalBytes: total, usedBytes: used, usedRatio, nearlyFull: usedRatio >= 0.9 }
  }

  /** All pages of one folder; restarts when `total` moves between pages. */
  async #list(path: string, signal?: AbortSignal): Promise<Listing> {
    let last: Listing | null = null
    for (let attempt = 0; attempt < LISTING_ATTEMPTS; attempt++) {
      let self: Record<string, unknown> = {}
      const items: Record<string, unknown>[] = []
      let total: number | null = null
      let stable = true
      for (let offset = 0; ; ) {
        const page = await this.#getJson(
          '/v1/disk/resources',
          {
            path,
            limit: String(this.#pageSize),
            offset: String(offset),
            // A fixed order keeps offset paging stable.
            sort: 'name',
            fields: LIST_FIELDS,
            preview_size: this.#previewSize,
          },
          signal,
        )
        const embedded = isRecord(page) && isRecord(page._embedded) ? page._embedded : null
        const pageItems = embedded && Array.isArray(embedded.items) ? embedded.items : null
        const pageTotal = embedded ? num(embedded.total) : null
        if (!isRecord(page) || !pageItems || pageTotal == null) {
          throw this.#bad('/v1/disk/resources', `${path} has no folder listing`)
        }
        self = page
        if (total == null) total = pageTotal
        else if (pageTotal !== total) {
          stable = false
          break
        }
        items.push(...pageItems.filter(isRecord))
        offset += pageItems.length
        if (pageItems.length === 0 || offset >= total) break
      }
      const complete = stable && items.length === total
      last = { self, items, complete, ...(complete ? {} : { reason: 'changed_while_listing' }) }
      if (complete) return last
    }
    return last as Listing
  }

  async #getJson(
    endpoint: YandexDiskEndpoint,
    query: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = `${this.#api}${endpoint}?${new URLSearchParams(query)}`
    return withRetry(
      async () => {
        const res = await send(
          this.#http,
          endpoint,
          url,
          {
            method: 'GET',
            headers: {
              authorization: `OAuth ${await this.#token.get()}`,
              accept: 'application/json',
            },
            signal,
          },
          (r, t) => this.#error(endpoint, r, t),
        )
        return readJson(this.#http, endpoint, res, signal)
      },
      this.#retry,
      signal,
    )
  }

  #error(endpoint: string, res: Response, text: string): SourceError {
    let code: string | undefined
    let message = text.slice(0, 200)
    try {
      const body = JSON.parse(text) as unknown
      if (isRecord(body)) {
        code = str(body.error) ?? undefined
        message = str(body.message) ?? str(body.description) ?? message
      }
    } catch {
      // not JSON: keep the raw text
    }
    const kind =
      res.status === 416
        ? 'bad_response'
        : code === 'DiskNotFoundError'
          ? 'not_found'
          : kindForStatus(res.status)
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'))
    return new SourceError(kind, `${res.status} ${code ?? ''} ${message}`.trim(), {
      source: 'yandex_disk',
      endpoint,
      status: res.status,
      ...(code ? { code } : res.status === 416 ? { code: 'range_not_satisfiable' } : {}),
      ...(retryAfterMs != null ? { retryAfterMs } : {}),
    })
  }

  #bad(endpoint: string, why: string): SourceError {
    return new SourceError('bad_response', `${endpoint}: ${why}`, {
      source: 'yandex_disk',
      endpoint,
    })
  }

  #entry(r: unknown, endpoint: string): SourceEntry {
    if (!isRecord(r)) throw this.#bad(endpoint, 'resource is not an object')
    const path = str(r.path)
    const name = str(r.name)
    const type = str(r.type)
    if (!path || name == null || (type !== 'dir' && type !== 'file')) {
      throw this.#bad(endpoint, 'resource without path, name or type')
    }
    const isDir = type === 'dir'
    const exif = isRecord(r.exif) ? r.exif : null
    return {
      source: 'yandex_disk',
      id: str(r.resource_id),
      isDir,
      name,
      path: sourcePath(path, this.root),
      parentPath: path === this.root ? null : parentPath(path),
      size: isDir ? null : num(r.size),
      md5: str(r.md5),
      sha256: str(r.sha256),
      contentHash: null,
      rev: null,
      createdAt: iso(r.created),
      modifiedAt: iso(r.modified),
      shotAt: exif ? iso(exif.date_time) : null,
      mediaType: str(r.media_type),
      mimeType: str(r.mime_type),
      previewUrl: str(r.preview),
    }
  }
}
