import { mskDate } from '@contentops/contracts/clock'
import { formatDate } from '@contentops/contracts/format'
import type { Db } from '@contentops/db'
import { type HubClient, type HubMatterOpen, isHubError } from '@contentops/hub'
import { sql } from 'drizzle-orm'
import { fromCustom } from '../catalog/from-custom'
import { customRefusal } from '../plan/checks'
import type { DbSurface } from '../plan/records'

/**
 * ContentOps' findings as matters of the hub (ecosystem plan 12.11.2026, package N, item 6): a
 * copy of a custom outside the customs folder (`review_cases` `custom_copy`, SPEC §6.2) and a
 * row of the plan whose object is made from a custom where a custom never goes (SPEC §7). Each
 * opens a matter by its reason key for the owner, who closes the signal; it closes when the
 * cause is gone here. ContentOps is the one writer of its kinds (`write:matters`).
 */

export const CONTENTOPS_MATTER_KINDS = [
  'contentops.custom_copy',
  'contentops.custom_in_plan',
] as const

const SURFACE_WORD: Record<DbSurface, string> = {
  wall: 'стена',
  fyp: 'фуп',
  story: 'сториз',
  vault: 'vault',
  mass_dm: 'рассылка',
}

interface Finding extends HubMatterOpen {
  how: 'resolved' | 'cause_gone'
}

async function customCopies(db: Db, modelId: string, model: string): Promise<Finding[]> {
  const { rows } = await db.execute<{
    id: string
    custom: string
    details: { relative?: string; path?: string; source?: string } | null
    created_at: string
  }>(sql`
    SELECT rc.id, public_item_id(c.type, c.number) AS custom, rc.details,
           rc.created_at::text AS created_at
      FROM review_cases rc
      JOIN content_items c ON c.model_id = rc.model_id AND c.id = rc.item_id
     WHERE rc.model_id = ${modelId}::uuid AND rc.kind = 'custom_copy' AND rc.state = 'open'`)
  return rows.map((row) => {
    const path = row.details?.relative ?? row.details?.path ?? ''
    return {
      key: `contentops.custom_copy:${row.id}`,
      kind: 'contentops.custom_copy',
      title: `Копия кастома ${row.custom} лежит вне папки кастомов${path ? `: ${path}` : ''}`.slice(
        0,
        300,
      ),
      owner: { role: 'owner' },
      object: { type: 'contentops_case', id: row.id },
      evidence: {
        model,
        custom: row.custom,
        path: path.slice(0, 500),
        source: row.details?.source ?? null,
        seenAt: row.created_at,
        rule: 'кастом и всё, что из него сделано, не ставится в фуп, сториз и на стену без цены',
      },
      how: 'resolved',
    }
  })
}

async function customsInPlan(db: Db, modelId: string, model: string): Promise<Finding[]> {
  const { rows } = await db.execute<{
    id: string
    item_id: string
    item: string
    account: string
    hub_page: string | null
    surface: DbSurface
    slot_date: string
    slot_time: string | null
    price_mills: string | null
  }>(sql`
    SELECT r.id, r.item_id, public_item_id(i.type, i.number) AS item, a.code AS account,
           a.hub_page_ref AS hub_page, s.kind AS surface, r.slot_date::text AS slot_date,
           to_char(r.slot_time, 'HH24:MI') AS slot_time, r.price_mills::text AS price_mills
      FROM posting_plan_rows r
      JOIN accounts a ON a.model_id = r.model_id AND a.id = r.account_id
      JOIN surfaces s ON s.model_id = r.model_id AND s.id = r.surface_id
      JOIN content_items i ON i.model_id = r.model_id AND i.id = r.item_id
     WHERE r.model_id = ${modelId}::uuid AND r.cancelled_at IS NULL AND r.mark_kind IS NULL
       AND r.slot_at > now() - interval '1 day'
       AND r.hub_status IS DISTINCT FROM 'published'`)
  if (rows.length === 0) return []
  const customs = await fromCustom(
    db,
    modelId,
    rows.map((row) => row.item_id),
  )
  const today = mskDate(new Date().toISOString())
  return rows.flatMap((row): Finding[] => {
    const custom = customs.get(row.item_id)
    if (!custom) return []
    const price = row.price_mills === null ? null : Number(row.price_mills)
    const refusal = customRefusal(custom, row.surface, price)
    if (!refusal) return []
    const when = `${row.slot_date === today ? 'сегодня' : formatDate(row.slot_date, today)}${row.slot_time ? ` ${row.slot_time}` : ''}`
    return [
      {
        key: `contentops.custom_in_plan:${row.id}`,
        kind: 'contentops.custom_in_plan',
        title:
          `В плане ContentOps ${row.item} — ${refusal.text}: ${row.account} · ${SURFACE_WORD[row.surface]} · ${when}`.slice(
            0,
            300,
          ),
        owner: { role: 'owner' },
        ...(row.hub_page ? { pageLabels: [row.hub_page] } : {}),
        object: { type: 'contentops_plan_row', id: row.id },
        evidence: {
          model,
          item: row.item,
          custom,
          account: row.account,
          surface: row.surface,
          slot: `${row.slot_date}${row.slot_time ? ` ${row.slot_time}` : ''}`,
        },
        how: 'cause_gone',
      },
    ]
  })
}

export interface MattersOutcome {
  opened: number
  closed: number
  /** The key lacks `write:matters`, or the hub refused: in words. */
  error: string | null
}

/**
 * Opens what is found and not open in the hub, closes what is open there and gone here. A key
 * without `write:matters` stops the pass quietly: the findings stay in ContentOps' own screens.
 */
export async function keepMatters(
  db: Db,
  client: HubClient,
  model: { id: string; code: string },
  signal?: AbortSignal,
): Promise<MattersOutcome> {
  const found = [
    ...(await customCopies(db, model.id, model.code)),
    ...(await customsInPlan(db, model.id, model.code)),
  ]
  const { rows: open } = await db.execute<{ key: string; kind: string }>(sql`
    SELECT key, kind FROM hub_matters WHERE model_id = ${model.id}::uuid AND closed_at IS NULL`)
  const isOpen = new Set(open.map((row) => row.key))
  const wanted = new Set(found.map((finding) => finding.key))
  const outcome: MattersOutcome = { opened: 0, closed: 0, error: null }
  const stop = (error: unknown): boolean => {
    if (isHubError(error, 'auth_rejected')) {
      outcome.error = 'ключу Hub не выдано право write:matters'
      return true
    }
    if (isHubError(error)) {
      outcome.error = error.message
      return !isHubError(error, 'refused')
    }
    throw error
  }
  for (const finding of found) {
    if (isOpen.has(finding.key)) continue
    const { how: _how, ...body } = finding
    try {
      await client.openMatter(body, signal)
      outcome.opened++
      await db.execute(sql`
        INSERT INTO hub_matters (model_id, key, kind, title)
        VALUES (${model.id}::uuid, ${finding.key}, ${finding.kind}, ${finding.title})
        ON CONFLICT (model_id, key) DO UPDATE
          SET title = EXCLUDED.title, opened_at = now(), closed_at = NULL, error = NULL`)
    } catch (error) {
      if (stop(error)) return outcome
    }
  }
  for (const row of open) {
    if (wanted.has(row.key)) continue
    const how = row.kind === 'contentops.custom_copy' ? 'resolved' : 'cause_gone'
    try {
      await client.closeMatter({ key: row.key, how }, signal)
    } catch (error) {
      // Gone in the hub already: nothing to close there. Any other refusal keeps it open here.
      if (!isHubError(error, 'refused', 'not_found')) {
        if (stop(error)) return outcome
        continue
      }
    }
    outcome.closed++
    await db.execute(sql`
      UPDATE hub_matters SET closed_at = now(), error = NULL
       WHERE model_id = ${model.id}::uuid AND key = ${row.key}`)
  }
  return outcome
}
