import { addMinutes } from '../clock'
import type { Instant, LocalDate } from '../domain/common'
import type { Evidence, ExactMatch, PersonName, SurfaceKind } from '../domain/placement'

/** Short constructors of evidence records with stable ids for fixtures. */
export interface EvidenceFactory {
  hubExact(
    postAt: Instant,
    match: ExactMatch,
    fileName?: string | null,
    duration?: { ours_s: number; theirs_s: number } | null,
  ): Evidence
  hubCandidate(postAt: Instant, offsetMin: number, summary: string): Evidence
  hubPartial(recordedAt: Instant, matched: number, total: number, missing: string): Evidence
  hubMismatch(
    postAt: Instant,
    field: 'duration' | 'attachments',
    ours: string,
    theirs: string,
  ): Evidence
  hubSurfaceUnknown(postAt: Instant): Evidence
  hubUnplanned(postAt: Instant, surface: SurfaceKind, summary: string): Evidence
  vaultMissing(recordedAt: Instant, album: string, walkedOn: LocalDate): Evidence
  vaultStale(recordedAt: Instant, album: string, fileOn: LocalDate, rowOn: LocalDate): Evidence
  manualConfirm(by: PersonName, at: Instant, basis: 'pair' | 'report'): Evidence
  manualReject(by: PersonName, at: Instant, rejects: string | null): Evidence
  manualEarlier(recordedAt: Instant, confirmedOn: LocalDate): Evidence
  legacyClaim(recordedAt: Instant, label: string, on: LocalDate): Evidence
  outside(by: PersonName, at: Instant): Evidence
}

/** Hub sees a post about three hours after it goes out (`research/07-data-sizing.md` §2.2). */
const HUB_LAG_MIN = 180

export function createEvidenceFactory(prefix: string): EvidenceFactory {
  let counter = 0
  const id = () => `${prefix}-${++counter}`
  const seen = (postAt: Instant) => addMinutes(postAt, HUB_LAG_MIN)
  return {
    hubExact: (postAt, match, fileName = null, duration = null) => ({
      id: id(),
      kind: 'hub_exact',
      recorded_at: seen(postAt),
      post_at: postAt,
      match,
      file_name: fileName,
      duration,
    }),
    hubCandidate: (postAt, offsetMin, summary) => ({
      id: id(),
      kind: 'hub_candidate',
      recorded_at: seen(postAt),
      post_at: postAt,
      offset_min: offsetMin,
      summary,
    }),
    hubPartial: (recordedAt, matched, total, missing) => ({
      id: id(),
      kind: 'hub_partial',
      recorded_at: recordedAt,
      matched,
      total,
      missing,
    }),
    hubMismatch: (postAt, field, ours, theirs) => ({
      id: id(),
      kind: 'hub_mismatch',
      recorded_at: seen(postAt),
      post_at: postAt,
      field,
      ours,
      theirs,
    }),
    hubSurfaceUnknown: (postAt) => ({
      id: id(),
      kind: 'hub_surface_unknown',
      recorded_at: seen(postAt),
      post_at: postAt,
    }),
    hubUnplanned: (postAt, surface, summary) => ({
      id: id(),
      kind: 'hub_unplanned',
      recorded_at: seen(postAt),
      post_at: postAt,
      surface_seen: surface,
      summary,
    }),
    vaultMissing: (recordedAt, album, walkedOn) => ({
      id: id(),
      kind: 'vault_missing',
      recorded_at: recordedAt,
      album,
      walked_on: walkedOn,
    }),
    vaultStale: (recordedAt, album, fileOn, rowOn) => ({
      id: id(),
      kind: 'vault_stale',
      recorded_at: recordedAt,
      album,
      file_on: fileOn,
      row_on: rowOn,
    }),
    manualConfirm: (by, at, basis) => ({
      id: id(),
      kind: 'manual_confirm',
      recorded_at: at,
      by,
      basis,
    }),
    manualReject: (by, at, rejects) => ({
      id: id(),
      kind: 'manual_reject',
      recorded_at: at,
      by,
      rejects,
    }),
    manualEarlier: (recordedAt, confirmedOn) => ({
      id: id(),
      kind: 'manual_earlier',
      recorded_at: recordedAt,
      confirmed_on: confirmedOn,
    }),
    legacyClaim: (recordedAt, label, on) => ({
      id: id(),
      kind: 'legacy_claim',
      recorded_at: recordedAt,
      label,
      on,
    }),
    outside: (by, at) => ({ id: id(), kind: 'outside_catalog', recorded_at: at, by }),
  }
}
