import { createHash } from 'node:crypto'
import { type DatasetRow, type HubDataset, type HubScalar, PINNED_FIELDS } from '@contentops/hub'

/**
 * Fields that are not the meaning of a row (schema §3.6 `hub_observations.semantic_hash`):
 * Hub's service times and the vault walk, which lives in `hub_vault_albums`. A row whose other
 * pinned fields are the same is the same observation: a repeat only moves `last_seen_at`.
 */
const SERVICE_FIELDS = new Set([
  'firstObservedAt',
  'lastObservedAt',
  'rowUpdatedAt',
  'capturedAt',
  'lastFullWalkAt',
  'fullWalkRef',
  'fullWalkObservedCount',
])

function canonical(value: HubScalar | undefined): string {
  return JSON.stringify(value ?? null)
}

/**
 * SHA-256 of the pinned fields of the dataset (SPEC §8.1) without the service fields, in a
 * fixed order: extra fields Hub adds never make a new observation.
 */
export function semanticHash<D extends HubDataset>(dataset: D, row: DatasetRow<D>): Buffer {
  const fields = row.fields as Readonly<Record<string, HubScalar>>
  const parts = Object.keys(PINNED_FIELDS[dataset])
    .filter((field) => !SERVICE_FIELDS.has(field))
    .sort()
    .map((field) => `${JSON.stringify(field)}:${canonical(fields[field])}`)
  return createHash('sha256')
    .update(`{${parts.join(',')}}`)
    .digest()
}
