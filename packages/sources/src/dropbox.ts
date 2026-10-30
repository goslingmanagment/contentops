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
  type TokenProvider,
  tokenProvider,
} from './http.ts'
import { components, dropboxPath, isUnder, nfc, parentPath, sourcePath } from './paths.ts'
import { DEFAULT_RETRY, type RetryPolicy, withRetry } from './retry.ts'
import type {
  CloudSource,
  DownloadBody,
  DownloadOptions,
  EntryRef,
  RecentResult,
  SourceEntry,
  SourcePath,
  SpaceInfo,
  Thumbnail,
  ThumbnailOptions,
  TraverseEvent,
  TraverseOptions,
} from './types.ts'

/**
 * Every Dropbox API v2 endpoint this client calls. Dropbox uses POST for reads too, so the
 * guard is the list itself: no upload, move, copy, delete, create_folder, sharing or file
 * request endpoint is here, and `#rpc()` / `#content()` take only these.
 */
export const DROPBOX_ENDPOINTS = [
  'files/list_folder',
  'files/list_folder/continue',
  'files/list_folder/get_latest_cursor',
  'files/get_metadata',
  'files/download',
  'files/get_thumbnail_v2',
  'users/get_space_usage',
] as const
export type DropboxEndpoint = (typeof DROPBOX_ENDPOINTS)[number]

/** OAuth token refresh (not a data endpoint): turns a refresh token into an access token. */
export const DROPBOX_TOKEN_ENDPOINT = 'oauth2/token'

export interface DropboxOptions {
  /** Access token or a provider (`dropboxRefreshToken` for short-lived tokens). */
  token: TokenInput
  /** The model's folder: `/Folder`, or `''` for the whole account (or app folder). */
  root: string
  apiBase?: string
  contentBase?: string
  fetch?: typeof fetch
  retry?: RetryPolicy
  /** `limit` of `list_folder` pages (1–2000). */
  pageSize?: number
  /** `get_thumbnail_v2` size, e.g. `w640h480`. */
  thumbnailSize?: string
  requestTimeoutMs?: number
}

export function createDropboxSource(options: DropboxOptions): CloudSource {
  return new DropboxSource(options)
}

/** Dropbox wants ASCII in `Dropbox-API-Arg`: everything above 0x7E as `\uXXXX`. */
export function headerJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

const EXT_MEDIA: Record<string, string> = {}
for (const ext of 'jpg jpeg png heic heif gif webp tif tiff bmp dng cr2 cr3 nef arw raf'.split(' '))
  EXT_MEDIA[ext] = 'image'
for (const ext of 'mp4 mov m4v avi mkv webm 3gp mts m2ts wmv'.split(' ')) EXT_MEDIA[ext] = 'video'
for (const ext of 'mp3 m4a wav aac ogg flac'.split(' ')) EXT_MEDIA[ext] = 'audio'
// Yandex calls archives `compressed`: the same word keeps one vocabulary for both sources.
for (const ext of 'zip rar 7z tar gz tgz'.split(' ')) EXT_MEDIA[ext] = 'compressed'

function mediaTypeOf(name: string, mediaInfo: Record<string, unknown> | null): string | null {
  const tag = mediaInfo ? str(mediaInfo['.tag']) : null
  if (tag === 'photo') return 'image'
  if (tag === 'video') return 'video'
  const dot = name.lastIndexOf('.')
  return dot > 0 ? (EXT_MEDIA[name.slice(dot + 1).toLowerCase()] ?? null) : null
}

export interface DropboxRefreshOptions {
  refreshToken: string
  appKey: string
  /** Omitted for PKCE-issued refresh tokens. */
  appSecret?: string
  apiBase?: string
  fetch?: typeof fetch
}

/**
 * Short-lived access tokens from a refresh token (Dropbox no longer issues long-lived
 * ones). The token is cached until a minute before expiry or until the API calls it expired.
 */
export function dropboxRefreshToken(o: DropboxRefreshOptions): TokenProvider {
  const http: HttpContext = { source: 'dropbox', fetch: o.fetch ?? fetch, timeoutMs: 30_000 }
  const url = `${(o.apiBase ?? 'https://api.dropboxapi.com').replace(/\/$/, '')}/${DROPBOX_TOKEN_ENDPOINT}`
  let cached: { token: string; until: number } | null = null
  return {
    async get() {
      if (cached && Date.now() < cached.until) return cached.token
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: o.refreshToken,
        client_id: o.appKey,
        ...(o.appSecret ? { client_secret: o.appSecret } : {}),
      })
      const res = await send(
        http,
        DROPBOX_TOKEN_ENDPOINT,
        url,
        { method: 'POST', body: form },
        (r, text) =>
          new SourceError(
            r.status === 400 || r.status === 401 ? 'auth_rejected' : kindForStatus(r.status),
            `${r.status} token refresh: ${text.slice(0, 200)}`,
            { source: 'dropbox', endpoint: DROPBOX_TOKEN_ENDPOINT, status: r.status },
          ),
      )
      const body = await readJson(http, DROPBOX_TOKEN_ENDPOINT, res)
      const token = isRecord(body) ? str(body.access_token) : null
      const expiresIn = isRecord(body) ? (num(body.expires_in) ?? 14_400) : 0
      if (!token) {
        throw new SourceError('bad_response', 'token refresh without access_token', {
          source: 'dropbox',
          endpoint: DROPBOX_TOKEN_ENDPOINT,
        })
      }
      cached = { token, until: Date.now() + Math.max(0, expiresIn - 60) * 1000 }
      return token
    },
    invalidate() {
      cached = null
    },
  }
}

class DropboxSource implements CloudSource {
  readonly kind = 'dropbox' as const
  readonly root: string
  readonly #rootLower: string
  readonly #api: string
  readonly #contentApi: string
  readonly #token: TokenProvider
  readonly #http: HttpContext
  readonly #retry: RetryPolicy
  readonly #pageSize: number
  readonly #thumbnailSize: string

  constructor(o: DropboxOptions) {
    this.root = dropboxPath(o.root)
    this.#rootLower = this.root.toLowerCase()
    this.#api = (o.apiBase ?? 'https://api.dropboxapi.com').replace(/\/$/, '')
    this.#contentApi = (o.contentBase ?? 'https://content.dropboxapi.com').replace(/\/$/, '')
    this.#token = tokenProvider(o.token)
    this.#http = {
      source: 'dropbox',
      fetch: o.fetch ?? fetch,
      timeoutMs: o.requestTimeoutMs ?? 60_000,
    }
    this.#retry = o.retry ?? DEFAULT_RETRY
    this.#pageSize = Math.min(2000, Math.max(1, o.pageSize ?? 2000))
    this.#thumbnailSize = o.thumbnailSize ?? 'w640h480'
  }

  async recent(cursor: string | null, o: { signal?: AbortSignal } = {}): Promise<RecentResult> {
    if (!cursor) return this.#restart(o.signal)
    const entries: SourceEntry[] = []
    const deleted: SourcePath[] = []
    let current = cursor
    try {
      for (;;) {
        const page = await this.#rpc('files/list_folder/continue', { cursor: current }, o.signal)
        const { list, next, more } = this.#page(page, 'files/list_folder/continue')
        for (const raw of list) {
          if (str(raw['.tag']) === 'deleted') {
            const path = str(raw.path_display) ?? str(raw.path_lower)
            if (path && this.#inRoot(raw))
              deleted.push(sourcePath(path, this.root, str(raw.path_lower)))
          } else if (this.#inRoot(raw)) {
            entries.push(this.#entry(raw, 'files/list_folder/continue'))
          }
        }
        current = next
        if (!more) break
      }
    } catch (e) {
      // `reset`: the cursor is no longer valid — start over with a full traversal.
      if (isSourceError(e) && e.code?.startsWith('reset')) return this.#restart(o.signal)
      throw e
    }
    return { entries, deleted, fullTraversal: false, cursor: current }
  }

  async *traverse(path?: string, o: TraverseOptions = {}): AsyncGenerator<TraverseEvent> {
    const start = dropboxPath(path ?? this.root)
    if (!isUnder(start.toLowerCase(), this.#rootLower)) {
      throw new TypeError(`${start} is outside ${this.root}`)
    }
    const startLower = start.toLowerCase()
    const dirs = new Map<string, { path: SourcePath; id: string | null; children: number }>()
    let startId: string | null = null
    if (start !== '') {
      const self = await this.stat({ path: start }, o)
      if (!self.isDir) throw new TypeError(`${start} is not a folder`)
      startId = self.id
      yield { type: 'entry', entry: self }
    }
    dirs.set(startLower, {
      path: sourcePath(start, this.root, startLower),
      id: startId,
      children: 0,
    })
    let files = 0
    let cursor: string | null = null
    let failure: SourceError | null = null
    try {
      let page = await this.#rpc(
        'files/list_folder',
        {
          path: start,
          recursive: true,
          include_deleted: false,
          include_non_downloadable_files: false,
          limit: this.#pageSize,
        },
        o.signal,
      )
      for (;;) {
        const { list, next, more } = this.#page(page, 'files/list_folder')
        for (const raw of list) {
          const tag = str(raw['.tag'])
          if (tag !== 'file' && tag !== 'folder') continue
          const entry = this.#entry(raw, 'files/list_folder')
          const lower = entry.path.lower ?? entry.path.raw.toLowerCase()
          if (lower === startLower) continue
          const parent = dirs.get(parentPath(lower) ?? '')
          if (parent) parent.children++
          if (entry.isDir) dirs.set(lower, { path: entry.path, id: entry.id, children: 0 })
          else files++
          yield { type: 'entry', entry }
        }
        cursor = next
        if (!more) break
        page = await this.#rpc('files/list_folder/continue', { cursor: next }, o.signal)
      }
    } catch (e) {
      // One listing covers every folder: a broken answer or a cursor reset mid-way leaves
      // the whole pass incomplete. Auth, rate limit and outage are thrown (pass stopped).
      if (!isSourceError(e) || e.retryable || e.kind === 'auth_rejected' || e.kind === 'not_found')
        throw e
      failure = e
    }
    for (const dir of dirs.values()) {
      yield {
        type: 'dir',
        path: dir.path,
        id: dir.id,
        complete: failure == null,
        children: dir.children,
        ...(failure ? { reason: failure.code ?? failure.kind } : {}),
      }
    }
    yield {
      type: 'end',
      complete: failure == null,
      files,
      dirs: dirs.size,
      incompleteDirs: failure ? dirs.size : 0,
      cursor: failure ? null : cursor,
    }
  }

  async stat(ref: EntryRef, o: { signal?: AbortSignal } = {}): Promise<SourceEntry> {
    const path = ref.id ?? dropboxPath(ref.path ?? '')
    if (path === '') throw new TypeError('Dropbox has no metadata for the account root')
    const r = await this.#rpc(
      'files/get_metadata',
      { path, include_media_info: true, include_deleted: false },
      o.signal,
    )
    if (!isRecord(r) || str(r['.tag']) === 'deleted') {
      throw new SourceError('not_found', `${path} is deleted`, {
        source: 'dropbox',
        endpoint: 'files/get_metadata',
      })
    }
    return this.#entry(r, 'files/get_metadata')
  }

  async download(entry: SourceEntry, o: DownloadOptions = {}): Promise<DownloadBody> {
    const endpoint = 'files/download'
    const offset = o.offset ?? 0
    // Pinned to the observed revision: the bytes belong to exactly that `rev`.
    const path = entry.rev ? `rev:${entry.rev}` : (entry.id ?? entry.path.raw)
    const res = await this.#content(
      endpoint,
      { path },
      offset > 0 ? { range: `bytes=${offset}-` } : {},
      o.signal,
      false,
    )
    let remote: DownloadBody['remote'] = null
    const header = res.headers.get('dropbox-api-result')
    if (header) {
      try {
        const meta = JSON.parse(header) as unknown
        if (isRecord(meta)) {
          remote = { rev: str(meta.rev), contentHash: str(meta.content_hash), size: num(meta.size) }
        }
      } catch {
        // the header is informational; the checksum decides
      }
    }
    return {
      ...rangeOf(res, offset),
      body: guardBody(this.#http, endpoint, res, o.signal),
      remote,
    }
  }

  async thumbnail(entry: SourceEntry, o: ThumbnailOptions = {}): Promise<Thumbnail | null> {
    if (entry.isDir) return null
    const endpoint = 'files/get_thumbnail_v2'
    try {
      const res = await this.#content(
        endpoint,
        {
          resource: { '.tag': 'path', path: entry.id ?? entry.path.raw },
          format: 'jpeg',
          size: o.size ?? this.#thumbnailSize,
          mode: 'bestfit',
        },
        {},
        o.signal,
        true,
      )
      return {
        bytes: await readBytes(this.#http, endpoint, res, o.signal),
        contentType: res.headers.get('content-type') ?? 'image/jpeg',
      }
    } catch (e) {
      // No picture for this kind of file is not an error.
      if (isSourceError(e) && /unsupported_|conversion_error/.test(e.code ?? '')) return null
      throw e
    }
  }

  async space(o: { signal?: AbortSignal } = {}): Promise<SpaceInfo> {
    const r = await this.#rpc('users/get_space_usage', null, o.signal)
    const alloc = isRecord(r) && isRecord(r.allocation) ? r.allocation : null
    let used = isRecord(r) ? num(r.used) : null
    let total: number | null = null
    if (alloc && str(alloc['.tag']) === 'individual') total = num(alloc.allocated)
    else if (alloc && str(alloc['.tag']) === 'team') {
      // A personal cap inside the team, if set; otherwise the shared team space.
      const cap = num(alloc.user_within_team_space_allocated) ?? 0
      if (cap > 0) total = cap
      else {
        total = num(alloc.allocated)
        used = num(alloc.used) ?? used
      }
    }
    if (used == null || total == null) throw this.#bad('users/get_space_usage', 'no used/allocated')
    const usedRatio = total > 0 ? used / total : 0
    return { totalBytes: total, usedBytes: used, usedRatio, nearlyFull: usedRatio >= 0.9 }
  }

  async #restart(signal?: AbortSignal): Promise<RecentResult> {
    const r = await this.#rpc(
      'files/list_folder/get_latest_cursor',
      { path: this.root, recursive: true, include_deleted: true },
      signal,
    )
    const cursor = isRecord(r) ? str(r.cursor) : null
    if (!cursor) throw this.#bad('files/list_folder/get_latest_cursor', 'no cursor')
    return { entries: [], deleted: [], fullTraversal: true, cursor }
  }

  #page(
    page: unknown,
    endpoint: string,
  ): { list: Record<string, unknown>[]; next: string; more: boolean } {
    const list = isRecord(page) && Array.isArray(page.entries) ? page.entries : null
    const next = isRecord(page) ? str(page.cursor) : null
    if (!list || !next || !isRecord(page) || typeof page.has_more !== 'boolean') {
      throw this.#bad(endpoint, 'no entries, cursor or has_more')
    }
    return { list: list.filter(isRecord), next, more: page.has_more }
  }

  #inRoot(raw: Record<string, unknown>): boolean {
    const lower = str(raw.path_lower)
    return lower != null && isUnder(lower, this.#rootLower)
  }

  /** RPC endpoint: JSON in, JSON out; the whole exchange is retried. */
  #rpc(endpoint: DropboxEndpoint, args: unknown, signal?: AbortSignal): Promise<unknown> {
    const url = `${this.#api}/2/${endpoint}`
    const body = JSON.stringify(args)
    return withRetry(
      async () => {
        const res = await this.#send(
          endpoint,
          url,
          { 'content-type': 'application/json' },
          signal,
          true,
          body,
        )
        return readJson(this.#http, endpoint, res, signal)
      },
      this.#retry,
      signal,
    )
  }

  /** Content endpoint: arguments in `Dropbox-API-Arg`, bytes in the body. */
  #content(
    endpoint: DropboxEndpoint,
    args: unknown,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    timeout: boolean,
  ): Promise<Response> {
    const url = `${this.#contentApi}/2/${endpoint}`
    const all = { ...headers, 'dropbox-api-arg': headerJson(args) }
    return withRetry(() => this.#send(endpoint, url, all, signal, timeout), this.#retry, signal)
  }

  /** One request; an expired short-lived token is refreshed once. */
  async #send(
    endpoint: DropboxEndpoint,
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    timeout: boolean,
    body?: string,
  ): Promise<Response> {
    for (let refreshed = false; ; refreshed = true) {
      try {
        return await send(
          this.#http,
          endpoint,
          url,
          {
            method: 'POST',
            headers: { ...headers, authorization: `Bearer ${await this.#token.get()}` },
            ...(body !== undefined ? { body } : {}),
            signal,
            timeout,
          },
          (r, t) => this.#error(endpoint, r, t),
        )
      } catch (e) {
        const expired =
          isSourceError(e, 'auth_rejected') && e.code?.startsWith('expired_access_token')
        if (!expired || refreshed || !this.#token.invalidate) throw e
        this.#token.invalidate()
      }
    }
  }

  #error(endpoint: string, res: Response, text: string): SourceError {
    let summary: string | undefined
    let retryAfterMs = parseRetryAfter(res.headers.get('retry-after'))
    try {
      const body = JSON.parse(text) as unknown
      if (isRecord(body)) {
        summary = str(body.error_summary) ?? undefined
        const err = isRecord(body.error) ? body.error : null
        const after = err ? num(err.retry_after) : null
        if (retryAfterMs == null && after != null) retryAfterMs = after * 1000
      }
    } catch {
      // 400 answers are plain text
    }
    let kind = kindForStatus(res.status)
    if (res.status === 409) kind = /not_found/.test(summary ?? '') ? 'not_found' : 'bad_response'
    if (res.status === 416) kind = 'bad_response'
    const code = summary ?? (res.status === 416 ? 'range_not_satisfiable' : undefined)
    return new SourceError(kind, `${res.status} ${summary ?? text.slice(0, 200)}`.trim(), {
      source: 'dropbox',
      endpoint,
      status: res.status,
      ...(code ? { code } : {}),
      ...(retryAfterMs != null ? { retryAfterMs } : {}),
    })
  }

  #bad(endpoint: string, why: string): SourceError {
    return new SourceError('bad_response', `${endpoint}: ${why}`, { source: 'dropbox', endpoint })
  }

  #entry(r: Record<string, unknown>, endpoint: string): SourceEntry {
    const tag = str(r['.tag'])
    const display = str(r.path_display)
    const lower = str(r.path_lower)
    const name = str(r.name)
    if ((tag !== 'file' && tag !== 'folder') || name == null || (!display && !lower)) {
      throw this.#bad(endpoint, 'metadata without .tag, name or path')
    }
    const raw = display ?? (lower as string)
    const isDir = tag === 'folder'
    const mediaInfo =
      isRecord(r.media_info) && isRecord(r.media_info.metadata) ? r.media_info.metadata : null
    const path = sourcePath(raw, this.root, lower)
    // `path_display` may get a parent's case wrong; the parent is cut from it by components.
    const parts = components(raw)
    const atRoot = parts.length === components(this.root).length
    return {
      source: 'dropbox',
      id: str(r.id),
      isDir,
      name,
      path,
      parentPath: atRoot ? null : parentPath(raw),
      size: isDir ? null : num(r.size),
      md5: null,
      sha256: null,
      contentHash: isDir ? null : str(r.content_hash),
      rev: isDir ? null : str(r.rev),
      createdAt: iso(r.server_modified),
      modifiedAt: iso(r.client_modified),
      shotAt: mediaInfo ? iso(mediaInfo.time_taken) : null,
      mediaType: isDir ? null : mediaTypeOf(nfc(name), mediaInfo),
      mimeType: null,
      previewUrl: null,
    }
  }
}
