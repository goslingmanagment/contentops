import { z } from 'zod'
import {
  AccountCodeSchema,
  InstantSchema,
  LocalDateSchema,
  LocalTimeSchema,
  SignSchema,
} from './common'
import { ItemIdSchema } from './item-type'
import { PlatformSchema } from './model'

/** Where on a page something goes: wall, FYP, vault, stories, mass message. */
export const SurfaceKindSchema = z.enum(['wall', 'fyp', 'vault', 'story', 'dm'])
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>

export const SURFACE_LABEL: Record<SurfaceKind, string> = {
  wall: 'стена',
  fyp: 'фуп',
  vault: 'vault',
  story: 'сториз',
  dm: 'рассылка',
}

/**
 * Placement level: one value per row of DESIGN §5.2.
 * The word on screen and the sign are derived from it by `evaluatePlacement`.
 */
export const PlacementLevelSchema = z.enum([
  'planned',
  'missed',
  'marked_manual',
  'marked',
  'scheduled',
  'confirmed_exact',
  'confirmed_hub_unmarked',
  'confirmed_manual',
  'confirmed_earlier',
  'confirmed_reupload',
  'candidate',
  'candidates_multiple',
  'partial_match',
  'mismatch',
  'conflict',
  'surface_unknown',
  'unplanned_post',
  'vault_missing',
  'vault_stale',
  'cannot_verify',
  'unknown',
  'not_found_in_walk',
  'not_published',
  'blocked_second_person',
  'cancelled',
  'outside_catalog',
])
export type PlacementLevel = z.infer<typeof PlacementLevelSchema>

/** Hub's view of a page: whether it sees all posts, and since when. */
export const HubCoverageSchema = z.object({
  state: z.enum(['complete', 'partial', 'off', 'unset', 'down']),
  since: InstantSchema.nullable(),
  /** First day Hub captured posts of the page: «Hub видит Fansly 1 с 19.01.2025». */
  visible_from: LocalDateSchema.nullable(),
})
export type HubCoverage = z.infer<typeof HubCoverageSchema>

/** `second_person` — set by the system when the flag came after the row (SPEC §7). */
export const CancelReasonSchema = z.enum(['late', 'replaced', 'paused', 'second_person'])
export type CancelReason = z.infer<typeof CancelReasonSchema>

/** Reasons a person picks after «Отменить строку» (DESIGN §3.8). */
export const PICKED_CANCEL_REASONS = [
  'late',
  'replaced',
  'paused',
] as const satisfies readonly CancelReason[]

export const CANCEL_REASON_LABEL: Record<CancelReason, string> = {
  late: 'не успели',
  replaced: 'заменили',
  paused: 'пауза',
  second_person: 'второй человек в кадре',
}

export const MarkKindSchema = z.enum(['posted', 'scheduled'])
export type MarkKind = z.infer<typeof MarkKindSchema>

const PersonNameSchema = z.object({ name: z.string(), gender: z.enum(['f', 'm']).nullable() })
export type PersonName = z.infer<typeof PersonNameSchema>

const evidenceBase = {
  id: z.string(),
  recorded_at: InstantSchema,
}

/** How Hub proved an exact match. */
export const ExactMatchSchema = z.enum(['file_name', 'album', 'file'])
export type ExactMatch = z.infer<typeof ExactMatchSchema>

/**
 * Evidence (улика) about a placement: what Hub saw, what a person confirmed or rejected,
 * what an old file name claims. Insert-only, like `placement_evidence` in the schema.
 */
export const EvidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    ...evidenceBase,
    kind: z.literal('hub_exact'),
    post_at: InstantSchema,
    match: ExactMatchSchema,
    file_name: z.string().nullable(),
    duration: z.object({ ours_s: z.number(), theirs_s: z.number() }).nullable(),
  }),
  z.object({
    ...evidenceBase,
    kind: z.literal('hub_candidate'),
    post_at: InstantSchema,
    offset_min: z.number(),
    /** «1 видео 0:09 = 0:09». */
    summary: z.string(),
  }),
  z.object({
    ...evidenceBase,
    kind: z.literal('hub_partial'),
    matched: z.int().nonnegative(),
    total: z.int().positive(),
    /** «нет фото 17». */
    missing: z.string(),
  }),
  z.object({
    ...evidenceBase,
    kind: z.literal('hub_mismatch'),
    post_at: InstantSchema,
    field: z.enum(['duration', 'attachments']),
    ours: z.string(),
    theirs: z.string(),
  }),
  z.object({
    ...evidenceBase,
    kind: z.literal('hub_conflict'),
    post_at: InstantSchema,
    other: z.string(),
  }),
  z.object({ ...evidenceBase, kind: z.literal('hub_surface_unknown'), post_at: InstantSchema }),
  z.object({
    ...evidenceBase,
    kind: z.literal('hub_unplanned'),
    post_at: InstantSchema,
    surface_seen: SurfaceKindSchema,
    summary: z.string(),
  }),
  z.object({
    ...evidenceBase,
    kind: z.literal('vault_missing'),
    album: z.string(),
    walked_on: LocalDateSchema,
  }),
  z.object({
    ...evidenceBase,
    kind: z.literal('vault_stale'),
    album: z.string(),
    file_on: LocalDateSchema,
    row_on: LocalDateSchema,
  }),
  z.object({ ...evidenceBase, kind: z.literal('vault_reupload'), file_on: LocalDateSchema }),
  z.object({
    ...evidenceBase,
    kind: z.literal('manual_confirm'),
    by: PersonNameSchema,
    basis: z.enum(['pair', 'report']),
  }),
  z.object({ ...evidenceBase, kind: z.literal('manual_earlier'), confirmed_on: LocalDateSchema }),
  z.object({
    ...evidenceBase,
    kind: z.literal('manual_reject'),
    by: PersonNameSchema,
    /** The candidate this «Не то» refers to; `null` rejects all open candidates. */
    rejects: z.string().nullable(),
  }),
  z.object({
    ...evidenceBase,
    kind: z.literal('legacy_claim'),
    label: z.string(),
    on: LocalDateSchema,
  }),
  z.object({ ...evidenceBase, kind: z.literal('outside_catalog'), by: PersonNameSchema }),
  z.object({ ...evidenceBase, kind: z.literal('walk_not_found'), walked_from: LocalDateSchema }),
])
export type Evidence = z.infer<typeof EvidenceSchema>
export type EvidenceKind = Evidence['kind']

export const CopyStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready'), size_bytes: z.int().nonnegative() }),
  z.object({ state: z.literal('building'), progress: z.number().min(0).max(1) }),
  z.object({ state: z.literal('failed') }),
])
export type CopyState = z.infer<typeof CopyStateSchema>

/** What the plan knows about a row: the first of the three facts. */
export const PlanFactsSchema = z.object({
  slot_date: LocalDateSchema,
  slot_time: LocalTimeSchema.nullable(),
  created_by: PersonNameSchema,
  created_at: InstantSchema,
  mark: z
    .object({
      kind: MarkKindSchema,
      at: InstantSchema,
      by: PersonNameSchema,
      /** Time stated by the КМ for stories and mass messages. */
      stated_occurred_at: InstantSchema.nullable(),
      for_current_manifest: z.boolean(),
    })
    .nullable(),
  cancelled: z
    .object({ at: InstantSchema, by: PersonNameSchema, reason: CancelReasonSchema.nullable() })
    .nullable(),
  copy: CopyStateSchema.nullable(),
  second_person_blocked: z.boolean(),
  has_newer_version: z.boolean(),
  requires_new_upload: z.boolean(),
  /** Row waiting for a montage from raw footage. */
  awaiting_montage_from: ItemIdSchema.nullable(),
})
export type PlanFacts = z.infer<typeof PlanFactsSchema>

/** Everything the placement function needs; the server computes it, the agent gets it too. */
export const PlacementFactsSchema = z.object({
  now: InstantSchema,
  account: z.object({
    code: AccountCodeSchema,
    label: z.string(),
    platform: PlatformSchema,
  }),
  surface: SurfaceKindSchema,
  hub: HubCoverageSchema,
  plan: PlanFactsSchema.nullable(),
  evidence: z.array(EvidenceSchema),
  thresholds: z.object({
    /** «ждём Hub», 8 ч. */
    wait_hub_hours: z.number().positive(),
    /** «не вышло», 24 ч; `null` until entry E7 switches it on. */
    not_published_hours: z.number().positive().nullable(),
  }),
})
export type PlacementFacts = z.infer<typeof PlacementFactsSchema>

/** The three facts as sentences: plan, mark, Hub. */
export const ThreeFactsSchema = z.object({
  plan: z.string().nullable(),
  mark: z.string().nullable(),
  hub: z.string().nullable(),
})
export type ThreeFacts = z.infer<typeof ThreeFactsSchema>

export const PlacementVerdictSchema = z.object({
  level: PlacementLevelSchema,
  sign: SignSchema.nullable(),
  /** «подтверждено», «сверить», «в плане». */
  word: z.string(),
  /** «Hub, по имени файла», «2 варианта»; `null` when the word says it all. */
  detail: z.string().nullable(),
  /** «Почему», one sentence. */
  reason: z.string(),
  /** Grey captions: «в старом имени: used2 · 31.07», «Состав заменили после отметки». */
  notes: z.array(z.string()),
  /** Date shown next to the word in «где залито»: post, mark or slot date. */
  date: LocalDateSchema.nullable(),
  facts: ThreeFactsSchema,
})
export type PlacementVerdict = z.infer<typeof PlacementVerdictSchema>

/** One pair «объект × страница» of the page summary index (DESIGN §10.2). */
export const PageSummaryEntrySchema = z.object({
  item_id: ItemIdSchema,
  account: AccountCodeSchema,
  level: PlacementLevelSchema,
  sign: SignSchema.nullable(),
  word: z.string(),
  detail: z.string().nullable(),
  /** Date of the last placement on the page. */
  last_on: LocalDateSchema.nullable(),
  has_turn: z.boolean(),
  has_trouble: z.boolean(),
  /** Surfaces with a placement of any level (exact, candidate, КМ mark). */
  placed_on: z.array(SurfaceKindSchema),
  /** Surfaces with an active plan row. */
  planned_on: z.array(SurfaceKindSchema),
  /** FYP: a unique version for this page exists. */
  has_fyp_version: z.boolean(),
  views: z.int().nonnegative().nullable(),
  stats_on: LocalDateSchema.nullable(),
})
export type PageSummaryEntry = z.infer<typeof PageSummaryEntrySchema>
