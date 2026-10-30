import { addDays, mskInstant } from '@contentops/contracts/clock'
import type { CatalogEntry } from '@contentops/contracts/domain/catalog'
import type {
  AccountCode,
  Instant,
  LocalDate,
  LocalTime,
} from '@contentops/contracts/domain/common'
import type { ItemId } from '@contentops/contracts/domain/item-type'
import type { UniqLevel } from '@contentops/contracts/domain/model'
import type {
  CancelReason,
  CopyState,
  Evidence,
  MarkKind,
  SurfaceKind,
} from '@contentops/contracts/domain/placement'
import type { CaseExtras, PlacementTrack, PlanRowRecord, TrackStats } from './world-types'

/** A compact description of a plan row and the facts around it. */
export interface RowSpec {
  date: LocalDate
  time: LocalTime | null
  account: AccountCode
  surface: SurfaceKind
  item: ItemId | null
  version?: { no: number; level: UniqLevel }
  assignee: string
  created_by?: string
  created_at?: Instant
  mark?: { kind: MarkKind; at: Instant; by?: string; stated?: Instant; current?: boolean }
  cancelled?: { at: Instant; by: string; reason: CancelReason | null }
  release?: string
  requires_new_upload?: boolean
  has_newer_version?: boolean
  second_person_blocked?: boolean
  album?: string
  copy?: CopyState
  note?: string
  awaiting?: PlanRowRecord['awaiting_montage']
  downloaded?: PlanRowRecord['downloaded']
  evidence?: Evidence[]
  extras?: CaseExtras
  caption?: string
  stats?: TrackStats
}

export interface BuiltRow {
  row: PlanRowRecord
  track: PlacementTrack | null
}

/** Platform copy: about 1,4 МБ a second of video, 2,4 МБ a photo, a teaser — 30 s. */
export const PLATFORM_VIDEO_BYTES_PER_SECOND = 1_400_000
export const PLATFORM_PHOTO_BYTES = 2_400_000
const TEASER_SECONDS = 30

/**
 * Size of the platform copy of a row (DESIGN §6.4: a release day is ≈1,4 ГБ a page): by
 * the object's length and type — the picked frames of a set, photos of life and sexting,
 * a teaser for stories.
 */
export function copyBytes(
  entry: Pick<CatalogEntry, 'type' | 'duration_s' | 'photo_count' | 'selected_count'>,
  surface: SurfaceKind,
): number {
  if (surface === 'story' && entry.type === 'ppv') {
    return TEASER_SECONDS * PLATFORM_VIDEO_BYTES_PER_SECOND
  }
  if (entry.type === 'set') {
    return (entry.selected_count || entry.photo_count || 1) * PLATFORM_PHOTO_BYTES
  }
  if (entry.type === 'life' || entry.type === 'sexting') {
    return (entry.photo_count ?? 1) * PLATFORM_PHOTO_BYTES
  }
  return Math.round((entry.duration_s ?? 20) * PLATFORM_VIDEO_BYTES_PER_SECOND)
}

/** Rows are put into the plan the day before by default, in the morning. */
function defaultCreatedAt(date: LocalDate): Instant {
  return mskInstant(addDays(date, -1), '10:15')
}

export function createRowBuilder(
  prefix: string,
  /** Copy size of an object on a place; without it every copy weighs 18 МБ. */
  copySizeOf: (item: ItemId, surface: SurfaceKind) => number = () => 18_000_000,
) {
  let counter = 0
  return (spec: RowSpec): BuiltRow => {
    counter += 1
    const id = `${prefix}-${String(counter).padStart(3, '0')}`
    const row: PlanRowRecord = {
      id,
      date: spec.date,
      time: spec.time,
      account: spec.account,
      surface: spec.surface,
      item_id: spec.item,
      fyp_version: spec.version ?? null,
      assignee: spec.assignee,
      mark: spec.mark
        ? {
            kind: spec.mark.kind,
            at: spec.mark.at,
            by: spec.mark.by ?? spec.assignee,
            stated_occurred_at: spec.mark.stated ?? null,
            for_current_manifest: spec.mark.current ?? true,
          }
        : null,
      cancelled: spec.cancelled ?? null,
      release_id: spec.release ?? null,
      requires_new_upload: spec.requires_new_upload ?? false,
      has_newer_version: spec.has_newer_version ?? false,
      second_person_blocked: spec.second_person_blocked ?? false,
      note: spec.note ?? null,
      album: spec.album ?? null,
      copy:
        spec.copy ??
        (spec.item ? { state: 'ready', size_bytes: copySizeOf(spec.item, spec.surface) } : null),
      downloaded: spec.downloaded ?? null,
      awaiting_montage: spec.awaiting ?? null,
      created_by: spec.created_by ?? spec.assignee,
      created_at: spec.created_at ?? defaultCreatedAt(spec.date),
      version: 1,
    }
    const needsTrack = Boolean(spec.evidence?.length || spec.extras || spec.stats || spec.caption)
    const track: PlacementTrack | null = needsTrack
      ? {
          id: `t-${id}`,
          item_id: spec.item,
          account: spec.account,
          surface: spec.surface,
          plan_row_id: id,
          evidence: spec.evidence ?? [],
          album: spec.album ?? null,
          caption: spec.caption ?? null,
          stats: spec.stats ?? null,
          extras: spec.extras ?? null,
        }
      : null
    return { row, track }
  }
}

/** A track without a plan row: history before ContentOps or a post Hub saw by itself. */
export function createTrackBuilder(prefix: string) {
  let counter = 0
  return (
    spec: Omit<PlacementTrack, 'id' | 'plan_row_id' | 'album' | 'caption' | 'stats' | 'extras'> &
      Partial<Pick<PlacementTrack, 'album' | 'caption' | 'stats' | 'extras'>>,
  ): PlacementTrack => {
    counter += 1
    return {
      id: `${prefix}-${String(counter).padStart(4, '0')}`,
      plan_row_id: null,
      album: spec.album ?? null,
      caption: spec.caption ?? null,
      stats: spec.stats ?? null,
      extras: spec.extras ?? null,
      ...spec,
    }
  }
}
