import { createHash } from 'node:crypto'
import {
  type DatasetFilter,
  HUB_DATASETS,
  type HubDataset,
  type HubScalar,
  PINNED_FIELDS,
} from '../datasets.ts'
import { FakeHttpServer, type LoggedRequest, type Reply } from './fake-http.ts'

/**
 * A fake Agency Hub for tests (SPEC §12.0): the agent routes ContentOps calls, in memory.
 *
 * - Datasets: rows per page with `rowUpdatedAt` stamped by the fake clock, Hub's
 *   `[from, to)` window, filters, keyset paging with an opaque cursor that pins the scope.
 * - Capabilities: the catalog of the nine datasets — the pinned fields plus a few extra —
 *   which a test changes (`setField`) to see the check stop a poll.
 * - Publications: draft → approved → handed to the platform → published / not_published,
 *   with Hub's idempotency, findings, approve and cancel rules; Hub's own moves are the
 *   test's (`handToPlatform`, `publish`, `notPublish`).
 * - Failures: `fail(kind, { endpoint })` from the base.
 *
 * Everything here is fictional: no real pages, captions or names.
 */

export type FakePlatform = 'fansly' | 'onlyfans'

export interface FakePage {
  pageLabel: string
  platform: FakePlatform
  modelSlug: string
}

export interface FakeHubOptions {
  key?: string
  pages?: FakePage[]
  /** Granted capabilities (default: the ContentOps key's three). */
  grants?: string[]
  /** The fake clock's start (default 2026-11-02T09:00:00Z). */
  now?: Date
  /** Largest upload (default 50 MB). */
  maxFileBytes?: number
}

export const FAKE_HUB_KEY = 'fake-hub-key'

export const DEFAULT_FAKE_PAGES: FakePage[] = [
  { pageLabel: 'page-a', platform: 'fansly', modelSlug: 'model-a' },
  { pageLabel: 'page-b', platform: 'onlyfans', modelSlug: 'model-a' },
  { pageLabel: 'page-c', platform: 'fansly', modelSlug: 'model-b' },
]

const ALL_CAPABILITIES = [
  'read:messages',
  'read:money',
  'read:observations_envelope',
  'read:datasets',
  'request:hydration',
  'write:publication_drafts',
  'approve:publications',
  'write:fan_queues',
  'read:content',
]

/** Fields Hub has beyond the pinned ones: the check must not mind them. */
const EXTRA_FIELDS: Partial<Record<HubDataset, Record<string, string>>> = {
  posts: { inReplyToRef: 'string' },
  post_attachments: { lastObservedAt: 'timestamp', postObservationRef: 'int' },
  raw_media: { ownerAccountRef: 'string', providerType: 'string', updatedAtPlatform: 'timestamp' },
  vault_media: { bundleRef: 'string', lastObservedAt: 'timestamp' },
  creator_stats_media_daily: { impressions: 'int', watchMs: 'int' },
}

/** The event time Hub's window applies to, per dataset (null: no window column). */
const WINDOW_FIELD: Record<HubDataset, string | null> = {
  posts: 'publishedAt',
  post_attachments: 'publishedAt',
  raw_media: 'firstObservedAt',
  vault_media: 'firstObservedAt',
  capture_coverage: 'updatedAt',
  sync_streams: null,
  top_media: 'requestedEnd',
  creator_stats_media_daily: 'day',
  creator_stats_media_likes: 'day',
}

export interface FakeRow {
  key: string
  fields: Record<string, HubScalar>
}

interface FakeFile {
  id: number
  modelSlug: string
  sha256: string
  byteSize: number
  originalName: string | null
  createdAt: string
}

interface FakeMedia {
  role: 'media' | 'preview'
  position: number
  source: 'vault' | 'file'
  mediaRef: string | null
  fileId: number | null
  attachment: number
}

export interface FakePublication {
  id: number
  pageLabel: string
  platform: FakePlatform
  kind: string
  status: string
  version: number
  text: string
  publishAt: string
  wallRefs: string[]
  tierRefs: string[]
  priceMills: number | null
  repost: boolean
  media: FakeMedia[]
  findings: { code: string; severity: string; mediaKey: string | null }[]
  platformPostRef: string | null
  vaultAlbumRef: string | null
  statusReason: string | null
  createdAt: string
  updatedAt: string
  statusChangedAt: string
  idempotencyKey: string
  fingerprint: string
  events: {
    fromStatus: string | null
    toStatus: string
    actorKind: string
    reason: string | null
    at: string
  }[]
}

export interface FakeTargets {
  walls: { wallRef: string; name: string | null; defaultWall: boolean; mainWall: boolean }[]
  tiers: { tierRef: string; name: string | null; pos: number | null }[]
}

const PLATFORM_KINDS: Record<FakePlatform, string[]> = {
  fansly: ['fyp_post', 'subscriber_post', 'paid_post', 'story', 'vault_album'],
  onlyfans: ['subscriber_post', 'paid_post', 'story'],
}

const HANDED = new Set(['submitting', 'scheduled', 'processing', 'published', 'unknown'])

class Refusal extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url')
function unb64(s: string): unknown {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

export class FakeHub extends FakeHttpServer {
  readonly key: string
  readonly pages: FakePage[]
  readonly grants: Set<string>
  /** Bumped by `rebuild()`: older dataset cursors answer 400 `agent_cursor_invalid`. */
  generation = 0
  readonly maxFileBytes: number
  #now: number
  #lastStamp = 0
  #keyRevoked = false
  readonly #rows = new Map<string, Map<string, FakeRow>>()
  readonly #catalog = new Map<HubDataset, Map<string, string>>()
  readonly #availability = new Map<HubDataset, string | null>()
  readonly files = new Map<number, FakeFile>()
  readonly publications = new Map<number, FakePublication>()
  readonly #priceRange = new Map<string, { min: number; max: number }>()
  readonly #targets = new Map<string, FakeTargets>()
  #nextFileId = 1
  #nextPublicationId = 1

  constructor(o: FakeHubOptions = {}) {
    super()
    this.key = o.key ?? FAKE_HUB_KEY
    this.pages = o.pages ?? DEFAULT_FAKE_PAGES
    this.grants = new Set(
      o.grants ?? ['read:content', 'write:publication_drafts', 'approve:publications'],
    )
    this.#now = (o.now ?? new Date('2026-11-02T09:00:00Z')).getTime()
    this.maxFileBytes = o.maxFileBytes ?? 50_000_000
    for (const d of HUB_DATASETS) {
      this.#catalog.set(d, new Map(Object.entries({ ...PINNED_FIELDS[d], ...EXTRA_FIELDS[d] })))
      this.#availability.set(d, 'available')
    }
  }

  // --- clock -------------------------------------------------------------------

  now(): Date {
    return new Date(this.#now)
  }

  setNow(at: Date | string): void {
    this.#now = new Date(at).getTime()
  }

  advance(ms: number): void {
    this.#now += ms
  }

  /** A strictly growing time for Hub's writes. */
  #stamp(): string {
    this.#lastStamp = Math.max(this.#now, this.#lastStamp + 1)
    return new Date(this.#lastStamp).toISOString()
  }

  // --- key, catalog ------------------------------------------------------------

  /** Every later request answers 401 until `restoreKey`. */
  revokeKey(): void {
    this.#keyRevoked = true
  }

  restoreKey(): void {
    this.#keyRevoked = false
  }

  /** Changes the catalog: a kind, or null to drop the field. */
  setField(dataset: HubDataset, field: string, kind: string | null): void {
    const fields = this.#catalog.get(dataset) as Map<string, string>
    if (kind === null) fields.delete(field)
    else fields.set(field, kind)
  }

  /** `planned`, or null to drop the dataset from the catalog. */
  setAvailability(dataset: HubDataset, availability: string | null): void {
    this.#availability.set(dataset, availability)
  }

  /** A Hub rebuild: cursors minted before it are refused. */
  rebuild(): void {
    this.generation++
  }

  // --- datasets ----------------------------------------------------------------

  #table(dataset: HubDataset, page: string): Map<string, FakeRow> {
    const id = `${dataset}:${page}`
    let t = this.#rows.get(id)
    if (!t) {
      t = new Map()
      this.#rows.set(id, t)
    }
    return t
  }

  /**
   * Inserts or replaces rows. A dataset with `rowUpdatedAt` gets it stamped now, unless the
   * row gives its own (not null).
   */
  put(dataset: HubDataset, page: string, rows: readonly FakeRow[]): void {
    const table = this.#table(dataset, page)
    const stamped = 'rowUpdatedAt' in PINNED_FIELDS[dataset]
    for (const row of rows) {
      const fields = { ...row.fields }
      if (stamped && row.fields.rowUpdatedAt == null) fields.rowUpdatedAt = this.#stamp()
      table.set(row.key, { key: row.key, fields })
    }
  }

  rows(dataset: HubDataset, page: string): FakeRow[] {
    return [...this.#table(dataset, page).values()]
  }

  // --- publications: settings and Hub's own moves ------------------------------

  setPriceRange(page: string, range: { min: number; max: number } | null): void {
    if (range) this.#priceRange.set(page, range)
    else this.#priceRange.delete(page)
  }

  setTargets(page: string, targets: FakeTargets): void {
    this.#targets.set(page, targets)
  }

  publication(id: number): FakePublication {
    const p = this.publications.get(id)
    if (!p) throw new Error(`no publication ${id}`)
    return p
  }

  #move(p: FakePublication, to: string, actorKind: string, reason: string | null = null): void {
    const at = this.#stamp()
    p.events.push({ fromStatus: p.status, toStatus: to, actorKind, reason, at })
    p.status = to
    p.statusReason = reason
    p.updatedAt = at
    p.statusChangedAt = at
  }

  #hubMove(
    id: number,
    from: readonly string[],
    to: string,
    reason: string | null = null,
  ): FakePublication {
    const p = this.publication(id)
    if (!from.includes(p.status)) throw new Error(`fake Hub: ${p.status} → ${to} is not Hub's move`)
    this.#move(p, to, 'hub', reason)
    return p
  }

  /** Hub sends the approved publication to the platform's schedule. */
  handToPlatform(id: number): FakePublication {
    this.#hubMove(id, ['approved'], 'submitting')
    return this.#hubMove(id, ['submitting'], 'scheduled')
  }

  /** It went out: the platform's post (or the vault album). */
  publish(id: number, platformRef: string): FakePublication {
    const p = this.#hubMove(id, ['submitting', 'scheduled', 'processing', 'unknown'], 'published')
    if (p.kind === 'vault_album') p.vaultAlbumRef = platformRef
    else p.platformPostRef = platformRef
    return p
  }

  notPublish(id: number, reason: string): FakePublication {
    return this.#hubMove(id, ['scheduled', 'processing'], 'not_published', reason)
  }

  markUnknown(id: number): FakePublication {
    return this.#hubMove(id, ['submitting', 'scheduled', 'processing'], 'unknown', 'answer_lost')
  }

  // --- HTTP --------------------------------------------------------------------

  protected endpointOf(method: string, path: string): string {
    if (method === 'GET' && path === '/api/v1/agent/capabilities') return 'capabilities'
    if (method === 'POST' && /^\/api\/v1\/agent\/pages\/[^/]+\/datasets\/[^/]+\/query$/.test(path))
      return 'dataset'
    if (method === 'POST' && /^\/api\/v1\/agent\/pages\/[^/]+\/publication-files$/.test(path))
      return 'publication-files'
    if (method === 'POST' && /^\/api\/v1\/agent\/pages\/[^/]+\/publications$/.test(path))
      return 'publications.create'
    if (method === 'GET' && /^\/api\/v1\/agent\/pages\/[^/]+\/publication-targets$/.test(path))
      return 'publication-targets'
    if (method === 'GET' && path === '/api/v1/agent/publications/changes')
      return 'publications.changes'
    if (method === 'POST' && path === '/api/v1/agent/publications/approve')
      return 'publications.approve'
    if (method === 'POST' && /^\/api\/v1\/agent\/publications\/\d+\/cancel$/.test(path))
      return 'publications.cancel'
    if (method === 'GET' && /^\/api\/v1\/agent\/publications\/\d+$/.test(path))
      return 'publications.get'
    return 'unknown'
  }

  protected handle(req: LoggedRequest): Reply {
    try {
      if (this.#keyRevoked || req.headers.authorization !== `Bearer ${this.key}`) {
        throw new Refusal(401, 'unauthorized', 'the key is not accepted')
      }
      const seg = req.path.split('/').map(decodeURIComponent)
      switch (req.endpoint) {
        case 'capabilities':
          return { status: 200, body: this.#capabilities() }
        case 'dataset':
          return { status: 200, body: this.#query(seg[5] as string, seg[7] as string, req.json) }
        case 'publication-files':
          return { status: 200, body: this.#upload(seg[5] as string, req) }
        case 'publications.create':
          return { status: 200, body: this.#create(seg[5] as string, req.json) }
        case 'publication-targets':
          return { status: 200, body: this.#targetsOf(seg[5] as string) }
        case 'publications.changes':
          return { status: 200, body: this.#changes(req.query) }
        case 'publications.approve':
          return { status: 200, body: this.#approve(req.json) }
        case 'publications.cancel':
          return { status: 200, body: this.#cancel(Number(seg[5])) }
        case 'publications.get':
          return { status: 200, body: this.#get(Number(seg[5])) }
        default:
          throw new Refusal(404, 'not_found', 'Route not found')
      }
    } catch (e) {
      if (e instanceof Refusal) {
        return {
          status: e.status,
          body: { error: e.code, message: e.message, statusCode: e.status },
        }
      }
      throw e
    }
  }

  #need(...capabilities: string[]): void {
    for (const c of capabilities) {
      if (!this.grants.has(c)) throw new Refusal(403, 'forbidden', `the key lacks ${c}`)
    }
  }

  #page(label: string): FakePage {
    const page = this.pages.find((p) => p.pageLabel === label)
    if (!page) throw new Refusal(404, 'not_found', 'Not found')
    return page
  }

  #capabilities(): object {
    const datasets = HUB_DATASETS.flatMap((d) => {
      const availability = this.#availability.get(d)
      if (availability == null) return []
      return [
        {
          dataset: d,
          availability,
          platforms:
            d.startsWith('creator_stats') || d === 'top_media'
              ? ['fansly']
              : ['fansly', 'onlyfans'],
          moneyBearing: false,
          requiredCapabilities: ['read:datasets', 'read:messages'],
          ownContent: true,
          captureState: 'present',
          fields: [...(this.#catalog.get(d) as Map<string, string>)].map(([field, type]) => ({
            field,
            type,
            filterable: true,
            sortable: ['int', 'mills', 'timestamp', 'date'].includes(type),
          })),
          defaultSort: WINDOW_FIELD[d],
        },
      ]
    })
    const now = this.now()
    return {
      contract: {
        contractHash: 'f'.repeat(64),
        planeMode: 'full',
        searchBackend: 'fts',
        hydrationMode: 'off',
        observationsEnabled: false,
        fanslyReplayMode: 'off',
        archiveGeneration: this.generation,
      },
      key: {
        keyId: 1,
        keyPrefix: 'fake',
        capabilities: ALL_CAPABILITIES.map((capability) => ({
          capability,
          granted: this.grants.has(capability),
        })),
        expiresAt: new Date(now.getTime() + 365 * 86_400_000).toISOString(),
      },
      budgets: { timezone: 'UTC', resetsAt: now.toISOString(), requestsUsed: 0, rowsUsed: 0 },
      limits: {
        paginationDefault: 50,
        paginationMax: 200,
        searchResultMax: 100,
        countProbeMax: 5001,
      },
      grant: {
        pages: this.pages.map((p) => ({ ...p, modelName: p.modelSlug })),
        totalPages: this.pages.length,
      },
      platforms: [],
      planes: [],
      datasets,
      predicates: [],
      claimFields: [],
      delivery: {
        returned: this.pages.length,
        matchedInScope: { value: this.pages.length, exact: true, countBasis: 'post_dedup' },
        cappedBy: null,
        nextCursor: null,
        snapshotExhausted: true,
        caveats: [],
      },
      capture: {
        planes: [],
        observedRowFloor: null,
        gaps: [],
        sourceErrors: [],
        scopeNarrowing: {},
        scopeFieldStates: {},
      },
      conclusion: { blockers: [] },
      // A section a newer Hub might add: the client must not mind it.
      futureSection: { note: 'ignored' },
    }
  }

  #query(pageLabel: string, datasetName: string, body: unknown): object {
    const page = this.#page(pageLabel)
    const dataset = datasetName as HubDataset
    if (!HUB_DATASETS.includes(dataset) || this.#availability.get(dataset) !== 'available') {
      throw new Refusal(400, 'bad_request', 'unknown dataset')
    }
    this.#need('read:content')
    if (typeof body !== 'object' || body === null)
      throw new Refusal(400, 'bad_request', 'a body is required')
    const b = body as {
      from?: string
      to?: string
      filters?: DatasetFilter[]
      sort?: unknown[]
      limit?: number
      cursor?: string
    }
    type Scope = { from: string; to: string; filters: DatasetFilter[]; limit: number }
    type After = { v: number; k: string }
    let scope: Scope
    let after: After | null = null
    if (b.cursor !== undefined) {
      if (
        b.from !== undefined ||
        b.to !== undefined ||
        (b.filters?.length ?? 0) > 0 ||
        (b.sort?.length ?? 0) > 0
      ) {
        throw new Refusal(400, 'bad_request', 'cursor pins the scope; do not resend it')
      }
      const c = unb64(b.cursor) as
        | (Scope & { d: string; p: string; g: number; after: After })
        | null
      if (!c || c.d !== dataset || c.p !== pageLabel || c.g !== this.generation) {
        throw new Refusal(400, 'agent_cursor_invalid', 'cursor is not valid for this request')
      }
      scope = { from: c.from, to: c.to, filters: c.filters, limit: c.limit }
      after = c.after
    } else {
      if (b.from === undefined || b.to === undefined) {
        throw new Refusal(
          400,
          'bad_request',
          '`from` and `to` are required unless a cursor is supplied',
        )
      }
      const limit = b.limit ?? 50
      if (!Number.isInteger(limit) || limit < 1 || limit > 200)
        throw new Refusal(400, 'bad_request', 'limit is 1–200')
      scope = { from: b.from, to: b.to, filters: b.filters ?? [], limit }
    }
    const catalog = this.#catalog.get(dataset) as Map<string, string>
    for (const f of scope.filters) {
      if (!catalog.has(f.field))
        throw new Refusal(400, 'bad_request', `field is not part of the ${dataset} dataset`)
    }
    const windowField = WINDOW_FIELD[dataset]
    const from = Date.parse(scope.from)
    const to = Date.parse(scope.to)
    const at = (row: FakeRow): number | null => {
      if (!windowField) return 0
      const v = row.fields[windowField]
      return typeof v === 'string' ? Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v) : null
    }
    const sortValue = (row: FakeRow) => at(row) ?? 0
    const matching = this.rows(dataset, pageLabel)
      .filter((row) => {
        const t = at(row)
        return t !== null && (!windowField || (t >= from && t < to))
      })
      .filter((row) =>
        scope.filters.every((f) => matches(row.fields[f.field], f, catalog.get(f.field))),
      )
      .sort((x, y) => sortValue(x) - sortValue(y) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
    const from_ = after as After | null
    const rest = from_
      ? matching.filter((row) => {
          const v = sortValue(row)
          return v > from_.v || (v === from_.v && row.key > from_.k)
        })
      : matching
    const items = rest.slice(0, scope.limit)
    const last = items.at(-1)
    const nextCursor =
      items.length === scope.limit && last
        ? b64({
            ...scope,
            d: dataset,
            p: pageLabel,
            g: this.generation,
            after: { v: sortValue(last), k: last.key },
          })
        : null
    return {
      datasetRef: dataset,
      pageLabel,
      platform: page.platform,
      window: { from: scope.from, to: scope.to },
      items: items.map((row) => {
        const t = windowField ? at(row) : null
        return {
          datasetRef: dataset,
          key: row.key,
          occurredAt: t === null ? null : new Date(t).toISOString(),
          fanPlatformUserId: null,
          fields: row.fields,
          fieldStates: {},
          provenance: { ingestPaths: ['fansly_pull'], convergence: 'final', observationRef: null },
        }
      }),
      predicates: [],
      delivery: {
        returned: items.length,
        matchedInScope: { value: matching.length, exact: true, countBasis: 'post_dedup' },
        cappedBy: nextCursor ? 'limit' : null,
        nextCursor,
        snapshotExhausted: false,
        caveats: ['no_frozen_snapshot'],
      },
      capture: {
        planes: [],
        observedRowFloor: null,
        gaps: [],
        sourceErrors: [],
        scopeNarrowing: {},
        scopeFieldStates: {},
      },
      conclusion: {
        blockers: [
          'claim_not_declared',
          ...(nextCursor ? ['delivery_not_exhausted'] : []),
          ...(after ? ['mutable_sort_key_traversal'] : []),
        ],
      },
    }
  }

  #upload(pageLabel: string, req: LoggedRequest): object {
    const page = this.#page(pageLabel)
    this.#need('write:publication_drafts')
    if (req.body.length === 0) throw new Refusal(400, 'bad_request', 'The file is empty')
    if (req.body.length > this.maxFileBytes) {
      throw new Refusal(413, 'publication_file_too_large', 'The file is larger than the limit')
    }
    const sha256 = createHash('sha256').update(req.body).digest('hex')
    const existing = [...this.files.values()].find(
      (f) => f.modelSlug === page.modelSlug && f.sha256 === sha256,
    )
    const file =
      existing ??
      ({
        id: this.#nextFileId++,
        modelSlug: page.modelSlug,
        sha256,
        byteSize: req.body.length,
        originalName: req.query.get('name'),
        createdAt: this.#stamp(),
      } satisfies FakeFile)
    if (!existing) this.files.set(file.id, file)
    return {
      created: !existing,
      file: {
        id: file.id,
        modelId: 1,
        modelSlug: file.modelSlug,
        sha256: file.sha256,
        byteSize: file.byteSize,
        mimeType: 'video/mp4',
        originalName: file.originalName,
        createdByUserId: 1,
        createdAt: file.createdAt,
        storedAt: file.createdAt,
        stored: true,
        bytesDeletedAt: null,
        retainUntil: null,
        uses: [],
      },
    }
  }

  #findings(
    page: FakePage,
    p: Pick<FakePublication, 'media' | 'priceMills' | 'publishAt'>,
  ): FakePublication['findings'] {
    const out: FakePublication['findings'] = []
    if (Date.parse(p.publishAt) <= this.#now)
      out.push({ code: 'publish_time_past', severity: 'blocking', mediaKey: null })
    const vault = new Set(this.rows('vault_media', page.pageLabel).map((r) => r.fields.mediaRef))
    for (const m of p.media) {
      if (m.source === 'vault' && !vault.has(m.mediaRef)) {
        out.push({
          code: 'media_not_on_page',
          severity: 'blocking',
          mediaKey: `vault:${m.mediaRef}`,
        })
      }
      if (m.source === 'file' && this.files.get(m.fileId as number)?.modelSlug !== page.modelSlug) {
        out.push({
          code: 'file_of_another_model',
          severity: 'blocking',
          mediaKey: `file:${m.fileId}`,
        })
      }
    }
    if (p.priceMills !== null) {
      const range = this.#priceRange.get(page.pageLabel)
      if (!range) out.push({ code: 'price_range_not_set', severity: 'blocking', mediaKey: null })
      else if (p.priceMills < range.min || p.priceMills > range.max) {
        out.push({ code: 'price_out_of_range', severity: 'blocking', mediaKey: null })
      }
    }
    return out
  }

  #create(pageLabel: string, body: unknown): object {
    const page = this.#page(pageLabel)
    this.#need('write:publication_drafts')
    const b = (body ?? {}) as Record<string, unknown>
    const { idempotencyKey, ...content } = b
    if (typeof idempotencyKey !== 'string' || idempotencyKey === '') {
      throw new Refusal(400, 'bad_request', 'idempotencyKey is required')
    }
    const kind = String(content.kind)
    if (!PLATFORM_KINDS[page.platform].includes(kind)) {
      throw new Refusal(400, 'bad_request', `${page.platform} pages cannot publish ${kind}`)
    }
    if (typeof content.publishAt !== 'string' || Number.isNaN(Date.parse(content.publishAt))) {
      throw new Refusal(400, 'bad_request', 'publishAt is required')
    }
    const fingerprint = JSON.stringify(content)
    const replay = [...this.publications.values()].find((p) => p.idempotencyKey === idempotencyKey)
    if (replay) {
      if (replay.fingerprint !== fingerprint || replay.pageLabel !== pageLabel) {
        throw new Refusal(
          409,
          'idempotency_mismatch',
          'idempotencyKey was used for a different draft',
        )
      }
      return wire(replay)
    }
    const media: FakeMedia[] = []
    const add = (role: FakeMedia['role'], list: unknown) => {
      for (const [position, m] of (Array.isArray(list) ? list : []).entries()) {
        const item = m as { source: string; mediaRef?: string; fileId?: number }
        if (item.source === 'file' && !this.files.has(item.fileId as number)) {
          throw new Refusal(400, 'bad_request', `file ${item.fileId} does not exist`)
        }
        media.push({
          role,
          position,
          source: item.source === 'vault' ? 'vault' : 'file',
          mediaRef: item.mediaRef ?? null,
          fileId: item.fileId ?? null,
          attachment: 0,
        })
      }
    }
    add('media', content.media)
    add('preview', content.previews)
    if (kind === 'vault_album' && (typeof content.text !== 'string' || content.text === '')) {
      throw new Refusal(
        400,
        'bad_request',
        "a vault album's text is its title: one line, not empty",
      )
    }
    const at = this.#stamp()
    const draft = {
      media,
      priceMills: typeof content.priceMills === 'number' ? content.priceMills : null,
      publishAt: new Date(content.publishAt).toISOString(),
    }
    const p: FakePublication = {
      id: this.#nextPublicationId++,
      pageLabel,
      platform: page.platform,
      kind,
      status: 'draft',
      version: 1,
      text: typeof content.text === 'string' ? content.text : '',
      ...draft,
      wallRefs: Array.isArray(content.wallRefs) ? (content.wallRefs as string[]) : [],
      tierRefs: Array.isArray(content.tierRefs) ? (content.tierRefs as string[]) : [],
      repost: content.repost === true,
      findings: this.#findings(page, draft),
      platformPostRef: null,
      vaultAlbumRef: null,
      statusReason: null,
      createdAt: at,
      updatedAt: at,
      statusChangedAt: at,
      idempotencyKey,
      fingerprint,
      events: [{ fromStatus: null, toStatus: 'draft', actorKind: 'agent', reason: null, at }],
    }
    this.publications.set(p.id, p)
    return wire(p)
  }

  #get(id: number): object {
    this.#need('write:publication_drafts')
    const p = this.publications.get(id)
    if (!p || !this.pages.some((page) => page.pageLabel === p.pageLabel))
      throw new Refusal(404, 'not_found', 'Not found')
    return {
      ...wire(p),
      events: p.events.map((e) => ({ ...e, actorUserId: null, actorAgentKeyId: 1 })),
      revision: null,
    }
  }

  #approve(body: unknown): object {
    this.#need('write:publication_drafts', 'approve:publications')
    const items = (body as { items?: { id: number; version: number }[] } | undefined)?.items
    if (!Array.isArray(items) || items.length === 0)
      throw new Refusal(400, 'bad_request', 'items are required')
    return {
      results: items.map(({ id, version }) => {
        const p = this.publications.get(id)
        if (!p) return { id, outcome: 'refused', reason: 'not_found', publication: null }
        if (p.status !== 'draft')
          return { id, outcome: 'refused', reason: `status_${p.status}`, publication: wire(p) }
        if (p.version !== version)
          return { id, outcome: 'refused', reason: 'version_conflict', publication: wire(p) }
        p.findings = this.#findings(this.#page(p.pageLabel), p)
        if (p.findings.some((f) => f.severity === 'blocking')) {
          return { id, outcome: 'refused', reason: 'blocking_findings', publication: wire(p) }
        }
        this.#move(p, 'approved', 'agent')
        return { id, outcome: 'approved', reason: null, publication: wire(p) }
      }),
    }
  }

  #cancel(id: number): object {
    this.#need('write:publication_drafts')
    const p = this.publications.get(id)
    if (!p) throw new Refusal(404, 'not_found', 'Not found')
    if (p.status === 'cancelled') return wire(p)
    if (p.status === 'draft' || p.status === 'approved') {
      this.#move(p, 'cancelled', 'agent', 'cancelled')
      return wire(p)
    }
    if (HANDED.has(p.status)) {
      throw new Refusal(
        409,
        'publication_handed_to_platform',
        `Hub has handed this publication to the platform (${p.status}): only the owner takes it off, in Hub`,
      )
    }
    throw new Refusal(
      409,
      'publication_not_editable',
      `a ${p.status} publication cannot be cancelled`,
    )
  }

  #changes(query: URLSearchParams): object {
    this.#need('write:publication_drafts')
    const cursorParam = query.get('cursor')
    let since: string | null = query.get('since')
    let limit = Number(query.get('limit') ?? 100)
    let after: { u: string; id: number } | null = null
    if (cursorParam !== null) {
      if (since !== null)
        throw new Refusal(400, 'bad_request', 'cursor pins the listing; do not resend `since`')
      const c = unb64(cursorParam) as {
        since: string | null
        limit: number
        after: { u: string; id: number }
      } | null
      if (!c) throw new Refusal(400, 'agent_cursor_invalid', 'cursor is not valid for this request')
      since = c.since
      limit = c.limit
      after = c.after
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Refusal(400, 'bad_request', 'limit is 1–200')
    const sinceAt = since === null ? null : Date.parse(since)
    const list = [...this.publications.values()]
      .filter((p) => sinceAt === null || Date.parse(p.updatedAt) >= sinceAt)
      .sort((x, y) => Date.parse(x.updatedAt) - Date.parse(y.updatedAt) || x.id - y.id)
      .filter(
        (p) =>
          !after ||
          Date.parse(p.updatedAt) > Date.parse(after.u) ||
          (Date.parse(p.updatedAt) === Date.parse(after.u) && p.id > after.id),
      )
      .slice(0, limit)
    const last = list.at(-1)
    return {
      publications: list.map(wire),
      nextCursor:
        list.length === limit && last
          ? b64({ since, limit, after: { u: last.updatedAt, id: last.id } })
          : null,
    }
  }

  #targetsOf(pageLabel: string): object {
    const page = this.#page(pageLabel)
    this.#need('write:publication_drafts')
    const fallback: FakeTargets =
      page.platform === 'fansly'
        ? {
            walls: [{ wallRef: '7001', name: 'Main wall', defaultWall: true, mainWall: true }],
            tiers: [
              { tierRef: '8001', name: 'Tier one', pos: 0 },
              { tierRef: '8002', name: 'Tier two', pos: 1 },
            ],
          }
        : { walls: [], tiers: [] }
    return { pageLabel, platform: page.platform, ...(this.#targets.get(pageLabel) ?? fallback) }
  }
}

function matches(
  value: HubScalar | undefined,
  f: DatasetFilter,
  kind: string | undefined,
): boolean {
  const v = value ?? null
  if (f.op === 'is_null') return v === null
  if (f.op === 'is_not_null') return v !== null
  if (v === null) return false
  if (f.op === 'in') return Array.isArray(f.value) && f.value.includes(String(v))
  const num = (x: unknown) =>
    kind === 'timestamp' || kind === 'date' ? Date.parse(String(x)) : Number(x)
  const ordered = kind === 'int' || kind === 'mills' || kind === 'timestamp' || kind === 'date'
  const a = ordered ? num(v) : String(v)
  const b = ordered ? num(f.value) : String(f.value)
  switch (f.op) {
    case 'eq':
      return a === b
    case 'neq':
      return a !== b
    case 'lt':
      return a < b
    case 'lte':
      return a <= b
    case 'gt':
      return a > b
    case 'gte':
      return a >= b
  }
}

function wire(p: FakePublication): object {
  return {
    id: p.id,
    pageLabel: p.pageLabel,
    platform: p.platform,
    kind: p.kind,
    status: p.status,
    version: p.version,
    text: p.text,
    publishAt: p.publishAt,
    expiresAt: null,
    wallRefs: p.wallRefs,
    tierRefs: p.tierRefs,
    priceMills: p.priceMills,
    repost: p.repost,
    pinWallRefs: [],
    replyLock: [],
    subscribersOnly: false,
    extraAttachments: [],
    media: p.media,
    findings: p.findings.map((f) => ({
      ...f,
      at: null,
      postRef: null,
      publicationId: null,
      detail: {},
    })),
    blocked: p.findings.some((f) => f.severity === 'blocking'),
    author: { kind: 'agent', userId: null, agentKeyId: 1 },
    approvedRevisionId: null,
    platformPostRef: p.platformPostRef,
    vaultAlbumRef: p.vaultAlbumRef,
    statusReason: p.statusReason,
    previousPublicationId: null,
    withdrawal: null,
    deletion: null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    statusChangedAt: p.statusChangedAt,
  }
}

export async function startFakeHub(options: FakeHubOptions = {}): Promise<FakeHub> {
  return new FakeHub(options).start()
}
