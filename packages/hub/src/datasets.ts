/**
 * The Hub datasets ContentOps reads and the pinned list of the fields it needs
 * (SPEC §8.1, PLAN 5 E6). The contract change is caught by fields, not by the OpenAPI hash:
 * every run starts with `capabilities`, and `checkCapabilities` compares
 * `capabilities.datasets[].fields` with this list — a field gone or of another type stops
 * the poll of the page with a reason; extra fields are fine.
 *
 * Kinds are Hub's closed scalar union (`AGENT_DATASET_FIELD_KINDS` in Hub
 * `packages/contracts/src/agent-read-datasets.ts`); the field names and kinds below are
 * copied from Hub's registry of 30.10.2026 (Hub #929, #931, #933).
 */

export const HUB_FIELD_KINDS = [
  'string',
  'int',
  'mills',
  'bool',
  'timestamp',
  'date',
  'string_array',
] as const
export type HubFieldKind = (typeof HUB_FIELD_KINDS)[number]

export const HUB_DATASETS = [
  'posts',
  'post_attachments',
  'raw_media',
  'vault_media',
  'capture_coverage',
  'sync_streams',
  'top_media',
  'creator_stats_media_daily',
  'creator_stats_media_likes',
] as const
export type HubDataset = (typeof HUB_DATASETS)[number]

/**
 * Datasets read by change time: `rowUpdatedAt` later than the last successful poll minus
 * 3 h (daily — minus a day). The rest are read whole (`capture_coverage`, `sync_streams`)
 * or by their own day window (statistics).
 */
export const INCREMENTAL_DATASETS = [
  'posts',
  'post_attachments',
  'raw_media',
  'vault_media',
] as const
export type IncrementalDataset = (typeof INCREMENTAL_DATASETS)[number]

export function isIncremental(dataset: HubDataset): dataset is IncrementalDataset {
  return (INCREMENTAL_DATASETS as readonly string[]).includes(dataset)
}

/**
 * Every field ContentOps needs, with its kind. Why each dataset carries what it does:
 *
 * - `posts` — the caption as published, time of going out, number of attachments (not
 *   files), FYP flags and walls (hints only, SPEC §7), first observation for the delay
 *   monitor.
 * - `post_attachments` — post → offer or bundle → platform file: the role (`main`,
 *   `offer_preview`), the link state (`resolved` or a gap), the file's name, duration and
 *   source size for the exact match, `mediaOfferRef` for views and likes.
 * - `raw_media` — the platform file: name, mime, duration, shown and source size, fps,
 *   origin, platform creation time.
 * - `vault_media` — album (id, title), member (id, `customFilename`), the file, membership
 *   date, the last full walk and `missingSince` (only after a full walk).
 * - `capture_coverage`, `sync_streams` — coverage and freshness (`succeededAt`).
 * - `top_media` — the daily top-50 for history before 22.10.2026.
 * - `creator_stats_media_daily`, `creator_stats_media_likes` — views by source (0 For You)
 *   and likes per file per day (Fansly).
 */
export const PINNED_FIELDS = {
  posts: {
    platform: 'string',
    postRef: 'string',
    postText: 'string',
    publishedAt: 'timestamp',
    firstObservedAt: 'timestamp',
    lastObservedAt: 'timestamp',
    rowUpdatedAt: 'timestamp',
    attachmentCount: 'int',
    fypFlags: 'int',
    wallRefs: 'string_array',
  },
  post_attachments: {
    platform: 'string',
    postRef: 'string',
    publishedAt: 'timestamp',
    attachmentIndex: 'int',
    pos: 'int',
    contentType: 'int',
    contentRef: 'string',
    role: 'string',
    memberIndex: 'int',
    bundleRef: 'string',
    mediaOfferRef: 'string',
    previewRef: 'string',
    mediaRef: 'string',
    linkState: 'string',
    filename: 'string',
    mimeType: 'string',
    durationMs: 'int',
    originalWidth: 'int',
    originalHeight: 'int',
    rowUpdatedAt: 'timestamp',
  },
  raw_media: {
    platform: 'string',
    mediaRef: 'string',
    filename: 'string',
    mimeType: 'string',
    mediaType: 'int',
    durationMs: 'int',
    width: 'int',
    height: 'int',
    originalWidth: 'int',
    originalHeight: 'int',
    frameRateMilli: 'int',
    createdAtPlatform: 'timestamp',
    firstOrigin: 'string',
    firstObservedAt: 'timestamp',
    rowUpdatedAt: 'timestamp',
  },
  vault_media: {
    platform: 'string',
    vaultKind: 'string',
    albumRef: 'string',
    albumTitle: 'string',
    lastFullWalkAt: 'timestamp',
    fullWalkRef: 'string',
    fullWalkObservedCount: 'int',
    customFilename: 'string',
    filename: 'string',
    mimeType: 'string',
    durationMs: 'int',
    originalWidth: 'int',
    originalHeight: 'int',
    mediaRef: 'string',
    mediaOfferRef: 'string',
    memberRef: 'string',
    mediaType: 'int',
    createdAtPlatform: 'timestamp',
    missingSince: 'timestamp',
    firstObservedAt: 'timestamp',
    rowUpdatedAt: 'timestamp',
  },
  capture_coverage: {
    platform: 'string',
    plane: 'string',
    scopeRef: 'string',
    status: 'string',
    acquisitionMode: 'string',
    proof: 'string',
    oldestCapturedAt: 'timestamp',
    newestCapturedAt: 'timestamp',
    expectedCount: 'int',
    observedUniqueCount: 'int',
    reasonCode: 'string',
    updatedAt: 'timestamp',
  },
  sync_streams: {
    stream: 'string',
    syncStatus: 'string',
    cursorAt: 'timestamp',
    succeededAt: 'timestamp',
    failedAt: 'timestamp',
    consecutiveFailures: 'int',
  },
  top_media: {
    platform: 'string',
    plane: 'string',
    rank: 'int',
    mediaOfferRef: 'string',
    bundleRef: 'string',
    periodMs: 'int',
    requestedStart: 'timestamp',
    requestedEnd: 'timestamp',
    views: 'int',
    previewViews: 'int',
    observedAt: 'timestamp',
  },
  creator_stats_media_daily: {
    platform: 'string',
    mediaOfferId: 'string',
    mediaId: 'string',
    mediaType: 'int',
    source: 'int',
    sourceLabel: 'string',
    day: 'date',
    views: 'int',
    uniqueViewers: 'int',
    capturedAt: 'timestamp',
  },
  creator_stats_media_likes: {
    platform: 'string',
    mediaOfferId: 'string',
    source: 'int',
    sourceLabel: 'string',
    day: 'date',
    likes: 'int',
    unlikes: 'int',
    capturedAt: 'timestamp',
  },
} as const satisfies Record<HubDataset, Readonly<Record<string, HubFieldKind>>>

export type PinnedFieldList = Readonly<Record<string, Readonly<Record<string, HubFieldKind>>>>

/** A value of Hub's closed scalar union. */
export type HubScalar = string | number | boolean | null | string[]

type KindValue<K> = K extends 'string' | 'timestamp' | 'date'
  ? string
  : K extends 'int' | 'mills'
    ? number
    : K extends 'bool'
      ? boolean
      : K extends 'string_array'
        ? string[]
        : never

/** The pinned fields of a dataset; every one may be null (Hub sends null for «unknown»). */
export type PinnedFields<D extends HubDataset> = {
  readonly [F in keyof (typeof PINNED_FIELDS)[D]]: KindValue<(typeof PINNED_FIELDS)[D][F]> | null
}

/** One row of a dataset: the pinned fields typed, any extra field kept as Hub sent it. */
export interface DatasetRow<D extends HubDataset> {
  /** The row's stable key inside the dataset. */
  key: string
  /** The row's event time the window applies to. */
  occurredAt: string | null
  fields: PinnedFields<D> & Readonly<Record<string, HubScalar>>
}

/** Whether a wire value fits a field kind (null always fits). */
export function valueFitsKind(value: unknown, kind: HubFieldKind): boolean {
  if (value === null) return true
  switch (kind) {
    case 'string':
    case 'timestamp':
    case 'date':
      return typeof value === 'string'
    case 'int':
    case 'mills':
      return typeof value === 'number' && Number.isFinite(value)
    case 'bool':
      return typeof value === 'boolean'
    case 'string_array':
      return Array.isArray(value) && value.every((x) => typeof x === 'string')
  }
}

/** Filter operators of Hub's dataset query. */
export type DatasetFilterOp =
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'in'
  | 'is_null'
  | 'is_not_null'

export interface DatasetFilter {
  field: string
  op: DatasetFilterOp
  value?: string | number | boolean | string[]
}
