import type { HubCoverage } from '@contentops/contracts/domain/placement'
import { formatClock, formatStamp } from '@contentops/contracts/format'
import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { type HubPageState, hubPageStates } from '../views'

/**
 * What the screens need to know about Hub on the pages of a model (SPEC §7, §8): whether matching
 * works there and can conclude, since when Hub sees the page, the vault albums with their walks
 * and the files a full walk no longer finds. Read once per request with the plan state.
 */

export interface PageHub {
  accountId: string
  /** A Hub page code and a poll that ran at least once (the key is in the environment). */
  configured: boolean
  receive: boolean
  autoMatch: boolean
  /** Since when the switch that stops matching is off. */
  offSince: string | null
  poll: HubPageState | null
  /** Entry E7: Hub proves the coverage of the posts of the page. */
  postsProven: boolean
  visibleFrom: string | null
  albums: { ref: string; title: string; walkedAt: string | null }[]
}

export interface HubFacts {
  pages: Map<string, PageHub>
  /** `album|media` of vault files a full walk no longer finds → since when. */
  missing: Map<string, string>
}

export async function loadHubFacts(q: Queryable, modelId: string, now: Date): Promise<HubFacts> {
  const { rows: accounts } = await q.execute<{
    id: string
    code: string
    hub_page_ref: string | null
    synced: boolean
    proven: boolean
    visible_from: string | null
  }>(sql`
    SELECT a.id, a.code, a.hub_page_ref,
           EXISTS (SELECT 1 FROM hub_sync_state s WHERE s.account_id = a.id) AS synced,
           EXISTS (SELECT 1 FROM hub_sync_state s
                    WHERE s.account_id = a.id AND s.dataset = 'posts'
                      AND s.proven_complete_at IS NOT NULL
                      AND NOT ('gaps_present' = ANY (coalesce(s.blockers, '{}')))) AS proven,
           (SELECT min(p.published_at)::date::text FROM hub_posts p
             WHERE p.model_id = a.model_id AND p.account_id = a.id) AS visible_from
      FROM accounts a WHERE a.model_id = ${modelId}::uuid`)
  const { rows: switches } = await q.execute<{
    key: string
    account_id: string | null
    model_id: string | null
    value: unknown
    updated_at: string
  }>(sql`
    SELECT key, account_id, model_id, value, updated_at::text FROM policy_settings
     WHERE key IN ('hub.receive', 'hub.auto_match') AND item_type IS NULL
       AND (model_id IS NULL OR model_id = ${modelId}::uuid)`)
  const polls = await hubPageStates(
    q,
    now,
    accounts.map((row) => row.id),
  )
  const { rows: albums } = await q.execute<{
    account_id: string
    album_ref: string
    title: string
    walked_at: string | null
  }>(sql`
    SELECT account_id, album_ref, title, last_full_walk_at::text AS walked_at FROM hub_vault_albums
     WHERE model_id = ${modelId}::uuid AND nullif(trim(title), '') IS NOT NULL`)
  const { rows: missing } = await q.execute<{ key: string; since: string }>(sql`
    SELECT a.album_ref || '|' || m.media_ref AS key, m.missing_since::text AS since
      FROM hub_vault_media m JOIN hub_vault_albums a ON a.model_id = m.model_id AND a.id = m.album_id
     WHERE m.model_id = ${modelId}::uuid AND m.missing_since IS NOT NULL AND m.media_ref IS NOT NULL`)

  const switchOf = (key: string, accountId: string) => {
    const levels = switches.filter(
      (row) => row.key === key && (row.account_id === null || row.account_id === accountId),
    )
    const on =
      levels.some((row) => row.value === true) && !levels.some((row) => row.value === false)
    const off = levels.filter((row) => row.value === false).map((row) => row.updated_at)
    return { on, since: off.sort().at(-1) ?? null }
  }
  const pages = new Map<string, PageHub>()
  for (const account of accounts) {
    const receive = switchOf('hub.receive', account.id)
    const autoMatch = switchOf('hub.auto_match', account.id)
    pages.set(account.code, {
      accountId: account.id,
      configured: account.hub_page_ref !== null && account.synced,
      receive: receive.on,
      autoMatch: autoMatch.on,
      offSince:
        [receive.since, autoMatch.since]
          .filter((at): at is string => at !== null)
          .sort()
          .at(-1) ?? null,
      poll: polls.get(account.id) ?? null,
      postsProven: account.proven,
      visibleFrom: account.visible_from,
      albums: albums
        .filter((row) => row.account_id === account.id)
        .map((row) => ({
          ref: row.album_ref,
          title: row.title,
          walkedAt: row.walked_at ? new Date(row.walked_at).toISOString() : null,
        })),
    })
  }
  return {
    pages,
    missing: new Map(missing.map((row) => [row.key, new Date(row.since).toISOString()])),
  }
}

/** The state of a page's poll in the words of a row (DESIGN §5.2 «не проверено»). */
function downReason(poll: HubPageState, now: string): string | null {
  const since = poll.since ? formatClock(poll.since) : null
  switch (poll.downReason) {
    case 'stale':
      return poll.since ? `Hub не обновлял посты с ${formatStamp(poll.since, now)}` : null
    case 'token_rejected':
      return since ? `Токен Hub не принят с ${since}` : 'Токен Hub не принят'
    case 'format_changed':
      return 'Hub изменил формат данных — опрос остановлен'
    default:
      return null
  }
}

/**
 * The coverage of a page and surface for the placement function (SPEC §7, §8): no Hub page or no
 * poll yet — «не настроено»; receiving or matching off — «выключено»; the poll down or stale —
 * «временно недоступно»; working — `complete` only with the proof of entry E7, else `unproven`.
 */
export function coverageOf(page: PageHub | undefined, surface: string, now: string): HubCoverage {
  const visible = page?.visibleFrom ?? null
  if (!page?.configured) return { state: 'unset', since: null, visible_from: null }
  if (!page.receive || !page.autoMatch) {
    return { state: 'off', since: page.offSince, visible_from: visible }
  }
  if (page.poll?.state === 'down') {
    return {
      state: 'down',
      since: page.poll.since,
      visible_from: visible,
      reason: downReason(page.poll, now),
    }
  }
  if (surface === 'vault') return { state: 'unproven', since: null, visible_from: visible }
  return { state: page.postsProven ? 'complete' : 'unproven', since: null, visible_from: visible }
}
