/**
 * Every value list of the database, one list in code (schema §1 p. 12, §4).
 * Columns hold `text` + CHECK; `values.test.ts` compares each CHECK with these arrays.
 * Lists that §4 calls preliminary (work state, failure kind, idempotency state) close
 * before the `schema-freeze` tag.
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

/** The kill switch whose area a kind works in (SPEC §8); checked before every attempt. */
export const workKindSwitch: Readonly<Partial<Record<WorkKind, KillSwitchKey>>> = {
  scan: 'ydisk.scan',
  fetch: 'ydisk.scan',
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

/** Codes of `RAISE` in the migration functions. */
export const dbErrorCodes = {
  journalContextMissing: 'CO001',
  immutableRow: 'CO002',
  immutableColumn: 'CO003',
} as const
