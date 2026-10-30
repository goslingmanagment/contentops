import {
  HUB_DATASETS,
  type HubDataset,
  type HubFieldKind,
  PINNED_FIELDS,
  type PinnedFieldList,
} from './datasets.ts'
import { badShape, int, isRecord, str, strArray } from './http.ts'

/** Rights of the ContentOps key (SPEC §8.1). */
export const READ_CAPABILITY = 'read:content'
export const PUBLISH_CAPABILITIES = ['write:publication_drafts', 'approve:publications'] as const

export interface CatalogEntry {
  dataset: string
  /** `available` or `planned`. */
  availability: string
  platforms: string[]
  /** The page's own material: a `read:content` key reads it with that right alone. */
  ownContent: boolean
  requiredCapabilities: string[]
  /** Field → kind as Hub declares it (the kind may be one this client does not know). */
  fields: ReadonlyMap<string, string>
}

export interface GrantedPage {
  pageLabel: string
  platform: string
  modelSlug: string | null
}

/** The part of `GET /api/v1/agent/capabilities` the client reads; the rest stays in `raw`. */
export interface HubCapabilities {
  contractHash: string | null
  planeMode: string | null
  archiveGeneration: number | null
  /** Capability → granted; null when the answer carries no key section. */
  grants: ReadonlyMap<string, boolean> | null
  keyExpiresAt: string | null
  pages: GrantedPage[]
  datasets: ReadonlyMap<string, CatalogEntry>
  raw: Record<string, unknown>
}

/**
 * Reads the capabilities document without validating it whole (SPEC §12.0): only
 * `datasets` must be there; extra fields and new sections are ignored.
 */
export function parseCapabilities(json: unknown, endpoint = 'capabilities'): HubCapabilities {
  if (!isRecord(json)) throw badShape(endpoint, 'the answer is not an object')
  if (!Array.isArray(json.datasets)) throw badShape(endpoint, 'no `datasets` list')
  const datasets = new Map<string, CatalogEntry>()
  for (const entry of json.datasets) {
    if (!isRecord(entry)) continue
    const name = str(entry.dataset)
    if (!name) continue
    const fields = new Map<string, string>()
    if (Array.isArray(entry.fields)) {
      for (const f of entry.fields) {
        if (!isRecord(f)) continue
        const field = str(f.field)
        const type = str(f.type)
        if (field && type) fields.set(field, type)
      }
    }
    datasets.set(name, {
      dataset: name,
      availability: str(entry.availability) ?? 'available',
      platforms: strArray(entry.platforms),
      ownContent: entry.ownContent === true,
      requiredCapabilities: strArray(entry.requiredCapabilities),
      fields,
    })
  }
  const contract = isRecord(json.contract) ? json.contract : {}
  const key = isRecord(json.key) ? json.key : null
  let grants: Map<string, boolean> | null = null
  if (key && Array.isArray(key.capabilities)) {
    grants = new Map()
    for (const c of key.capabilities) {
      if (isRecord(c) && typeof c.capability === 'string')
        grants.set(c.capability, c.granted === true)
    }
  }
  const grant = isRecord(json.grant) ? json.grant : {}
  const pages: GrantedPage[] = []
  if (Array.isArray(grant.pages)) {
    for (const p of grant.pages) {
      if (!isRecord(p) || typeof p.pageLabel !== 'string') continue
      pages.push({
        pageLabel: p.pageLabel,
        platform: str(p.platform) ?? 'unknown',
        modelSlug: str(p.modelSlug),
      })
    }
  }
  return {
    contractHash: str(contract.contractHash),
    planeMode: str(contract.planeMode),
    archiveGeneration: int(contract.archiveGeneration),
    grants,
    keyExpiresAt: key ? str(key.expiresAt) : null,
    pages,
    datasets,
    raw: json,
  }
}

export type DatasetProblem =
  /** The catalog does not list the dataset. */
  | { kind: 'dataset_missing' }
  /** Listed, but `planned` (or another state): not addressable. */
  | { kind: 'dataset_not_available'; availability: string }
  /** The key holds neither `read:content` for own material nor the declared rights. */
  | { kind: 'not_granted'; missing: string[] }
  | { kind: 'field_missing'; field: string; expected: HubFieldKind }
  | { kind: 'field_type_changed'; field: string; expected: HubFieldKind; actual: string }

export interface DatasetCheck {
  ok: boolean
  problems: DatasetProblem[]
}

export interface CapabilityCheck {
  /** Every pinned dataset can be read as pinned. */
  ok: boolean
  datasets: Record<HubDataset, DatasetCheck>
  /** Publication through Hub (5б) needs both rights; reading does not. */
  publishing: { ok: boolean; missing: string[] }
}

function granted(caps: HubCapabilities, capability: string): boolean {
  return caps.grants?.get(capability) === true
}

/**
 * Compares the catalog with the pinned field list. A pinned field gone or of another kind
 * is a problem of its dataset; extra fields and extra datasets are fine. The poll of a
 * page stops for the datasets that are not `ok`, with `describeProblem` as the reason.
 */
export function checkCapabilities(
  caps: HubCapabilities,
  pinned: PinnedFieldList = PINNED_FIELDS,
): CapabilityCheck {
  const datasets = {} as Record<HubDataset, DatasetCheck>
  for (const name of HUB_DATASETS) {
    const want = pinned[name] ?? {}
    const entry = caps.datasets.get(name)
    const problems: DatasetProblem[] = []
    if (!entry) {
      problems.push({ kind: 'dataset_missing' })
    } else {
      if (entry.availability !== 'available') {
        problems.push({ kind: 'dataset_not_available', availability: entry.availability })
      }
      if (caps.grants) {
        const byContent = entry.ownContent && granted(caps, READ_CAPABILITY)
        const missing = entry.requiredCapabilities.filter((c) => !granted(caps, c))
        if (!byContent && missing.length > 0) {
          problems.push({
            kind: 'not_granted',
            missing: entry.ownContent ? [READ_CAPABILITY] : missing,
          })
        }
      }
      for (const [field, expected] of Object.entries(want)) {
        const actual = entry.fields.get(field)
        if (actual === undefined) problems.push({ kind: 'field_missing', field, expected })
        else if (actual !== expected) {
          problems.push({ kind: 'field_type_changed', field, expected, actual })
        }
      }
    }
    datasets[name] = { ok: problems.length === 0, problems }
  }
  const missing = caps.grants ? PUBLISH_CAPABILITIES.filter((c) => !granted(caps, c)) : []
  return {
    ok: Object.values(datasets).every((d) => d.ok),
    datasets,
    publishing: { ok: missing.length === 0, missing },
  }
}

/** The reason shown on the page («опрос стоит: …»), in the product's language. */
export function describeProblem(dataset: string, p: DatasetProblem): string {
  switch (p.kind) {
    case 'dataset_missing':
      return `Hub не отдаёт набор ${dataset}`
    case 'dataset_not_available':
      return `набор ${dataset} в Hub недоступен (${p.availability})`
    case 'not_granted':
      return `ключу не выдано право на ${dataset}: ${p.missing.join(', ')}`
    case 'field_missing':
      return `в наборе ${dataset} пропало поле ${p.field}`
    case 'field_type_changed':
      return `в наборе ${dataset} поле ${p.field} сменило тип: ${p.expected} → ${p.actual}`
  }
}
