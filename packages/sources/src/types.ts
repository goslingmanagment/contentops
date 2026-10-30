/**
 * One interface over the cloud folder of a model (SPEC §6.1): recent changes, full traversal,
 * metadata, download. Read-only by construction: no client in this package calls a write
 * endpoint (`READ_ONLY_ENDPOINTS`, checked by a test).
 */

export type SourceKind = 'yandex_disk' | 'dropbox'

/** A path as the source gave it and as ContentOps compares it (schema §3.4 `source_paths`). */
export interface SourcePath {
  /** Exactly as the source returned it: `disk:/A/b.mp4` (Yandex), `path_display` (Dropbox). */
  raw: string
  /** `raw` in Unicode NFC. Names are never trimmed: `:` and trailing spaces stay. */
  nfc: string
  /** Dropbox `path_lower` (the key Dropbox itself matches on); null for Yandex Disk. */
  lower: string | null
  /** Relative to the model's root folder, no leading slash; `''` is the root itself. */
  relative: string
  /** `relative` in NFC. */
  relativeNfc: string
}

/** A file or folder at the source (schema §3.4 `source_objects` + `source_revisions`). */
export interface SourceEntry {
  source: SourceKind
  /** ID of the file at the source: Yandex `resource_id`, Dropbox `id`. */
  id: string | null
  isDir: boolean
  /** Last path component, raw (as the source returned it). */
  name: string
  path: SourcePath
  /** Raw source path of the parent folder; null for the model's root. */
  parentPath: string | null
  /** Bytes; null for folders. */
  size: number | null
  /** Yandex Disk: MD5 from the API. */
  md5: string | null
  /** Yandex Disk: SHA-256 from the API (Dropbox has none: ContentOps computes it). */
  sha256: string | null
  /** Dropbox `content_hash` (4 MiB blocks, see `dropboxContentHash`). */
  contentHash: string | null
  /** Dropbox `rev`; a download pinned to it returns exactly these bytes. */
  rev: string | null
  /** Time the file appeared at the source: Yandex `created`, Dropbox `server_modified`. ISO. */
  createdAt: string | null
  /** Yandex `modified`, Dropbox `client_modified`. ISO. */
  modifiedAt: string | null
  /** Shooting time if the source knows it: Yandex `exif.date_time`, Dropbox `media_info`. ISO. */
  shotAt: string | null
  /** Yandex `media_type` (`image`, `video`, …); Dropbox: from `media_info` or the extension. */
  mediaType: string | null
  mimeType: string | null
  /** Yandex `preview` URL (needs the token); Dropbox: null, `thumbnail()` asks the API. */
  previewUrl: string | null
}

/** What to look up: Dropbox accepts an id or a path; Yandex Disk only a path. */
export type EntryRef = { id: string; path?: string } | { id?: string; path: string }

export interface RecentResult {
  /** New and changed files (and, for Dropbox, folders) under the root, newest first for Yandex. */
  entries: SourceEntry[]
  /**
   * Deletions reported by the source (Dropbox cursor only). A hint: a loss is written only
   * after two complete traversals (SPEC §6.1).
   */
  deleted: SourcePath[]
  /** The recent window did not cover everything since the last scan: traverse now. */
  fullTraversal: boolean
  /** Opaque; store it and pass it to the next `recent()`. */
  cursor: string
}

export type TraverseEvent =
  | { type: 'entry'; entry: SourceEntry }
  | {
      /** A folder's listing is finished; `complete` is the listing completeness (SPEC §6.3). */
      type: 'dir'
      path: SourcePath
      id: string | null
      complete: boolean
      /** Direct children seen. */
      children: number
      /** Why the listing is incomplete. */
      reason?: string
    }
  | {
      type: 'end'
      /** Every folder was listed completely: only such a pass may count towards a loss. */
      complete: boolean
      files: number
      dirs: number
      incompleteDirs: number
      /** Dropbox: cursor of this listing, a valid starting point for `recent()`. */
      cursor: string | null
    }

export interface SpaceInfo {
  totalBytes: number
  usedBytes: number
  /** used / total, 0 when the total is unknown. */
  usedRatio: number
  /** SPEC §12.2: the space line shows when the cloud is at least 90 % full. */
  nearlyFull: boolean
}

export interface DownloadOptions {
  /** Byte to start from (resume); the source answers 206 or, ignoring Range, 200 from 0. */
  offset?: number
  signal?: AbortSignal
}

export interface DownloadBody {
  body: AsyncIterable<Uint8Array>
  /** Offset the body actually starts at: `offset` on 206, 0 when the server ignored Range. */
  offset: number
  /** Full size of the file as the server sees it now (Content-Range or Content-Length). */
  totalSize: number | null
  /** Dropbox `Dropbox-API-Result`: the revision that is being sent. */
  remote: { rev: string | null; contentHash: string | null; size: number | null } | null
}

export interface Thumbnail {
  bytes: Uint8Array
  contentType: string
}

export interface ThumbnailOptions {
  /** Yandex `preview_size` (`S`…`XXXL` or `640x`), Dropbox `w640h480`-style size. */
  size?: string
  signal?: AbortSignal
}

export interface TraverseOptions {
  signal?: AbortSignal
}

export interface CloudSource {
  readonly kind: SourceKind
  /** Raw source path of the model's root folder. */
  readonly root: string
  /**
   * Fresh changes since `cursor` (null on the first run). Yandex: one `last-uploaded`
   * request; Dropbox: `list_folder/continue` until `has_more` is false.
   */
  recent(cursor: string | null, options?: { signal?: AbortSignal }): Promise<RecentResult>
  /** Full traversal of the root (or a folder under it) with per-folder completeness. */
  traverse(path?: string, options?: TraverseOptions): AsyncIterable<TraverseEvent>
  stat(ref: EntryRef, options?: { signal?: AbortSignal }): Promise<SourceEntry>
  /** Bytes of a file; resume with `offset` (HTTP Range). */
  download(entry: SourceEntry, options?: DownloadOptions): Promise<DownloadBody>
  /** The source's own picture of the file; null when the source has none. */
  thumbnail(entry: SourceEntry, options?: ThumbnailOptions): Promise<Thumbnail | null>
  space(options?: { signal?: AbortSignal }): Promise<SpaceInfo>
}
