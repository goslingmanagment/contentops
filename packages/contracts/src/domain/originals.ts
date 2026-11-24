import { z } from 'zod'
import { InstantSchema } from './common'

/**
 * What the PC may free now (SPEC §9.4, §12.2; ops/README.md «Оригиналы: два места»): the route
 * `admin.originalsRelease` gives the Windows task of one holder the originals the rule lets go
 * that this holder still keeps on the PC. The paths are real file names: the owner and the host
 * agent only.
 */

/**
 * A place on the PC that holds originals: `ydisk_copy` — the copy of Я.Диск on C: (the desktop
 * client's folder, freed by UNPINNED), `e_ari` — Ari's archive `E:\Ari` (the mirror of her
 * Dropbox, freed by deleting the file).
 */
export const ReleaseHolderSchema = z.enum(['ydisk_copy', 'e_ari'])
export type ReleaseHolder = z.infer<typeof ReleaseHolderSchema>

export const OriginalsReleaseQuerySchema = z.object({
  model: z.string().trim().min(1).max(64),
  holder: ReleaseHolderSchema,
})
export type OriginalsReleaseQuery = z.infer<typeof OriginalsReleaseQuerySchema>

/**
 * Why the list is empty although the holder may hold releasable files: the PC's list is missing,
 * old, unreadable or made while the client ran; the owner's switch is off; a release session of
 * the holder runs; the holder is not this model's.
 */
export const ReleaseBlockSchema = z.enum([
  'switch_off',
  'holder_of_other_model',
  'no_list',
  'list_unreadable',
  'list_stale',
  'list_errors',
  'client_running',
  'session_running',
  'host_report_unreadable',
])
export type ReleaseBlock = z.infer<typeof ReleaseBlockSchema>

export const ReleaseFileSchema = z.object({
  /** The revision of the model's cloud the PC's file is (the rule judged this one). */
  revision_id: z.uuid(),
  /** Relative to the holder's root, `/` separators, the name exactly as on disk (from the list). */
  path: z.string().min(1),
  /** From the list the file was found in: the PC frees it only if they are still the same. */
  size: z.int().nonnegative(),
  last_write_utc: z.string().min(1),
  attributes: z.int().nonnegative(),
  /** `e_ari`: the Dropbox content hash of the revision (hex), compared with the local bytes. */
  dropbox_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
})
export type ReleaseFile = z.infer<typeof ReleaseFileSchema>

export const OriginalsReleaseSchema = z.object({
  model: z.string(),
  holder: ReleaseHolderSchema,
  /** `finished_at` of the PC's list the answer was made from. */
  list_finished_at: InstantSchema.nullable(),
  /** Set — nothing is given out, and why. */
  blocked: ReleaseBlockSchema.nullable(),
  /** The batch: at most `limit.files` files and `limit.bytes` bytes. */
  files: z.array(ReleaseFileSchema),
  limit: z.object({
    files: z.int().positive(),
    bytes: z.int().positive(),
    /** Nothing of this holder freed yet (by the PC's own count): the small first batch. */
    first_run: z.boolean(),
  }),
  /** Releasable files of this holder left for the next batches. */
  left: z.object({ files: z.int().nonnegative(), bytes: z.int().nonnegative() }),
})
export type OriginalsRelease = z.infer<typeof OriginalsReleaseSchema>
