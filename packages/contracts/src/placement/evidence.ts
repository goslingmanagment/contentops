import { instantMs } from '../clock'
import type { Evidence, EvidenceKind } from '../domain/placement'

/** Picking evidence of a kind, and dropping questions answered with «Не то». */

export type EvidenceOf<K extends EvidenceKind> = Extract<Evidence, { kind: K }>

/** Evidence that asks a person to look: every ◆ case of «Сверить». */
export const QUESTION_KINDS: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>([
  'hub_candidate',
  'hub_partial',
  'hub_mismatch',
  'hub_conflict',
  'hub_surface_unknown',
  'hub_unplanned',
  'vault_missing',
  'vault_stale',
])

export function allOf<K extends EvidenceKind>(
  evidence: readonly Evidence[],
  kind: K,
): EvidenceOf<K>[] {
  return evidence.filter((item): item is EvidenceOf<K> => item.kind === kind)
}

/** The most recent evidence of a kind. */
export function latest<K extends EvidenceKind>(
  evidence: readonly Evidence[],
  kind: K,
): EvidenceOf<K> | null {
  return allOf(evidence, kind).reduce<EvidenceOf<K> | null>(
    (found, item) =>
      !found || instantMs(item.recorded_at) >= instantMs(found.recorded_at) ? item : found,
    null,
  )
}

/** Drops questions answered with «Не то»: by id, or every earlier one when the reject has no id. */
export function openEvidence(evidence: readonly Evidence[]): Evidence[] {
  const rejects = allOf(evidence, 'manual_reject')
  return evidence.filter((item) => {
    if (!QUESTION_KINDS.has(item.kind)) return true
    return !rejects.some((reject) =>
      reject.rejects === null
        ? instantMs(reject.recorded_at) >= instantMs(item.recorded_at)
        : reject.rejects === item.id,
    )
  })
}
