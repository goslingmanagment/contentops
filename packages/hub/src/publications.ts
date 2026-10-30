import { badShape, int, isoTime, isRecord, str } from './http.ts'

/**
 * Publication through Hub (SPEC §7 «Публикация через Hub», PLAN 5б). The words are Hub's
 * (`packages/shared/src/publications.ts`): kinds, statuses and the codes of its checks.
 */

export const PUBLICATION_KINDS = [
  'fyp_post',
  'subscriber_post',
  'paid_post',
  'story',
  'vault_album',
] as const
export type PublicationKind = (typeof PUBLICATION_KINDS)[number]

export const PUBLICATION_STATUSES = [
  'draft',
  'approved',
  'submitting',
  'scheduled',
  'processing',
  'published',
  'not_published',
  'rejected',
  'unknown',
  'missed',
  'withdrawn',
  'cancelled',
] as const
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number]

/** Hub has handed it to the platform: only the owner takes it off, in Hub. */
export const HANDED_TO_PLATFORM: readonly PublicationStatus[] = [
  'submitting',
  'scheduled',
  'processing',
  'published',
  'unknown',
]

/** ContentOps cancels its own publication only while it is a draft or approved. */
export function canCancel(status: string): boolean {
  return status === 'draft' || status === 'approved'
}

/**
 * What the plan row shows (SPEC §7): «в расписании», «вышло», «не вышло: причина»,
 * «не удалось проверить — решает владелец в Hub»; plus the draft and the cancelled one.
 */
export type PublicationRowState =
  | 'draft'
  | 'scheduled'
  | 'published'
  | 'not_published'
  | 'unverified'
  | 'cancelled'

export function publicationRowState(status: string): PublicationRowState {
  switch (status) {
    case 'draft':
      return 'draft'
    case 'approved':
    case 'submitting':
    case 'scheduled':
    case 'processing':
      return 'scheduled'
    case 'published':
      return 'published'
    case 'not_published':
    case 'rejected':
    case 'missed':
    case 'withdrawn':
      return 'not_published'
    case 'cancelled':
      return 'cancelled'
    default:
      // `unknown` and any status this client does not know yet: the owner decides in Hub.
      return 'unverified'
  }
}

/**
 * A file of a draft: one uploaded to Hub (`file:<id>`) or the very same file already in the
 * page's vault (`vault:<mediaRef>`). The same form Hub uses for `findings[].mediaKey`.
 */
export type MediaKey = `vault:${string}` | `file:${number}`

export type PublicationMediaInput =
  | { source: 'vault'; mediaRef: string }
  | { source: 'file'; fileId: number }

export function parseMediaKey(key: string): PublicationMediaInput {
  const vault = key.match(/^vault:([0-9A-Za-z_-]{1,64})$/)
  if (vault?.[1]) return { source: 'vault', mediaRef: vault[1] }
  const file = key.match(/^file:([1-9][0-9]*)$/)
  if (file?.[1]) return { source: 'file', fileId: Number(file[1]) }
  throw new TypeError(`not a media key: ${key}`)
}

/** Who sees a Fansly post: every subscriber, or the subscribers of these tiers. */
export type FanslyAudience =
  | { kind: 'subscribers' }
  | { kind: 'tiers'; tierRefs: readonly string[] }

/** The fields of a plan row a draft is made of (PLAN 4а, SPEC §7). */
export interface DraftInput {
  kind: PublicationKind
  /**
   * The same key with the same draft answers the same publication, so a repeated
   * «Подготовить» after a lost answer makes no second draft; another draft under the
   * same key is refused (`idempotency_mismatch`).
   */
  idempotencyKey: string
  publishAt: Date | string
  /** The caption of a post or a story. */
  caption?: string
  /** A vault album's name (its `text` in Hub; `vault_album` only). */
  albumName?: string
  /** Files in order: uploaded (`file:<id>`) or already in the page's vault. */
  media: readonly MediaKey[]
  /** A paid post's previews, `previews[i]` for `media[i]`. */
  previews?: readonly MediaKey[]
  /** Fansly: every subscriber by default. */
  audience?: FanslyAudience
  /** Fansly walls; empty — the page's default wall. */
  wallRefs?: readonly string[]
  /** Price in mills (1000 = $1); a post with a price needs the page's price range in Hub. */
  priceMills?: number | null
  /** «Перезалив»: the file goes out again on purpose. */
  repost?: boolean
}

/** The body of `POST /api/v1/agent/pages/:pageLabel/publications`. */
export function draftBody(input: DraftInput): Record<string, unknown> {
  let text: string
  if (input.kind === 'vault_album') {
    if (input.caption !== undefined) throw new TypeError('a vault album has a name, not a caption')
    if (!input.albumName) throw new TypeError('a vault album needs its name')
    text = input.albumName
  } else {
    if (input.albumName !== undefined) throw new TypeError('only a vault album has a name')
    text = input.caption ?? ''
  }
  return {
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    text,
    media: input.media.map(parseMediaKey),
    previews: (input.previews ?? []).map(parseMediaKey),
    publishAt: isoTime(input.publishAt),
    wallRefs: [...(input.wallRefs ?? [])],
    tierRefs: input.audience?.kind === 'tiers' ? [...input.audience.tierRefs] : [],
    priceMills: input.priceMills ?? null,
    repost: input.repost ?? false,
  }
}

/** One check of a draft (Hub's `findings`): `price_range_not_set`, `media_not_on_page`… */
export interface PublicationFinding {
  code: string
  /** `blocking`, `warning` or `info`. */
  severity: string
  mediaKey: string | null
  at: string | null
  postRef: string | null
  publicationId: number | null
  detail: Record<string, unknown>
}

/** The part of Hub's publication the client reads; the rest stays in `raw`. */
export interface HubPublication {
  id: number
  pageLabel: string | null
  platform: string | null
  kind: string | null
  status: string
  /** The content version; approve names the version the person saw. */
  version: number
  publishAt: string | null
  statusReason: string | null
  /** The platform's post the publication became: the exact link to the post in Hub. */
  platformPostRef: string | null
  /** A vault album's album on Fansly. */
  vaultAlbumRef: string | null
  /** A blocking finding: the draft cannot be approved as it is. */
  blocked: boolean
  findings: PublicationFinding[]
  updatedAt: string
  statusChangedAt: string | null
  raw: Record<string, unknown>
}

export function parsePublication(json: unknown, endpoint: string): HubPublication {
  if (!isRecord(json)) throw badShape(endpoint, 'the publication is not an object')
  const id = int(json.id)
  const status = str(json.status)
  const version = int(json.version)
  const updatedAt = str(json.updatedAt)
  if (id === null || status === null || version === null || updatedAt === null) {
    throw badShape(endpoint, 'the publication has no id, status, version or updatedAt')
  }
  const findings: PublicationFinding[] = []
  if (Array.isArray(json.findings)) {
    for (const f of json.findings) {
      if (!isRecord(f) || typeof f.code !== 'string') continue
      findings.push({
        code: f.code,
        severity: str(f.severity) ?? 'info',
        mediaKey: str(f.mediaKey),
        at: str(f.at),
        postRef: str(f.postRef),
        publicationId: int(f.publicationId),
        detail: isRecord(f.detail) ? f.detail : {},
      })
    }
  }
  return {
    id,
    pageLabel: str(json.pageLabel),
    platform: str(json.platform),
    kind: str(json.kind),
    status,
    version,
    publishAt: str(json.publishAt),
    statusReason: str(json.statusReason),
    platformPostRef: str(json.platformPostRef),
    vaultAlbumRef: str(json.vaultAlbumRef),
    blocked: json.blocked === true || findings.some((f) => f.severity === 'blocking'),
    findings,
    updatedAt,
    statusChangedAt: str(json.statusChangedAt),
    raw: json,
  }
}

/** Hub's checks of a draft, read again before «Отправить». */
export interface DraftChecks {
  id: number
  status: string
  version: number
  blocked: boolean
  findings: PublicationFinding[]
}

export interface ApproveResult {
  id: number
  outcome: 'approved' | 'refused'
  /** Why it was refused: `blocking_findings`, `version_conflict`, `status_<status>`, `not_found`… */
  reason: string | null
  /**
   * The publication is approved now: by this call, or already by an earlier one whose
   * answer was lost (a repeat answers `refused` with `status_approved` or a later status).
   */
  approved: boolean
  publication: HubPublication | null
}

/** Statuses a publication only reaches through approval. */
const APPROVED_OR_LATER = new Set([
  'approved',
  'submitting',
  'scheduled',
  'processing',
  'published',
  'not_published',
  'rejected',
  'unknown',
  'missed',
  'withdrawn',
])

export function parseApproveResults(json: unknown, endpoint: string): ApproveResult[] {
  if (!isRecord(json) || !Array.isArray(json.results)) throw badShape(endpoint, 'no `results` list')
  return json.results.map((r) => {
    if (!isRecord(r)) throw badShape(endpoint, 'a result is not an object')
    const id = int(r.id)
    const outcome =
      r.outcome === 'approved' ? 'approved' : r.outcome === 'refused' ? 'refused' : null
    if (id === null || outcome === null) throw badShape(endpoint, 'a result has no id or outcome')
    const publication = r.publication == null ? null : parsePublication(r.publication, endpoint)
    const reason = str(r.reason)
    const approved =
      outcome === 'approved' ||
      (publication !== null &&
        reason === `status_${publication.status}` &&
        APPROVED_OR_LATER.has(publication.status))
    return { id, outcome, reason, approved, publication }
  })
}

/** A Fansly wall or subscription tier a draft may name (no prices). */
export interface PublicationTargets {
  pageLabel: string
  platform: string | null
  walls: { wallRef: string; name: string | null; defaultWall: boolean; mainWall: boolean }[]
  tiers: { tierRef: string; name: string | null; pos: number | null }[]
}

export function parseTargets(json: unknown, endpoint: string, page: string): PublicationTargets {
  if (!isRecord(json) || !Array.isArray(json.walls) || !Array.isArray(json.tiers)) {
    throw badShape(endpoint, 'no `walls` or `tiers` list')
  }
  return {
    pageLabel: str(json.pageLabel) ?? page,
    platform: str(json.platform),
    walls: json.walls.filter(isRecord).flatMap((w) => {
      const wallRef = str(w.wallRef)
      return wallRef
        ? [
            {
              wallRef,
              name: str(w.name),
              defaultWall: w.defaultWall === true,
              mainWall: w.mainWall === true,
            },
          ]
        : []
    }),
    tiers: json.tiers.filter(isRecord).flatMap((t) => {
      const tierRef = str(t.tierRef)
      return tierRef ? [{ tierRef, name: str(t.name), pos: int(t.pos) }] : []
    }),
  }
}

/** An uploaded file of publications (metadata only). */
export interface PublicationFile {
  id: number
  sha256: string
  byteSize: number | null
  mimeType: string | null
  originalName: string | null
  /** False once Hub's retention deleted the bytes (7 days); uploading again brings them back. */
  stored: boolean
  retainUntil: string | null
  raw: Record<string, unknown>
}

export interface UploadResult {
  file: PublicationFile
  /** False when Hub already had these bytes for the model: the same file id answers. */
  created: boolean
}

export function parseUpload(json: unknown, endpoint: string): UploadResult {
  if (!isRecord(json) || !isRecord(json.file) || typeof json.created !== 'boolean') {
    throw badShape(endpoint, 'no `file` or `created`')
  }
  const f = json.file
  const id = int(f.id)
  const sha256 = str(f.sha256)
  if (id === null || sha256 === null) throw badShape(endpoint, 'the file has no id or sha256')
  return {
    created: json.created,
    file: {
      id,
      sha256,
      byteSize: int(f.byteSize),
      mimeType: str(f.mimeType),
      originalName: str(f.originalName),
      stored: f.stored !== false,
      retainUntil: str(f.retainUntil),
      raw: f,
    },
  }
}
