import { createHash } from 'node:crypto'
import type { AgentSendReason } from '@contentops/contracts/domain/plan'
import { EXPORT_NAME_PATTERN } from '@contentops/contracts/download-name'
import type { DraftInput, MediaKey } from '@contentops/hub'
import type { DbSurface, PublicationKind, RowRecord } from '../plan/records'

/**
 * The rules of publishing a plan row through Hub (SPEC §7 «Публикация через Hub», table of
 * surfaces; PLAN 5б), without the database: which kind a row becomes, what Hub does not publish,
 * what an agent may send, when a file in the page's vault is the very same file, and the
 * fingerprint of a draft.
 */

export type KindRule = { kind: PublicationKind; manual: null } | { kind: null; manual: string }

/**
 * Wall — `subscriber_post`, with a price `paid_post` (Hub holds it until the owner sets the
 * page's price ranges); FYP — `fyp_post`, vault — `vault_album` (both Fansly only); story —
 * `story`; a mass message — by hand only.
 */
export function kindRule(
  platform: 'fansly' | 'onlyfans',
  surface: DbSurface,
  priceMills: number | null,
): KindRule {
  const manual = (text: string): KindRule => ({ kind: null, manual: text })
  switch (surface) {
    case 'mass_dm':
      return manual('Рассылку Hub не отправляет — только вручную')
    case 'wall':
      return {
        kind: priceMills !== null && priceMills > 0 ? 'paid_post' : 'subscriber_post',
        manual: null,
      }
    case 'fyp':
      return platform === 'fansly'
        ? { kind: 'fyp_post', manual: null }
        : manual('Фуп через Hub — только на Fansly')
    case 'vault':
      return platform === 'fansly'
        ? { kind: 'vault_album', manual: null }
        : manual('Vault OnlyFans через Hub не заливается — только вручную')
    case 'story':
      return { kind: 'story', manual: null }
  }
}

/** Free posts an agent may send by itself (decision of the owner 11.11.2026). */
const AGENT_KINDS: readonly PublicationKind[] = ['fyp_post', 'subscriber_post', 'vault_album']

export type AgentSendRow = Pick<
  RowRecord,
  | 'platform'
  | 'surface'
  | 'item_type'
  | 'price_mills'
  | 'release_id'
  | 'row_version'
  | 'approved_version'
  | 'hub_status'
  | 'hub_sent_at'
  | 'hub_prepared_version'
  | 'hub_checks'
>

/**
 * Why an agent may not send this row now (SPEC §7 «Публикация через Hub», §11.1; decision of
 * the owner 11.11.2026), `null` — it may. An agent sends free posts of a week the owner approved:
 * a FYP, a set or a life on the wall without a price, a vault album; never a priced post or a
 * PPV on the wall (an empty price must not let it out free), a story, a mass message or a row of
 * a PPV release. The row is the version the owner approved, the approval was not spent on a send
 * yet (a send clears it), the draft in Hub was prepared from that version and Hub found nothing
 * in it — neither blocking nor a warning. Without a draft there is nothing to send yet: the
 * ordinary rules of «Отправить» say why. The route, the work right before Hub's approve and the
 * views all ask this one function.
 */
export function agentSendRefusal(row: AgentSendRow): AgentSendReason | null {
  if (row.release_id !== null) return 'release'
  const price = row.price_mills === null ? null : Number(row.price_mills)
  if ((price ?? 0) > 0 || (row.surface === 'wall' && row.item_type === 'PPV')) return 'paid'
  const { kind } = kindRule(row.platform, row.surface, price)
  if (kind === null || !AGENT_KINDS.includes(kind)) return 'kind'
  if (kind === 'subscriber_post' && row.item_type !== 'SET' && row.item_type !== 'LIFE') {
    return 'kind'
  }
  if (row.approved_version === null) return row.hub_sent_at !== null ? 'spent' : 'not_approved'
  if (row.approved_version !== row.row_version) return 'changed'
  if (row.hub_status !== 'draft') return null
  if (row.hub_prepared_version !== row.row_version) return 'changed'
  const checks = row.hub_checks
  if (!checks || checks.blocked || checks.findings.length > 0) return 'hub_findings'
  return null
}

/** The refusal in words: the 403 of the route and the error of the work. */
export const AGENT_SEND_TEXT: Record<AgentSendReason, string> = {
  not_approved: 'Строку не утверждал владелец — агент её не отправляет',
  changed: 'Строку изменили после утверждения владельца или после «Подготовить»',
  spent: 'Утверждение уже ушло на отправку — строку утверждают заново',
  paid: 'Платный пост — отправляет только человек',
  kind: 'Такую строку отправляет только человек',
  release: 'Строку выпуска PPV отправляет только человек',
  hub_findings: 'У черновика есть проверки Hub — отправляет человек',
}

/** OnlyFans: posts and stories only from files already in the page's vault (SPEC §7). */
export const ONLYFANS_VAULT_ONLY =
  'OnlyFans: Hub публикует только файлы, уже лежащие в vault этой страницы, пока владелец не решит про кредиты OnlyFansAPI'

/**
 * The identity of a download name (naming §5): object, role, number, unique version and file
 * version; the page-and-date suffix, the length and the extension do not count (SPEC §7: both
 * forms of the name match). `null` — not a ContentOps name.
 */
export function nameIdentity(name: string): string | null {
  const base = name.replace(/\.[A-Za-z0-9]{2,5}$/, '')
  for (const candidate of [base, base.replace(/^[a-z]+(?=-\d)/, (type) => type.toUpperCase())]) {
    const match = EXPORT_NAME_PATTERN.exec(`${candidate}.mp4`)
    const g = match?.groups
    if (g) {
      return [g.id, g.role, g.ord ? Number(g.ord) : '', g.uniq ?? '', g.version ?? ''].join('|')
    }
  }
  return null
}

/** A vault member of the page as the mirror holds it. */
export interface VaultMember {
  media_ref: string
  custom_filename: string | null
  filename: string | null
  duration_ms: number | null
  orig_width: number | null
  orig_height: number | null
}

/**
 * What goes to the platform: its download name, length and the frames it may have (the master's,
 * the built copy's).
 */
export interface PublishedFile {
  name: string
  duration_ms: number | null
  frames: readonly { width: number; height: number }[]
}

/** Lengths differ by less than this: the same encode (Hub rounds; OnlyFans gives seconds). */
export const SAME_DURATION_MS = 1_000

function sameFrame(file: PublishedFile, member: VaultMember): boolean {
  if (member.orig_width === null || member.orig_height === null) return true
  if (file.frames.length === 0) return true
  // A pair without rotation (SPEC §7).
  return file.frames.some(
    (frame) =>
      (frame.width === member.orig_width && frame.height === member.orig_height) ||
      (frame.width === member.orig_height && frame.height === member.orig_width),
  )
}

/**
 * The very same file already in the page's vault (SPEC §7): `vault_media` has no SHA-256, so it
 * is the same download name (naming §5), the same frame and the same length.
 */
export function sameVaultFile(
  file: PublishedFile,
  members: readonly VaultMember[],
): VaultMember | null {
  const identity = nameIdentity(file.name)
  if (!identity) return null
  return (
    members.find((member) => {
      const names = [member.custom_filename, member.filename].filter(
        (name): name is string => name !== null,
      )
      if (!names.some((name) => nameIdentity(name) === identity)) return false
      if (!sameFrame(file, member)) return false
      if (file.duration_ms !== null && member.duration_ms !== null) {
        return Math.abs(file.duration_ms - member.duration_ms) < SAME_DURATION_MS
      }
      return true
    }) ?? null
  )
}

/** What a draft is, without its idempotency key: two equal fingerprints are one draft. */
export function draftFingerprint(draft: Omit<DraftInput, 'idempotencyKey'>): string {
  const canonical = {
    kind: draft.kind,
    publishAt: new Date(draft.publishAt).toISOString(),
    caption: draft.caption ?? null,
    albumName: draft.albumName ?? null,
    media: [...draft.media],
    previews: [...(draft.previews ?? [])],
    audience: draft.audience ?? { kind: 'subscribers' },
    priceMills: draft.priceMills ?? null,
    repost: draft.repost ?? false,
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/**
 * The idempotency key of a draft: the row, the publication it follows (a prepare after «не
 * вышло» or a cancel is a new draft even with the same content) and the content.
 */
export function draftKey(rowId: string, previous: number | null, fingerprint: string): string {
  return `contentops:${rowId}:${previous ?? 0}:${fingerprint.slice(0, 16)}`
}

export const vaultKey = (mediaRef: string): MediaKey => `vault:${mediaRef}`
export const fileKey = (fileId: number): MediaKey => `file:${fileId}`

/** Hub keeps uploaded bytes 7 days; a file older than this is uploaded again (same id back). */
export const UPLOAD_KEEP_MS = 6 * 24 * 60 * 60_000

/** Hub statuses after which nothing changes by itself: no more reading. */
export const FINAL_STATUSES = [
  'published',
  'not_published',
  'rejected',
  'missed',
  'withdrawn',
  'cancelled',
] as const

/** A new draft may replace these (a draft, or one that ended without going out). */
export function replaceable(status: string | null): boolean {
  return (
    status === null ||
    status === 'draft' ||
    status === 'cancelled' ||
    status === 'not_published' ||
    status === 'rejected' ||
    status === 'missed' ||
    status === 'withdrawn'
  )
}
