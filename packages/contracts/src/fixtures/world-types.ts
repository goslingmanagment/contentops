import type { AccessGrant, AiSettings, Session } from '../domain/admin'
import type { Agent } from '../domain/agents'
import type { CatalogEntry, RecentItem } from '../domain/catalog'
import type { AccountCode, Instant, LocalDate, LocalTime, ModelCode } from '../domain/common'
import type { FypVersion, ItemFile, MasterFrame } from '../domain/files'
import type { InboxGroup, ReadyNote } from '../domain/inbox'
import type { Integration } from '../domain/integrations'
import type { DownloadReceipt, FrameCheck, ItemLifecycle, OldName } from '../domain/item'
import type { ItemId, ItemType } from '../domain/item-type'
import type { JournalEvent } from '../domain/journal'
import type { LegacyReview } from '../domain/legacy'
import type { MarkupField, Tag } from '../domain/markup'
import type { Model, UniqLevel } from '../domain/model'
import type { OrderDelivery, OrderMessage, OrderPart, OrderRevision } from '../domain/orders'
import type { Person } from '../domain/people'
import type { CancelReason, CopyState, Evidence, MarkKind, SurfaceKind } from '../domain/placement'
import type { WeekNorm } from '../domain/plan'
import type { CollectionMember, Contractor, HandoffState, PromoChannel } from '../domain/promo'
import type { ProvenanceLink } from '../domain/provenance'
import type { SystemState, Threshold } from '../domain/system'

/**
 * The in-memory database of the prototype. Records keep facts; everything shown
 * (levels, words, counters) is computed from them by the same functions the server uses.
 */

export interface ItemRecord {
  entry: CatalogEntry
  version: number
  lifecycle: ItemLifecycle
  description: string
  /** Detailed objects carry their own files and markup; the rest are synthesized on read. */
  files: ItemFile[] | null
  frames: MasterFrame[] | null
  markup: MarkupField[] | null
  fyp_versions: FypVersion[]
  provenance: ProvenanceLink[]
  ydisk_path: string
  old_names: OldName[]
  receipts: DownloadReceipt[]
  /** «Посмотреть кадры» (DESIGN §4.20): set by the frame sheet. */
  frame_check?: FrameCheck
  /** Custom: the operation of its own montage for a PPV, until the check accepts it. */
  ppv_montage?: string
}

export interface TrackStats {
  views: number
  on: LocalDate
}

/** Extra facts shown in the pair panel of «Сверить». */
export interface CaseExtras {
  post_summary: string
  caption: string | null
  platform_file_name: string | null
  issued_name: string | null
  issued_to: string | null
  sizes: string | null
  hint: string | null
  attachments: { no: number; label: string; ok: boolean }[]
  ours_duration_s: number | null
  theirs_duration_s: number | null
}

/** Facts about one «object × page × surface»: its plan row and its evidence. */
export interface PlacementTrack {
  id: string
  item_id: ItemId | null
  account: AccountCode
  surface: SurfaceKind
  plan_row_id: string | null
  evidence: Evidence[]
  album: string | null
  caption: string | null
  stats: TrackStats | null
  extras: CaseExtras | null
}

export interface MarkRecord {
  kind: MarkKind
  at: Instant
  by: string
  stated_occurred_at: Instant | null
  for_current_manifest: boolean
}

export interface PlanRowRecord {
  id: string
  date: LocalDate
  time: LocalTime | null
  account: AccountCode
  surface: SurfaceKind
  item_id: ItemId | null
  fyp_version: { no: number; level: UniqLevel } | null
  assignee: string | null
  mark: MarkRecord | null
  cancelled: { at: Instant; by: string; reason: CancelReason | null } | null
  release_id: string | null
  requires_new_upload: boolean
  has_newer_version: boolean
  second_person_blocked: boolean
  note: string | null
  album: string | null
  copy: CopyState | null
  downloaded: { at: Instant; by: string; meta_stripped: boolean } | null
  awaiting_montage: {
    from_item: ItemId
    expected_type: 'fyp' | 'ppv' | 'teaser'
    file_keys: string[]
  } | null
  created_by: string
  created_at: Instant
  version: number
}

export interface ReleaseRecord {
  id: string
  item_id: ItemId
  date: LocalDate
}

export interface CoverageRecord {
  /** Hub sees every post of the page (the capture floor is proven). */
  posts_complete: boolean
  /** Hub walked every vault album of the page; never true for OnlyFans until E4. */
  vault_complete: boolean
  visible_from: LocalDate | null
}

export interface OrderRecord {
  id: string
  title: string
  buyer: string | null
  account: AccountCode
  card: { url: string; author: string; posted_at: Instant; text: string | null }
  brief: string | null
  duration: { raw: string; min_s: number | null; max_s: number | null }
  wants_video: boolean
  wants_photos: number
  deadline: LocalDate | null
  fan_name: 'yes' | 'no' | 'unknown'
  parts: OrderPart[]
  deliveries: OrderDelivery[]
  revisions: OrderRevision[]
  messages: OrderMessage[]
  closed_at: Instant | null
  version: number
}

export interface CollectionRecord {
  id: ItemId
  channel: string
  contractor_id: string | null
  members: CollectionMember[]
}

export interface HandoffRecord {
  id: string
  collection_id: ItemId
  contractor_id: string
  state: HandoffState
  progress: number | null
  video_count: number
  photo_count: number
  size_bytes: number
  strip_metadata: boolean
  created_at: Instant
  sent_on: LocalDate | null
  failure: string | null
  operation_id: string | null
  recorded_by: string
  /** Materials the handoff carries (`RAW-0213/raw03`): what «уже передавали» is counted from. */
  members: string[]
}

export interface InboxRecord {
  group: InboxGroup
  /** Item the draft would become or extend, fixed at generation for stable demos. */
  target_item: ItemId | null
  /** A preparing group finishes by itself: progress runs from `prepare_started_at` to `ready_at`. */
  prepare_started_at: Instant | null
  ready_at: Instant | null
  /** What «готово» will say once preparing ends; «новое» when absent. */
  ready_note?: ReadyNote
}

export interface ModelWorld {
  model: Model
  items: Map<ItemId, ItemRecord>
  tracks: PlacementTrack[]
  plan_rows: Map<string, PlanRowRecord>
  releases: ReleaseRecord[]
  norms: Map<AccountCode, WeekNorm>
  coverage: Map<AccountCode, CoverageRecord>
  inbox: InboxRecord[]
  legacy: LegacyReview
  orders: OrderRecord[]
  collections: Map<ItemId, CollectionRecord>
  /** Promo materials of a channel not in any collection yet («Без подборки»), by channel. */
  promo_unfiled: Map<string, CollectionMember[]>
  handoffs: HandoffRecord[]
  channels: PromoChannel[]
  journal: JournalEvent[]
  recent: Map<string, RecentItem[]>
  counters: Map<ItemType, number>
  disk_checked_at: Instant | null
  /** Bumped on every catalog change; the ETag of `/index`. */
  catalog_version: number
  /** Bumped on every placement change; the ETag of `/index/pages`. */
  summary_version: number
}

/** Settings records without a place in the catalog: rights history, sessions, AI. */
export interface AdminRecords {
  /** Person id → history of rights, newest first. */
  grants: Map<string, AccessGrant[]>
  /** Person id → sessions; the first one is this browser. */
  sessions: Map<string, Session[]>
  ai: AiSettings
}

export interface World {
  models: Map<ModelCode, ModelWorld>
  people: Person[]
  agents: Agent[]
  contractors: Contractor[]
  integrations: Integration[]
  thresholds: Threshold[]
  tags: Tag[]
  system: SystemState
  admin: AdminRecords
}
