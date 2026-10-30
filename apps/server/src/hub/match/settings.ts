import { thresholdFor } from '@contentops/contracts/domain/system'
import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { readThresholds } from '../../handlers/thresholds'

/**
 * The settings of matching for one page (SPEC §7 «Настройки», schema §3.1, §9.6): rows of
 * `policy_settings`, the most specific scope wins; no value — the function is off. There are no
 * seeds: the owner sets them on the first day of stage 5.
 */
export interface MatchSettings {
  /** `hub_candidate_tolerance`, minutes: a post in ± of the slot is a candidate of the row. */
  toleranceMin: number | null
  /** `hub_exact_duration_ms`: without it no video is exact and no video is mass confirmed. */
  durationMs: number | null
  /** `hub_wait_window`, hours. */
  waitHours: number | null
  /** `hub_not_out_window`, hours (used only once entry E7 proves the coverage of posts). */
  notOutHours: number | null
  /** `hub_vault_recheck`, days: «Hub не обходил альбом N дней». */
  vaultRecheckDays: number | null
  /** `hub_ad_markers`: signs of an ad of another page; `null` — ads are not hidden. */
  ads: AdMarkers | null
}

/**
 * `hub_ad_markers` of a page (schema §3.1): `{"tags": ["#ads"], "own_handles": ["loravie"]}`.
 * A post without plan is an ad when its caption has one of the tags or an `@handle` that is not
 * the page's own, and none of its files is a file of the model by duration and size (SPEC §7).
 */
export interface AdMarkers {
  tags: string[]
  ownHandles: string[]
}

export interface PageScope {
  modelId: string
  modelCode: string
  accountId: string
  accountCode: string
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    : []
}

export function parseAdMarkers(value: unknown): AdMarkers | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const tags = strings(record.tags).map((tag) => tag.trim().toLowerCase())
  const ownHandles = strings(record.own_handles).map((handle) =>
    handle.trim().replace(/^@/, '').toLowerCase(),
  )
  if (tags.length === 0 && ownHandles.length === 0) return null
  return { tags, ownHandles }
}

/** A JSON setting of the page: page, then model, then everything. */
async function pageValue(q: Queryable, key: string, page: PageScope): Promise<unknown> {
  const { rows } = await q.execute<{ value: unknown }>(sql`
    SELECT value FROM policy_settings
     WHERE key = ${key} AND item_type IS NULL AND value IS NOT NULL
       AND (model_id IS NULL OR model_id = ${page.modelId}::uuid)
       AND (account_id IS NULL OR account_id = ${page.accountId}::uuid)
     ORDER BY (account_id IS NOT NULL) DESC, (model_id IS NOT NULL) DESC
     LIMIT 1`)
  return rows[0]?.value ?? null
}

export async function matchSettings(q: Queryable, page: PageScope): Promise<MatchSettings> {
  const thresholds = await readThresholds(q)
  const target = { model: page.modelCode, account: page.accountCode }
  return {
    toleranceMin: thresholdFor(thresholds, 'time_tolerance_min', target),
    durationMs: thresholdFor(thresholds, 'duration_tolerance_ms', target),
    waitHours: thresholdFor(thresholds, 'wait_hub_hours', target),
    notOutHours: thresholdFor(thresholds, 'not_published_hours', target),
    vaultRecheckDays: thresholdFor(thresholds, 'album_walk_reminder_days', target),
    ads: parseAdMarkers(await pageValue(q, 'hub_ad_markers', page)),
  }
}
