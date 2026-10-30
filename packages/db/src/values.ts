/**
 * Every value list of the database, one list in code (schema §1 p. 12, §4).
 * Columns hold `text` + CHECK; `values.test.ts` compares each CHECK with these arrays.
 * Lists that §4 calls preliminary (work state, failure kind, idempotency state, draft state
 * and outcome, blob state, review case kind, master check verdict, order status) close before
 * the `schema-freeze` tag. Lists inside SQL functions (`role_fits_type`, `public_item_id`,
 * `blob_is_referenced`) are compared by behaviour in `catalog.test.ts`, the order rules
 * (`custom_order_status`, `custom_order_live_files`) in `orders.test.ts`, the plan and
 * placement rules (the evidence triple, slots, second person on OnlyFans) in `plan.test.ts`.
 */

/** Public ID types (SPEC §4.1). */
export const contentTypes = ['PPV', 'SET', 'SXT', 'CUS', 'FYP', 'LIFE', 'RAW', 'PRM'] as const
export type ContentType = (typeof contentTypes)[number]

/** Model codes go into URLs next to `/api/v1/admin` and `/api/v1/auth` (SPEC §11.2). */
export const reservedModelCodes = ['admin', 'auth'] as const

export const platforms = ['fansly', 'onlyfans'] as const
export type Platform = (typeof platforms)[number]

export const surfaceKinds = ['wall', 'fyp', 'story', 'vault', 'mass_dm'] as const
export type SurfaceKind = (typeof surfaceKinds)[number]

/** Stories and mass DMs stay outside automatic matching (decision 06.09, schema §3.1). */
export const autoMatchSurfaceKinds = ['wall', 'fyp', 'vault'] as const

export const uniqLevels = ['soft', 'trim', 'mirror'] as const
export type UniqLevel = (typeof uniqLevels)[number]

export const principalKinds = ['human', 'agent'] as const
export type PrincipalKind = (typeof principalKinds)[number]

export const principalRoles = ['owner', 'manager', 'reader'] as const
export type PrincipalRole = (typeof principalRoles)[number]

/** Verb form in the feed: «отметила» / «отметил». */
export const genders = ['f', 'm'] as const
export type Gender = (typeof genders)[number]

/** Interface skin (DESIGN §7.10). */
export const uiSkins = ['blue', 'focus'] as const
export type UiSkin = (typeof uiSkins)[number]

export const actorTypes = ['human', 'agent', 'system'] as const
export type ActorType = (typeof actorTypes)[number]

/** `action` — a feed and «История» line written by code; `change` — a trigger row. */
export const logEntryKinds = ['action', 'change'] as const
export type LogEntryKind = (typeof logEntryKinds)[number]

export const logResults = ['ok', 'denied', 'error'] as const
export type LogResult = (typeof logResults)[number]

/** Replay state of an idempotency key; `no_replay` — the response held a secret. */
export const idempotencyStates = ['committed', 'no_replay'] as const
export type IdempotencyState = (typeof idempotencyStates)[number]

// ---------------------------------------------------------------------------
// Background work (SPEC §12.0 «Фоновые работы», schema §3.4)
// ---------------------------------------------------------------------------

export const workRoles = ['worker', 'worker-video', 'worker-image'] as const
export type WorkRole = (typeof workRoles)[number]

/** Each kind belongs to exactly one role. */
export const workKindsByRole = {
  worker: [
    'scan',
    'fetch',
    'hash',
    'unpack_archive',
    'import_parse',
    'register',
    'propose',
    'export',
    'hub_sync',
    'hub_history',
    'hub_publish',
    'annotate',
    'verify_blobs',
    'backup',
  ],
  'worker-video': [
    'derive_video',
    'encode_master',
    'verify_master',
    'render',
    'uniq_render',
    'render_compat',
    'extract_frame',
  ],
  'worker-image': ['derive_image'],
} as const satisfies Record<WorkRole, readonly string[]>

export type WorkKind = (typeof workKindsByRole)[WorkRole][number]

export const workKinds: readonly WorkKind[] = workRoles.flatMap((role) => workKindsByRole[role])

export const workKindRole: Readonly<Record<WorkKind, WorkRole>> = Object.fromEntries(
  workRoles.flatMap((role) => workKindsByRole[role].map((kind) => [kind, role])),
) as Record<WorkKind, WorkRole>

/** Kinds without a model (`model_id IS NULL`): system-wide runs. */
export const globalWorkKinds = ['verify_blobs', 'backup'] as const satisfies readonly WorkKind[]

/**
 * Concurrency slot of each kind inside its role. Limits come from the environment:
 * `fetch` — `FETCH_JOBS`, `encode` — `ENCODE_JOBS`, `copy` — `COPY_JOBS` (what the
 * manager waits for, next to the encoders), `image` — `IMAGE_JOBS`; `general` — the
 * light kinds of `worker`.
 */
export const workSlots = ['general', 'fetch', 'encode', 'copy', 'image'] as const
export type WorkSlot = (typeof workSlots)[number]

export const workKindSlot: Readonly<Record<WorkKind, WorkSlot>> = {
  scan: 'general',
  fetch: 'fetch',
  hash: 'general',
  unpack_archive: 'general',
  import_parse: 'general',
  register: 'general',
  propose: 'general',
  export: 'general',
  hub_sync: 'general',
  hub_history: 'general',
  hub_publish: 'general',
  annotate: 'general',
  verify_blobs: 'general',
  backup: 'general',
  derive_video: 'encode',
  encode_master: 'encode',
  verify_master: 'encode',
  uniq_render: 'encode',
  render: 'copy',
  render_compat: 'copy',
  extract_frame: 'copy',
  derive_image: 'image',
}

/**
 * Queues of «Настройки › Состояние» (DESIGN §4.19): забор с диска, превью, сжатие, кадры,
 * копии. Hub, backup and the storage check sit in no queue: they have their own blocks.
 */
export const workQueues = ['fetch', 'preview', 'compress', 'frames', 'copies'] as const
export type WorkQueue = (typeof workQueues)[number]

export const workKindQueue: Readonly<Record<WorkKind, WorkQueue | null>> = {
  scan: 'fetch',
  fetch: 'fetch',
  hash: 'fetch',
  unpack_archive: 'fetch',
  import_parse: 'fetch',
  register: 'fetch',
  propose: 'fetch',
  export: 'copies',
  hub_sync: null,
  hub_history: null,
  hub_publish: null,
  annotate: 'frames',
  verify_blobs: null,
  backup: null,
  derive_video: 'preview',
  encode_master: 'compress',
  verify_master: 'compress',
  render: 'copies',
  uniq_render: 'copies',
  render_compat: 'copies',
  extract_frame: 'frames',
  derive_image: 'preview',
}

export const workStates = [
  'pending',
  'running',
  'retry_wait',
  'succeeded',
  'failed',
  'cancelled',
] as const
export type WorkState = (typeof workStates)[number]

/** States that keep a stream busy: at most one such row per stream. */
export const unfinishedWorkStates = ['pending', 'running', 'retry_wait'] as const
/** Rows the executor claims when due (a running row only when its lease expired). */
export const claimableWorkStates = ['pending', 'retry_wait'] as const
export const finishedWorkStates = ['succeeded', 'failed', 'cancelled'] as const

/** `transient` — retried with backoff; `permanent` — failed at once. */
export const failureKinds = ['transient', 'permanent'] as const
export type FailureKind = (typeof failureKinds)[number]

// ---------------------------------------------------------------------------
// Settings (schema §3.1 `policy_settings`, SPEC §8 «Выключатели», §13)
// ---------------------------------------------------------------------------

/** Kill switches with a fixed key. A switch is on only where some level says `true`. */
export const killSwitchKeys = [
  'hub.receive',
  'hub.auto_match',
  'hub.publish',
  'ydisk.scan',
  'dropbox.scan',
  'agents.enabled',
  'fyper.enabled',
] as const
export type KillSwitchKey = (typeof killSwitchKeys)[number]

/** Kill switches with a variable tail: one agent token, one annotation route (SPEC §8.3). */
export const killSwitchPrefixes = ['agents.token.', 'annotation.'] as const

/** Thresholds and settings of §13: no value means the function is off; no seeds. */
export const thresholdKeys = [
  'too_early_days',
  'phash_suggest_threshold',
  'intake_auto_accept',
  'hub_candidate_tolerance',
  'hub_exact_duration_ms',
  'hub_wait_window',
  'hub_not_out_window',
  'hub_vault_recheck',
  'hub_ad_markers',
  'vault_bins',
  'import_batch_scope',
] as const
export type ThresholdKey = (typeof thresholdKeys)[number]

/**
 * The kill switch whose area a kind works in (SPEC §8); checked before every attempt. The
 * source scan and fetch (`scan`, `fetch`) are switched per source: `sourceScanSwitch`.
 */
export const workKindSwitch: Readonly<Partial<Record<WorkKind, KillSwitchKey>>> = {
  hub_sync: 'hub.receive',
  hub_history: 'hub.receive',
  hub_publish: 'hub.publish',
}

/**
 * Queue switch `queue.<queue>` (SPEC §8: media processing can be paused). Unlike a kill
 * switch it is on by default — the core runs without settings; only an explicit global
 * `false` («Пауза» of the owner) holds the queue.
 */
export function queueSwitchKey(queue: WorkQueue): `queue.${WorkQueue}` {
  return `queue.${queue}`
}

export function isKillSwitchKey(key: string): boolean {
  return (
    (killSwitchKeys as readonly string[]).includes(key) ||
    killSwitchPrefixes.some((prefix) => key.startsWith(prefix) && key.length > prefix.length)
  )
}

export function isPolicyKey(key: string): boolean {
  return (
    isKillSwitchKey(key) ||
    (thresholdKeys as readonly string[]).includes(key) ||
    workQueues.some((queue) => key === queueSwitchKey(queue))
  )
}

// ---------------------------------------------------------------------------
// Bytes and derivatives (schema §3.3, §9.1, §9.2)
// ---------------------------------------------------------------------------

/** Closed (schema §4). */
export const mediaKinds = ['video', 'image'] as const
export type MediaKind = (typeof mediaKinds)[number]

/** Preliminary (schema §4): `purging` lives in `storage_operations`, not here. */
export const blobStates = ['present', 'purged', 'missing', 'corrupt'] as const
export type BlobState = (typeof blobStates)[number]

/** ffprobe and EXIF, one row per bytes and tool recipe. */
export const probeKinds = ['ffprobe', 'exif'] as const
export type ProbeKind = (typeof probeKinds)[number]

/** How a master was made (schema §9.2); `copy` — a manager's web upload; empty only for `unreadable`. */
export const masterDecisions = [
  'encode',
  'copy',
  'skipped_hdr',
  'skipped_av1',
  'skipped_lowrate',
  'skipped_audio',
] as const
export type MasterDecision = (typeof masterDecisions)[number]

/** Verdict of the master check (preliminary, schema §4): outcomes of `compress-library.sh`. */
export const masterCheckVerdicts = [
  'ok',
  'unreadable',
  'bigger_than_source',
  'timing_drift',
  'timing_uncomparable',
  'audio_mismatch',
  'audio_offset',
  'audio_tracks_lost',
  'encode_failed',
  'frame_mismatch',
  'result_decode_errors',
  'publish_failed',
  'source_decode_errors',
  'source_truncated',
  'metadata_mismatch',
] as const
export type MasterCheckVerdict = (typeof masterCheckVerdicts)[number]

export const storageOperationKinds = ['put', 'purge'] as const
export type StorageOperationKind = (typeof storageOperationKinds)[number]

/** Steps of a file operation, each its own commit; only an `intent` can be cancelled. */
export const storageOperationStates = [
  'intent',
  'started',
  'fs_done',
  'committed',
  'failed',
  'cancelled',
] as const
export type StorageOperationState = (typeof storageOperationStates)[number]
/** One live operation per blob. */
export const activeStorageOperationStates = ['intent', 'started', 'fs_done'] as const
export const finishedStorageOperationStates = ['committed', 'failed', 'cancelled'] as const

/** Closed (schema §4): the derivative manifest of SPEC §9.3. */
export const renditionKinds = [
  'preview',
  'poster',
  'thumb320',
  'thumb640',
  'preview2048',
  'frames',
  'platform',
] as const
export type RenditionKind = (typeof renditionKinds)[number]

export const renditionInputKinds = ['source', 'master'] as const
export type RenditionInputKind = (typeof renditionInputKinds)[number]

export const renditionStates = ['building', 'ready', 'failed', 'evicted'] as const
export type RenditionState = (typeof renditionStates)[number]

export const artifactStates = ['ready', 'evicted', 'missing'] as const
export type ArtifactState = (typeof artifactStates)[number]

// ---------------------------------------------------------------------------
// Sources (schema §3.4, §9.7; SPEC §6.1)
// ---------------------------------------------------------------------------

export const sourceKinds = ['yandex_disk', 'dropbox', 'web_upload', 'legacy_metadata'] as const
export type SourceKind = (typeof sourceKinds)[number]

/** Cloud folders of a model: one source interface, always read-only (SPEC §2.1 p. 6). */
export const cloudSourceKinds = ['yandex_disk', 'dropbox'] as const
export type CloudSourceKind = (typeof cloudSourceKinds)[number]

/**
 * «Скан источника и новый забор» is switched per source of a model (SPEC §8): the `scan`
 * and `fetch` works of a source wait while its switch is off.
 */
export const sourceScanSwitch = {
  yandex_disk: 'ydisk.scan',
  dropbox: 'dropbox.scan',
} as const satisfies Record<CloudSourceKind, KillSwitchKey>

/** How the bytes of a revision were read and checked. */
export const verifiedRoutes = ['download', 'local_copy', 'upload'] as const
export type VerifiedRoute = (typeof verifiedRoutes)[number]

// ---------------------------------------------------------------------------
// Catalog (schema §3.2, §9.2; naming §3)
// ---------------------------------------------------------------------------

/** Closed (schema §4, naming §3). `cap` is a download sidecar and fits no type. */
export const assetRoles = ['master', 'teaser', 'pic', 'raw', 'ed', 'clip', 'thumb', 'cap'] as const
export type AssetRole = (typeof assetRoles)[number]

/** Roles with a number: `pic07`, `raw12`, `ed03`, `clip02`. */
export const ordinalRoles = ['pic', 'raw', 'ed', 'clip'] as const

/** Roles a file may own in an object of the type (naming §3); SQL `role_fits_type()`. */
export const rolesByType = {
  PPV: ['master', 'teaser', 'pic', 'thumb'],
  SET: ['raw', 'ed'],
  SXT: ['pic', 'clip'],
  CUS: ['master', 'pic'],
  FYP: ['master'],
  LIFE: ['pic', 'clip'],
  RAW: ['raw'],
  PRM: ['pic', 'clip'],
} as const satisfies Record<ContentType, readonly AssetRole[]>

/** Minimal padding of the public number (SPEC §4.1); SQL `public_item_id()`. */
export const idPadding = {
  PPV: 3,
  SET: 3,
  SXT: 3,
  CUS: 3,
  FYP: 4,
  LIFE: 3,
  RAW: 4,
  PRM: 3,
} as const satisfies Record<ContentType, number>

/** `reference` — a file of another object inside a `PRM` collection. */
export const membershipKinds = ['owned', 'reference'] as const
export type MembershipKind = (typeof membershipKinds)[number]

/** `uniq` — a unique version `uN` of a FYP, `variant_no > 0`. */
export const variantKinds = ['none', 'uniq'] as const
export type VariantKind = (typeof variantKinds)[number]

/** Purpose of a LIFE frame: the feed, chats or both. */
export const lifeUses = ['feed', 'chats', 'both'] as const
export type LifeUse = (typeof lifeUses)[number]

/** Bundle on the wall or PPV in DMs. */
export const ppvKinds = ['bundle', 'dm'] as const
export type PpvKind = (typeof ppvKinds)[number]

/** Purpose of a RAW batch. */
export const rawPurposes = ['fyp', 'ppv', 'mass_dm', 'unknown'] as const
export type RawPurpose = (typeof rawPurposes)[number]

/** «Имя фана в ролике»: есть / нет / не знаю. */
export const nameInMediaValues = ['yes', 'no', 'unknown'] as const
export type NameInMedia = (typeof nameInMediaValues)[number]

export const itemOrigins = ['intake', 'import', 'manual'] as const
export type ItemOrigin = (typeof itemOrigins)[number]

export const manifestPurposes = ['plan', 'download', 'delivery', 'submission'] as const
export type ManifestPurpose = (typeof manifestPurposes)[number]

export const aliasKinds = [
  'legacy_path',
  'legacy_name',
  'legacy_id',
  'sub_handle',
  'merged_id',
  'vault_album',
  'tg_card',
  'resource_id',
  'registry_row',
] as const
export type AliasKind = (typeof aliasKinds)[number]

/** Closed (schema §4). */
export const provenanceRelations = [
  'montage_from',
  'uniq_from',
  'teaser_from',
  'frame_from',
  'processed_from',
  'ppv_from_custom',
  'extracted_from',
  'remaster_from',
  'split_from',
  'merged_from',
  'reencoded_from',
] as const
export type ProvenanceRelation = (typeof provenanceRelations)[number]

/** Closed (schema §4): actions, attributes, mood. */
export const tagGroups = ['action', 'attribute', 'mood'] as const
export type TagGroup = (typeof tagGroups)[number]

/** Who wrote a tag, a chronology line or a platform text. */
export const annotationSources = ['ai', 'human', 'import'] as const
export type AnnotationSource = (typeof annotationSources)[number]

/** Closed (schema §4): fields with a status of their own. */
export const annotationFieldKeys = [
  'title',
  'title_en',
  'description',
  'tags',
  'chronology',
  'purpose',
  'second_person',
] as const
export type AnnotationFieldKey = (typeof annotationFieldKeys)[number]

/** Summary state of the markup in `catalog_index`. */
export const markupStates = ['draft', 'partial', 'confirmed'] as const
export type MarkupState = (typeof markupStates)[number]

/** `generic` — a text for any page; a page variant names its platform and account. */
export const textPlatforms = ['generic', 'fansly', 'onlyfans'] as const
export type TextPlatform = (typeof textPlatforms)[number]

// ---------------------------------------------------------------------------
// Intake (schema §3.4, §9.2, §9.7; SPEC §5, §6.1)
// ---------------------------------------------------------------------------

/** One grouping rule (SPEC §6.1); `manual` — a file made «a separate object». */
export const groupings = ['folder', 'exif_day', 'upload_cluster', 'single', 'manual'] as const
export type Grouping = (typeof groupings)[number]

export const draftOrigins = [
  'disk_scan',
  'web_upload',
  'legacy_import',
  'archive',
  'derived',
] as const
export type DraftOrigin = (typeof draftOrigins)[number]

/** Preliminary (SPEC §5, §13). */
export const draftStates = ['discovered', 'processing', 'ready', 'resolved'] as const
export type DraftState = (typeof draftStates)[number]

/** Preliminary (SPEC §5, §13). Only `new_item` issues a number. */
export const draftOutcomes = ['new_item', 'append', 'alias', 'rejected'] as const
export type DraftOutcome = (typeof draftOutcomes)[number]

/** Outcomes that accept bytes into the catalog: they need a verified master. */
export const acceptedDraftOutcomes = ['new_item', 'append'] as const

export const draftBlockedReasons = [
  'ambiguous_order',
  'video_in_set',
  'id_collision',
  'cross_model_dup',
  'master_failed',
  'needs_type',
  'source_unavailable',
  'deferred',
  /** A processed frame whose download name is not known: ◆ «К какому кадру?» (SPEC §6.1). */
  'which_frame',
] as const
export type DraftBlockedReason = (typeof draftBlockedReasons)[number]

export const candidateKinds = [
  'order',
  'existing_item',
  'exact_duplicate',
  'similar_photo',
  'legacy_id',
  'source_parent',
  'content_type',
] as const
export type CandidateKind = (typeof candidateKinds)[number]

export const uploadDeclaredKinds = [
  'fyp_edit',
  'teaser',
  'processed_frames',
  'master_version',
  'other',
] as const
export type UploadDeclaredKind = (typeof uploadDeclaredKinds)[number]

export const uploadStates = [
  'receiving',
  'received',
  'verified',
  'registered',
  'failed',
  'abandoned',
] as const
export type UploadState = (typeof uploadStates)[number]
/** An upload in progress holds its blob until it becomes a draft. */
export const unfinishedUploadStates = ['receiving', 'received', 'verified'] as const

/** Preliminary (schema §4). */
export const reviewCaseKinds = [
  'cross_model_duplicate',
  'legacy_unparsed',
  'merge_split',
  'unreadable_input',
] as const
export type ReviewCaseKind = (typeof reviewCaseKinds)[number]

export const reviewCaseStates = ['open', 'resolved', 'dismissed'] as const
export type ReviewCaseState = (typeof reviewCaseStates)[number]

// ---------------------------------------------------------------------------
// Issue (schema §3.5)
// ---------------------------------------------------------------------------

export const receiptKinds = ['master', 'platform', 'edit', 'promo'] as const
export type ReceiptKind = (typeof receiptKinds)[number]

// ---------------------------------------------------------------------------
// Custom orders (schema §3.7, §9.2; SPEC §5, §8.2)
// ---------------------------------------------------------------------------

/**
 * Preliminary (schema §4). `open ⇔ delivered` follows the part marks (trigger
 * `custom_orders_status`); `closed` needs every part and no open revision; `cancelled` needs a
 * reason. `closed` and `cancelled` are final.
 */
export const orderStatuses = ['open', 'delivered', 'closed', 'cancelled'] as const
export type OrderStatus = (typeof orderStatuses)[number]
export const finalOrderStatuses = ['closed', 'cancelled'] as const

/** Parts of an order: several clips are one part `video`; photos count distinct files. */
export const orderParts = ['video', 'photos'] as const
export type OrderPart = (typeof orderParts)[number]

export const orderMessageKinds = [
  'card',
  'repost',
  'delivery',
  'revision',
  'confirmation',
  'note',
] as const
export type OrderMessageKind = (typeof orderMessageKinds)[number]

// ---------------------------------------------------------------------------
// Legacy claims and placements (schema §3.4, §3.6, §9.2, §9.6, §9.7; SPEC §6.3, §7)
// ---------------------------------------------------------------------------

/** What a legacy name claims (SPEC §6.3). */
export const legacyClaimKinds = [
  'number',
  'used',
  'posted',
  'date',
  'role',
  'registry_row',
  'duration',
  'unknown',
] as const
export type LegacyClaimKind = (typeof legacyClaimKinds)[number]

export const legacyClaimResolutions = ['pending', 'resolved', 'ignored'] as const
export type LegacyClaimResolution = (typeof legacyClaimResolutions)[number]

/** Decision on a claimed legacy number (SPEC §6.4). */
export const legacyNumberDecisions = ['keep', 'renumber', 'typo', 'unclear'] as const
export type LegacyNumberDecision = (typeof legacyNumberDecisions)[number]

/** The unit of a placement: a post, a file in a named vault album, a manual mark. */
export const occurrenceKinds = ['post', 'vault_member', 'manual'] as const
export type OccurrenceKind = (typeof occurrenceKinds)[number]

/** How well the time of a placement is known; a legacy claim may have no date. */
export const eventPrecisions = ['exact', 'day', 'unknown'] as const
export type EventPrecision = (typeof eventPrecisions)[number]

export const occurredSources = ['hub', 'km', 'import'] as const
export type OccurredSource = (typeof occurredSources)[number]

/** Where the surface of a placement comes from (schema §9.6); `import` — the legacy rule. */
export const surfaceSources = ['hub', 'km_mark', 'km', 'plan', 'import'] as const
export type SurfaceSource = (typeof surfaceSources)[number]

export const placementOrigins = ['plan', 'hub', 'manual', 'import'] as const
export type PlacementOrigin = (typeof placementOrigins)[number]

/** Per file of a placement: one of twelve matching is a partial result. */
export const matchStrengths = ['none', 'candidate', 'exact'] as const
export type MatchStrength = (typeof matchStrengths)[number]

/** Preliminary (schema §4): where evidence came from — a source, not a stage. */
export const evidenceSources = ['hub', 'manual', 'import'] as const
export type EvidenceSource = (typeof evidenceSources)[number]

/** Preliminary (schema §4). */
export const evidenceKinds = [
  'observed',
  'manual_confirm',
  'reused_pair',
  'manual_reject',
  'legacy_claim',
  'outside_catalog',
  'retract',
] as const
export type EvidenceKind = (typeof evidenceKinds)[number]

/** Preliminary (schema §4). Denying kinds (`manual_reject`, `retract`, `outside_catalog`) have none. */
export const evidenceStrengths = ['claim', 'candidate', 'exact'] as const
export type EvidenceStrength = (typeof evidenceStrengths)[number]

// ---------------------------------------------------------------------------
// Plan (schema §3.5, §9.2; SPEC §4, §5, §7)
// ---------------------------------------------------------------------------

/** Surfaces a PPV release has rows on: wall, story teaser, vault, mass message. */
export const releaseSurfaceKinds = ['wall', 'story', 'vault', 'mass_dm'] as const
export type ReleaseSurfaceKind = (typeof releaseSurfaceKinds)[number]

/** What a row waiting for a montage expects (a teaser — `expected_role = 'teaser'`). */
export const montageTypes = ['FYP', 'PPV'] as const
export type MontageType = (typeof montageTypes)[number]

/** «выложено» / «в планировщике» (SPEC §5). */
export const markKinds = ['posted', 'scheduled'] as const
export type MarkKind = (typeof markKinds)[number]

/** Optional reason of a cancelled row; `second_person` — set by the late flag (0006). */
export const cancelReasons = ['late', 'replaced', 'paused', 'second_person'] as const
export type CancelReason = (typeof cancelReasons)[number]

// ---------------------------------------------------------------------------
// Promo (schema §3.8; SPEC §7.1)
// ---------------------------------------------------------------------------

/** One format field of a contractor: «для заливки», «мастер», «совместимая для монтажа». */
export const contractorFormats = ['upload', 'master', 'compat'] as const
export type ContractorFormat = (typeof contractorFormats)[number]

/** `preparing → prepared → sent`; «не собралось» is the failed export work of a preparing one. */
export const promoDeliveryStates = ['preparing', 'prepared', 'sent'] as const
export type PromoDeliveryState = (typeof promoDeliveryStates)[number]

/** A past pack recorded by import is `import`: sent without date and author (SPEC §6.3). */
export const promoDeliveryOrigins = ['product', 'import'] as const
export type PromoDeliveryOrigin = (typeof promoDeliveryOrigins)[number]

/** Codes of `RAISE` in the migration functions. */
export const dbErrorCodes = {
  journalContextMissing: 'CO001',
  immutableRow: 'CO002',
  /** A fixed column changed, or a set-once column was overwritten. */
  immutableColumn: 'CO003',
  /** A sealed manifest or receipt does not hold exactly `entry_count` rows at commit. */
  sealedCountMismatch: 'CO004',
  /**
   * A transition the schema forbids: reopening an accepted draft, cancelling a started
   * operation; an order part mark without its deliveries, closing an order before every part
   * or with an open revision, any change of a final order, a retraction of a retraction; a
   * promo handoff going back to `preparing` or sent without being prepared.
   */
  transitionRefused: 'CO005',
  /** A private tag of another model. */
  foreignTag: 'CO006',
  /**
   * An object with a second person in frame (DETAIL `second_person`) or not checked for one
   * (DETAIL `unchecked`) put on OnlyFans: a new row, a move, a new composition, a montage.
   */
  secondPersonOnOnlyFans: 'CO007',
} as const
