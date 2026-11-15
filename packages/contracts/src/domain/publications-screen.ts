import { z } from 'zod'
import { AccountCodeSchema, InstantSchema, LocalDateSchema } from './common'

/**
 * «Публикации» (products plan §2.4, package C2): ContentOps' own screen over Agency Hub's publications. Hub is the
 * engine (the queue, the sends, the journal); ContentOps reads and acts AS THE SIGNED-IN PERSON through Hub's person's
 * door with the person's grant, so what a person sees and may do is Hub's answer alone: the owner every page, a content
 * manager the pages of her models. Nothing of it is stored here.
 */

/** Why the screen shows no Hub answer: `no_grant` — an own account of ContentOps (nobody in the people registry). */
export const PublicationsHubStateSchema = z.enum([
  'ok',
  'unreachable',
  'no_grant',
  'no_hub',
  'refused',
])
export type PublicationsHubState = z.infer<typeof PublicationsHubStateSchema>

/** The windows of the feed: what goes out, what went out. */
export const PublicationWindowSchema = z.enum(['next7', 'next30', 'last7', 'last30', 'all'])
export type PublicationWindow = z.infer<typeof PublicationWindowSchema>

/** One file of a post: its place, a preview or the post's own file, and the name to show. */
export const PublicationFileSchema = z.object({
  position: z.int().nonnegative(),
  role: z.enum(['media', 'preview']),
  source: z.enum(['vault', 'file']),
  name: z.string().nullable(),
})

/** One check of a post by Hub: what it found, how much it stops. */
export const PublicationFindingSchema = z.object({
  code: z.string(),
  severity: z.string(),
})

export const PublicationRowSchema = z.object({
  id: z.int().positive(),
  /** Hub's page label (`lora-1`) and the page here, when ContentOps knows it. */
  hub_page: z.string(),
  account: AccountCodeSchema.nullable(),
  platform: z.string(),
  kind: z.string(),
  status: z.string(),
  version: z.int().positive(),
  text: z.string(),
  publish_at: InstantSchema,
  expires_at: InstantSchema.nullable(),
  price_mills: z.int().nullable(),
  files: z.array(PublicationFileSchema),
  findings: z.array(PublicationFindingSchema),
  blocked: z.boolean(),
  /** Who made the draft: a person, an agent, Hub itself. */
  author: z.enum(['human', 'agent', 'hub']),
  platform_post_ref: z.string().nullable(),
  status_reason: z.string().nullable(),
  /** A withdrawal or a deletion Hub sent, as its command stands (`confirmed`, `rejected`, …). */
  withdrawal: z.string().nullable(),
  deletion: z.string().nullable(),
  status_changed_at: InstantSchema,
  /** The plan's row this post was prepared from here («подготовлено и отправлено в Hub»). */
  plan_row: z.object({ id: z.string(), date: LocalDateSchema }).nullable(),
})
export type PublicationRow = z.infer<typeof PublicationRowSchema>

/** A post put in the platform's schedule by hand, as Hub last read it. */
export const ManualQueueEntrySchema = z.object({
  queue_id: z.string(),
  publish_at: InstantSchema.nullable(),
  text: z.string(),
  media_count: z.int().nullable(),
})

export const PublicationPageSchema = z.object({
  hub_page: z.string(),
  account: AccountCodeSchema.nullable(),
  label: z.string(),
  platform: z.string(),
  /** The page's publishing: on, off, or stopped by Hub itself (`autostop`). */
  enabled: z.boolean(),
  stopped: z.string().nullable(),
  paid_price_min_mills: z.int().nullable(),
  paid_price_max_mills: z.int().nullable(),
  repost_threshold_days: z.int(),
  daily_limit: z.int().nullable(),
  /** The platform's schedule as Hub last read it; null — Hub does not read this page's schedule. */
  queue: z
    .object({
      read_at: InstantSchema.nullable(),
      complete: z.boolean(),
      stale: z.boolean(),
      refresh_requested_at: InstantSchema.nullable(),
      last_failure: z.string().nullable(),
      manual: z.array(ManualQueueEntrySchema),
    })
    .nullable(),
})
export type PublicationPage = z.infer<typeof PublicationPageSchema>

export const PublicationsFeedSchema = z.object({
  hub: PublicationsHubStateSchema,
  read_at: InstantSchema,
  /** Hub's global switch: off — nothing goes out on any page. */
  global_enabled: z.boolean().nullable(),
  pages: z.array(PublicationPageSchema),
  publications: z.array(PublicationRowSchema),
  /** The list stopped at its limit: narrow the filter. */
  capped: z.boolean(),
})
export type PublicationsFeed = z.infer<typeof PublicationsFeedSchema>

export const PublicationsFeedQuerySchema = z.object({
  window: PublicationWindowSchema.default('next7'),
  /** Hub's status (`draft`, `unknown`…), or `not_out` — «Не вышли» (not published, rejected, missed). */
  status: z.string().max(40).optional(),
  page: z.string().max(100).optional(),
})

export const PublicationEventSchema = z.object({
  at: InstantSchema,
  from: z.string().nullable(),
  to: z.string(),
  actor: z.enum(['human', 'agent', 'hub']),
  reason: z.string().nullable(),
})

export const PublicationCardSchema = z.object({
  hub: PublicationsHubStateSchema,
  publication: PublicationRowSchema.nullable(),
  events: z.array(PublicationEventSchema),
  approved_at: InstantSchema.nullable(),
})
export type PublicationCard = z.infer<typeof PublicationCardSchema>
