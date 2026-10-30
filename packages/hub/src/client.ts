import { createHash } from 'node:crypto'
import { type HubCapabilities, parseCapabilities } from './capabilities.ts'
import {
  type DatasetFilter,
  type DatasetRow,
  type HubDataset,
  type HubScalar,
  type IncrementalDataset,
  isIncremental,
  PINNED_FIELDS,
  valueFitsKind,
} from './datasets.ts'
import { HubError } from './errors.ts'
import { badShape, callJson, type HttpContext, isoTime, isRecord, str, strArray } from './http.ts'
import {
  type ApproveResult,
  type DraftChecks,
  type DraftInput,
  draftBody,
  type HubPublication,
  type PublicationTargets,
  parseApproveResults,
  parsePublication,
  parseTargets,
  parseUpload,
  type UploadResult,
} from './publications.ts'
import { DEFAULT_RETRY, type RetryPolicy, withRetry } from './retry.ts'

/** The start of the default dataset window: older than any history Hub holds. */
export const HUB_WINDOW_FLOOR = '2020-01-01T00:00:00.000Z'
/** Hub's page size ceiling; the client asks for full pages by default. */
export const HUB_PAGE_LIMIT_MAX = 200

export interface HubClientOptions {
  /** `https://hub.example/` — the agent routes live under `/api/v1/agent/`. */
  baseUrl: string
  /** The ContentOps agent key (bearer). Never logged. */
  key: string
  fetch?: typeof fetch
  retry?: RetryPolicy
  /** Per-request limit of JSON calls (default 60 s); uploads have none. */
  timeoutMs?: number
  /** Clock for the default window and the time of `auth_rejected` (tests pass a fixed one). */
  now?: () => Date
}

export interface ReadDatasetOptions<D extends HubDataset> {
  page: string
  /**
   * Rows changed at or after this time (`rowUpdatedAt`) — the hourly and daily poll
   * (`planPoll`). Only for the datasets that carry `rowUpdatedAt`.
   */
  updatedSince?: D extends IncrementalDataset ? Date | string : never
  /** Hub's window over the row's event time; default `[HUB_WINDOW_FLOOR, now + 1 day)`. */
  from?: Date | string
  to?: Date | string
  /** Extra filters (`albumRef eq …`, `day gte …`). */
  filters?: readonly DatasetFilter[]
  /**
   * Resume a read from a saved `nextCursor`. The cursor pins the whole scope, so the
   * window, filters and `updatedSince` are not sent with it. A cursor from before a Hub
   * rebuild is refused with `agent_cursor_invalid`: start the read again.
   */
  cursor?: string
  /** Rows per page, 1–200 (default 200). */
  limit?: number
  signal?: AbortSignal
}

/** One page of a dataset read. */
export interface DatasetPage<D extends HubDataset> {
  dataset: D
  page: string
  platform: string | null
  window: { from: string; to: string } | null
  rows: DatasetRow<D>[]
  /** Continue from here; null — the last page. */
  nextCursor: string | null
  /** Hub's `conclusion.blockers`: every reason the answer is narrower than the question. */
  blockers: string[]
  /** Hub's `capture` section as sent (coverage gaps, capture floor). */
  capture: unknown
}

export interface UploadInput {
  /** The upload's name on the platform: naming §5–6 (`PPV-073_…_platform.mp4`). */
  name: string
  /** The bytes; SHA-256 is computed here. */
  bytes?: Uint8Array
  /**
   * Or a stream opened anew for every attempt, with its size and SHA-256 (ContentOps knows
   * both for the copy for the platform).
   */
  open?: () => ReadableStream<Uint8Array>
  size?: number
  sha256?: string
  signal?: AbortSignal
}

export interface ChangesPage {
  publications: HubPublication[]
  nextCursor: string | null
}

export interface HubClient {
  capabilities(signal?: AbortSignal): Promise<HubCapabilities>
  /** Every page of a dataset read, one request each (retried on 429/5xx/cut). */
  readDataset<D extends HubDataset>(
    dataset: D,
    options: ReadDatasetOptions<D>,
  ): AsyncGenerator<DatasetPage<D>, void, undefined>
  /** Uploads one file for the page's model; the same bytes answer the same id, `created: false`. */
  uploadPublicationFile(page: string, input: UploadInput): Promise<UploadResult>
  /** Drafts a publication; Hub checks it at once (`findings`, `blocked`). */
  createDraft(page: string, draft: DraftInput, signal?: AbortSignal): Promise<HubPublication>
  /** Hub's checks of a publication, read again (before «Отправить»). */
  getDraftChecks(id: number, signal?: AbortSignal): Promise<DraftChecks>
  getPublication(id: number, signal?: AbortSignal): Promise<HubPublication>
  /** Approves in order; each is checked again. Safe to repeat: see `ApproveResult.approved`. */
  approve(
    items: readonly { id: number; version: number }[],
    signal?: AbortSignal,
  ): Promise<ApproveResult[]>
  /** This key's publications changed at or after `since` (null — all), oldest change first. */
  changesSince(
    since: Date | string | null,
    options?: { limit?: number; cursor?: string; signal?: AbortSignal },
  ): AsyncGenerator<ChangesPage, void, undefined>
  /**
   * Cancels this key's publication while Hub has not handed it to the platform. Safe to
   * repeat (a cancelled one answers as it is); later — `refused`
   * `publication_handed_to_platform`.
   */
  cancel(id: number, signal?: AbortSignal): Promise<HubPublication>
  /** The page's Fansly walls and tiers a draft may name. */
  publicationTargets(page: string, signal?: AbortSignal): Promise<PublicationTargets>
}

const enc = encodeURIComponent

export function createHubClient(options: HubClientOptions): HubClient {
  const ctx: HttpContext = {
    baseUrl: options.baseUrl,
    key: options.key,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? 60_000,
    now: options.now ?? (() => new Date()),
  }
  const policy = options.retry ?? DEFAULT_RETRY

  // Every command below is safe to repeat by Hub's own rules (upload by SHA-256, a draft by
  // its idempotency key, approve and cancel answer the reached state), so an answer lost
  // to a cut or a 5xx is retried like a read.
  const json = (endpoint: string, init: Parameters<typeof callJson>[2]) =>
    withRetry(() => callJson(ctx, endpoint, init), policy, init.signal)

  async function* readDataset<D extends HubDataset>(
    dataset: D,
    o: ReadDatasetOptions<D>,
  ): AsyncGenerator<DatasetPage<D>, void, undefined> {
    const endpoint = 'dataset'
    const limit = o.limit ?? HUB_PAGE_LIMIT_MAX
    if (!Number.isInteger(limit) || limit < 1 || limit > HUB_PAGE_LIMIT_MAX) {
      throw new RangeError(`limit is 1–${HUB_PAGE_LIMIT_MAX}`)
    }
    if (o.updatedSince !== undefined && !isIncremental(dataset)) {
      throw new TypeError(`${dataset} has no rowUpdatedAt: read it whole`)
    }
    const filters: DatasetFilter[] = [...(o.filters ?? [])]
    if (o.updatedSince !== undefined) {
      filters.push({ field: 'rowUpdatedAt', op: 'gte', value: isoTime(o.updatedSince) })
    }
    const scope = {
      from: isoTime(o.from ?? HUB_WINDOW_FLOOR),
      to: isoTime(o.to ?? new Date(ctx.now().getTime() + 24 * 60 * 60_000)),
      filters,
      limit,
    }
    const path = `api/v1/agent/pages/${enc(o.page)}/datasets/${enc(dataset)}/query`
    let cursor = o.cursor ?? null
    const seen = new Set<string>()
    do {
      const body = cursor === null ? scope : { cursor }
      const answer = await json(endpoint, { method: 'POST', path, json: body, signal: o.signal })
      const page = parseDatasetPage(dataset, o.page, answer, endpoint)
      yield page
      cursor = page.nextCursor
      if (cursor !== null) {
        if (seen.has(cursor)) throw badShape(endpoint, 'the same cursor came twice')
        seen.add(cursor)
      }
    } while (cursor !== null)
  }

  async function* changesSince(
    since: Date | string | null,
    o: { limit?: number; cursor?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<ChangesPage, void, undefined> {
    const endpoint = 'publications.changes'
    let cursor = o.cursor ?? null
    const first: Record<string, string | undefined> = {
      since: since === null ? undefined : isoTime(since),
      limit: String(o.limit ?? HUB_PAGE_LIMIT_MAX),
    }
    const seen = new Set<string>()
    do {
      const answer = await json(endpoint, {
        method: 'GET',
        path: 'api/v1/agent/publications/changes',
        query: cursor === null ? first : { cursor },
        signal: o.signal,
      })
      if (!isRecord(answer) || !Array.isArray(answer.publications)) {
        throw badShape(endpoint, 'no `publications` list')
      }
      const nextCursor = str(answer.nextCursor)
      yield {
        publications: answer.publications.map((p) => parsePublication(p, endpoint)),
        nextCursor,
      }
      cursor = nextCursor
      if (cursor !== null) {
        if (seen.has(cursor)) throw badShape(endpoint, 'the same cursor came twice')
        seen.add(cursor)
      }
    } while (cursor !== null)
  }

  async function uploadPublicationFile(page: string, input: UploadInput): Promise<UploadResult> {
    const endpoint = 'publication-files'
    let sha256: string
    let size: number
    let body: () => Uint8Array | ReadableStream<Uint8Array>
    if (input.bytes) {
      const bytes = input.bytes
      sha256 = createHash('sha256').update(bytes).digest('hex')
      size = bytes.byteLength
      body = () => bytes
    } else if (input.open && input.size !== undefined && input.sha256) {
      sha256 = input.sha256.toLowerCase()
      size = input.size
      body = input.open
    } else {
      throw new TypeError('upload needs `bytes`, or `open` with `size` and `sha256`')
    }
    const result = await withRetry(
      async () =>
        parseUpload(
          await callJson(ctx, endpoint, {
            method: 'POST',
            path: `api/v1/agent/pages/${enc(page)}/publication-files`,
            query: { name: input.name },
            body: body(),
            headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) },
            signal: input.signal,
            timeout: false,
          }),
          endpoint,
        ),
      policy,
      input.signal,
      // 409 `conflict`: the same bytes arrived at the same moment (our own lost attempt).
      (e) => e.retryable || (e.status === 409 && e.code === 'conflict'),
    )
    if (result.file.sha256.toLowerCase() !== sha256) {
      throw new HubError('bad_response', `${endpoint}: Hub keeps other bytes than were sent`, {
        endpoint,
        at: ctx.now(),
      })
    }
    return result
  }

  async function getPublication(id: number, signal?: AbortSignal): Promise<HubPublication> {
    const endpoint = 'publications.get'
    return parsePublication(
      await json(endpoint, { method: 'GET', path: `api/v1/agent/publications/${id}`, signal }),
      endpoint,
    )
  }

  return {
    async capabilities(signal) {
      const endpoint = 'capabilities'
      return parseCapabilities(
        await json(endpoint, { method: 'GET', path: 'api/v1/agent/capabilities', signal }),
        endpoint,
      )
    },
    readDataset,
    uploadPublicationFile,
    async createDraft(page, draft, signal) {
      const endpoint = 'publications.create'
      return parsePublication(
        await json(endpoint, {
          method: 'POST',
          path: `api/v1/agent/pages/${enc(page)}/publications`,
          json: draftBody(draft),
          signal,
        }),
        endpoint,
      )
    },
    async getDraftChecks(id, signal) {
      const p = await getPublication(id, signal)
      return {
        id: p.id,
        status: p.status,
        version: p.version,
        blocked: p.blocked,
        findings: p.findings,
      }
    },
    getPublication,
    async approve(items, signal) {
      const endpoint = 'publications.approve'
      return parseApproveResults(
        await json(endpoint, {
          method: 'POST',
          path: 'api/v1/agent/publications/approve',
          json: { items: items.map(({ id, version }) => ({ id, version })) },
          signal,
        }),
        endpoint,
      )
    },
    changesSince,
    async cancel(id, signal) {
      const endpoint = 'publications.cancel'
      return parsePublication(
        await json(endpoint, {
          method: 'POST',
          path: `api/v1/agent/publications/${id}/cancel`,
          // Every POST of the agent plane carries a body.
          json: {},
          signal,
        }),
        endpoint,
      )
    },
    async publicationTargets(page, signal) {
      const endpoint = 'publication-targets'
      return parseTargets(
        await json(endpoint, {
          method: 'GET',
          path: `api/v1/agent/pages/${enc(page)}/publication-targets`,
          signal,
        }),
        endpoint,
        page,
      )
    },
  }
}

/**
 * Reads one answer of the dataset query without validating it whole: `items` and
 * `delivery.nextCursor` must be there, every row needs a key and a flat `fields` map, and a
 * pinned field that is present must be of its kind; extra fields and sections pass.
 */
export function parseDatasetPage<D extends HubDataset>(
  dataset: D,
  page: string,
  json: unknown,
  endpoint = 'dataset',
): DatasetPage<D> {
  if (!isRecord(json) || !Array.isArray(json.items)) throw badShape(endpoint, 'no `items` list')
  const delivery = isRecord(json.delivery) ? json.delivery : null
  if (!delivery || !('nextCursor' in delivery)) throw badShape(endpoint, 'no `delivery.nextCursor`')
  const nextCursor = delivery.nextCursor === null ? null : str(delivery.nextCursor)
  if (delivery.nextCursor !== null && nextCursor === null) {
    throw badShape(endpoint, '`delivery.nextCursor` is not a string')
  }
  const pinned: Readonly<Record<string, string>> = PINNED_FIELDS[dataset]
  const rows = json.items.map((item, i): DatasetRow<D> => {
    if (!isRecord(item) || typeof item.key !== 'string' || !isRecord(item.fields)) {
      throw badShape(endpoint, `${dataset} row ${i} has no key or fields`)
    }
    const fields: Record<string, HubScalar> = { ...(item.fields as Record<string, HubScalar>) }
    for (const [field, kind] of Object.entries(pinned)) {
      const value = fields[field]
      if (value === undefined) {
        fields[field] = null
      } else if (!valueFitsKind(value, kind as Parameters<typeof valueFitsKind>[1])) {
        throw badShape(endpoint, `${dataset} row ${i}: ${field} is not ${kind}`)
      }
    }
    return {
      key: item.key,
      occurredAt: str(item.occurredAt),
      fields: fields as DatasetRow<D>['fields'],
    }
  })
  const window = isRecord(json.window) ? json.window : null
  const conclusion = isRecord(json.conclusion) ? json.conclusion : {}
  return {
    dataset,
    page: str(json.pageLabel) ?? page,
    platform: str(json.platform),
    window:
      window && typeof window.from === 'string' && typeof window.to === 'string'
        ? { from: window.from, to: window.to }
        : null,
    rows,
    nextCursor,
    blockers: strArray(conclusion.blockers),
    capture: json.capture ?? null,
  }
}
