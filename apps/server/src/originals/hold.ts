import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { BlobStore } from '../media/storage'
import { configuredModels } from './config'
import { reliableSql } from './rule'

/**
 * The staged sources of intake (`TMP_ROOT/staging/<sha256>.<ext>`, SPEC §9.1) and what holds each
 * one (SPEC §9.4). Intake holds bytes until their master is checked and no media work reads them;
 * then the originals may hold them a while longer, so a model that deletes the file in its cloud
 * before the copy to MEGA is written cannot leave only the re-encoded master. The hold:
 *
 * - only while the switch `originals.enabled` is on for the model and the model has its
 *   `originals.model_config` (the copy work is what the hold waits for);
 * - only for a revision of the model's cloud that has a copy row and is not reliable yet (two
 *   clouds checked, the rule's `places`); never for the import of the old corpus
 *   (`legacy_import`: its bytes come from the copy of Я.Диск, not from a cloud the model empties);
 * - for at most `hours` since intake let the bytes go (the master checked) and at most `gb` of
 *   held bytes, counted once per hash: past either, the newest held bytes stay and the rest go —
 *   the copy is then made cloud to cloud from the model's Dropbox. Policy `originals.staging_hold`
 *   `{"hours": 24, "gb": 20}` by default.
 *
 * The held bytes count in the prefetch budget `FETCH_AHEAD_GB` (`intake/fetch.ts`): the hold never
 * lets the staging grow past what intake may stage. Nothing here removes a file.
 */

export const HOLD_KEY = 'originals.staging_hold'
export const DEFAULT_HOLD = { hours: 24, gb: 20 } as const
export interface HoldLimits {
  hours: number
  gb: number
}

const GB = 1_000_000_000
const HOUR = 3600_000
const UNFINISHED = sql`('pending', 'running', 'retry_wait')`

/** `originals.staging_hold`: what of it is a positive number, the rest by default. */
export async function holdLimits(q: Queryable): Promise<HoldLimits> {
  const { rows } = await q.execute<{ value: unknown }>(sql`
    SELECT value FROM policy_settings
     WHERE key = ${HOLD_KEY} AND model_id IS NULL AND account_id IS NULL AND item_type IS NULL`)
  const value = rows[0]?.value
  const set = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const take = (key: keyof HoldLimits) => {
    const v = set[key]
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_HOLD[key]
  }
  return { hours: take('hours'), gb: take('gb') }
}

/**
 * - `intake` — intake still needs the bytes (no checked master yet, or a media work reads them);
 * - `held` — intake let them go, the originals hold them (above);
 * - `free` — nothing needs them: the sweep removes them;
 * - `foreign` — no draft has these bytes: not intake's, never touched.
 */
export type StagedVerdict = 'intake' | 'held' | 'free' | 'foreign'

export interface StagedFile {
  sha: string
  /** Every file of these bytes in staging. */
  paths: string[]
  bytes: number
  verdict: StagedVerdict
  /** When intake let the bytes go (the master checked or the draft resolved); null — not yet. */
  since: Date | null
}

export interface StagingState {
  files: StagedFile[]
  /** Bytes held by the originals, once per hash. */
  heldBytes: number
  limits: HoldLimits
}

async function listStaging(
  store: BlobStore,
): Promise<Map<string, { paths: string[]; bytes: number }>> {
  const out = new Map<string, { paths: string[]; bytes: number }>()
  let names: string[]
  try {
    names = await readdir(store.stagingDir)
  } catch {
    return out
  }
  for (const name of names.sort()) {
    const sha = name.split('.')[0] ?? ''
    if (!/^[0-9a-f]{64}$/u.test(sha) || name.includes('.part')) continue
    const path = join(store.stagingDir, name)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) continue
    const known = out.get(sha)
    if (known) known.paths.push(path)
    else out.set(sha, { paths: [path], bytes: info.size })
  }
  return out
}

interface Facts extends Record<string, unknown> {
  sha: string
  intake: boolean
  needed: boolean
  awaits: boolean
  since_ms: number | null
}

/** What holds every staged file now. */
export async function stagingState(
  q: Queryable,
  store: BlobStore,
  now: Date = new Date(),
): Promise<StagingState> {
  const limits = await holdLimits(q)
  const staged = await listStaging(store)
  if (staged.size === 0) return { files: [], heldBytes: 0, limits }
  const { models } = await configuredModels(q)
  const { rows } = await q.execute<Facts>(sql`
    WITH s AS (SELECT decode(h, 'hex') AS sha
                 FROM unnest(${sql.param([...staged.keys()])}::text[]) AS h)
    SELECT encode(s.sha, 'hex') AS sha,
           EXISTS (SELECT 1 FROM inbox_drafts d WHERE d.source_sha256 = s.sha) AS intake,
           EXISTS (SELECT 1 FROM inbox_drafts d
                    WHERE d.source_sha256 = s.sha AND d.state <> 'resolved'
                      AND (d.master_verified_at IS NULL OR d.master_sha256 IS NULL))
             OR EXISTS (SELECT 1 FROM work_operations w
                         WHERE w.input_sha256 = s.sha AND w.state IN ${UNFINISHED}) AS needed,
           EXISTS (
             SELECT 1 FROM source_revisions r
               JOIN inbox_drafts d ON d.model_id = r.model_id AND d.source_revision_id = r.id
              WHERE r.source_sha256 = s.sha AND d.origin <> 'legacy_import'
                AND r.model_id = ANY (${sql.param(models.map((model) => model.id))}::uuid[])
                AND EXISTS (SELECT 1 FROM original_copies c
                             WHERE c.model_id = r.model_id AND c.source_revision_id = r.id
                               AND c.role = 'copy' AND c.missing_since IS NULL)
                AND NOT ${reliableSql(sql`r.model_id`, { revision: sql`r.id` })}) AS awaits,
           (SELECT extract(epoch FROM max(COALESCE(d.master_verified_at, d.updated_at))) * 1000
              FROM inbox_drafts d WHERE d.source_sha256 = s.sha)::float8 AS since_ms
      FROM s`)
  const facts = new Map(rows.map((row) => [row.sha, row]))
  const files: StagedFile[] = []
  for (const [sha, file] of staged) {
    const fact = facts.get(sha)
    const since = fact?.since_ms == null ? null : new Date(Number(fact.since_ms))
    let verdict: StagedVerdict
    if (!fact?.intake) verdict = 'foreign'
    else if (fact.needed) verdict = 'intake'
    else if (fact.awaits && since && now.getTime() - since.getTime() < limits.hours * HOUR) {
      verdict = 'held'
    } else verdict = 'free'
    files.push({ sha, ...file, verdict, since: verdict === 'intake' ? null : since })
  }
  // Past the bytes of the hold the newest stay: their copies were queued last.
  let heldBytes = 0
  const held = files
    .filter((file) => file.verdict === 'held')
    .sort((a, b) => (b.since?.getTime() ?? 0) - (a.since?.getTime() ?? 0))
  for (const file of held) {
    if (heldBytes + file.bytes > limits.gb * GB) {
      file.verdict = 'free'
      continue
    }
    heldBytes += file.bytes
  }
  return { files, heldBytes, limits }
}
