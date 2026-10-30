import type { LabelMapping, LabelTarget } from '@contentops/contracts/domain/legacy'
import { LabelTargetSchema } from '@contentops/contracts/domain/legacy'
import { logAction, type Queryable, type Tx } from '@contentops/db'
import type { ProposedAccount } from '@contentops/legacy'
import { sql } from 'drizzle-orm'
import { ApiProblem } from '../errors'

/**
 * «Метки старых имён → страницы» (SPEC §6.3, DESIGN §4.9): the КМ confirms where each label of
 * the old names points. Every label is a model row `legacy.label.<метка>` of `policy_settings`
 * with the target; the journal keeps who set it. Until then the claims of the label wait in the
 * queue and make no placement.
 */

export const LABEL_PREFIX = 'legacy.label.'

export async function labelTargets(
  q: Queryable,
  modelId: string,
): Promise<Map<string, LabelTarget>> {
  const { rows } = await q.execute<{ key: string; value: unknown }>(sql`
    SELECT key, value FROM policy_settings
     WHERE model_id = ${modelId}::uuid AND account_id IS NULL AND item_type IS NULL
       AND starts_with(key, ${LABEL_PREFIX})`)
  const out = new Map<string, LabelTarget>()
  for (const row of rows) {
    const parsed = LabelTargetSchema.safeParse(row.value)
    if (parsed.success) out.set(row.key.slice(LABEL_PREFIX.length), parsed.data)
  }
  return out
}

interface Account {
  code: string
  platform: string
}

async function accountsOf(q: Queryable, modelId: string): Promise<Account[]> {
  const { rows } = await q.execute<Account & Record<string, unknown>>(sql`
    SELECT code, platform FROM accounts
     WHERE model_id = ${modelId}::uuid AND archived_at IS NULL ORDER BY position, code`)
  return rows
}

/**
 * The rule of SPEC §6.3 as a proposal: `usedN` — the N-th Fansly page (`<модель>-N` when it
 * exists), `posted` — the first, `used_all` / `posted_all` — the three historical pages (every
 * Fansly page), the rest — none.
 */
export function proposedTarget(
  account: ProposedAccount | undefined,
  model: string,
  accounts: readonly Account[],
): LabelTarget | null {
  const fansly = accounts.filter((a) => a.platform === 'fansly')
  if (!account || account.kind === 'unknown') return null
  if (account.kind === 'all') {
    return fansly.length > 0 ? { kind: 'accounts', accounts: fansly.map((a) => a.code) } : null
  }
  const code =
    accounts.find((a) => a.code === `${model}-${account.index}`)?.code ??
    fansly[account.index - 1]?.code
  return code ? { kind: 'accounts', accounts: [code] } : null
}

/** The labels of the open and settled usage claims, each with up to three example files. */
export async function labelMappings(
  q: Queryable,
  model: { id: string; code: string },
): Promise<LabelMapping[]> {
  const usage = sql`
    c.model_id = ${model.id}::uuid AND c.claim_kind IN ('used', 'posted')
    AND c.resolution <> 'ignored'`
  const { rows } = await q.execute<{ label: string; count: number; account: ProposedAccount }>(sql`
    SELECT c.payload ->> 'label' AS label, count(*)::int AS count,
           (array_agg(c.payload -> 'account'))[1] AS account
      FROM legacy_claims c WHERE ${usage}
     GROUP BY 1 ORDER BY 2 DESC, 1`)
  const { rows: examples } = await q.execute<{ label: string; id: string; name: string }>(sql`
    WITH named AS (
      SELECT DISTINCT c.payload ->> 'label' AS label, o.id, o.current_name AS name, o.is_dir,
             o.current_path AS path
        FROM legacy_claims c
        JOIN source_objects o ON o.model_id = c.model_id AND o.id = c.source_object_id
       WHERE ${usage}
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY label ORDER BY is_dir, path) AS n FROM named
    )
    SELECT label, id, name FROM ranked WHERE n <= 3 ORDER BY label, n`)
  if (rows.length === 0) return []
  const targets = await labelTargets(q, model.id)
  const accounts = await accountsOf(q, model.id)
  return rows.map((row) => ({
    label: row.label,
    count: row.count,
    examples: examples
      .filter((example) => example.label === row.label)
      .map((example) => ({
        name: example.name,
        thumb: { key: `legacy:${example.id}`, ratio: '3:4' as const },
      })),
    target: targets.get(row.label) ?? null,
    proposed: proposedTarget(row.account, model.code, accounts),
  }))
}

/**
 * Saves the targets of the labels given (`null` clears one); an account must be a page of the
 * model. Returns the labels whose target changed.
 */
export async function saveLabelTargets(
  tx: Tx,
  modelId: string,
  actorId: string | null,
  labels: readonly { label: string; target: LabelTarget | null }[],
): Promise<string[]> {
  const known = new Set((await accountsOf(tx, modelId)).map((a) => a.code))
  const before = await labelTargets(tx, modelId)
  const changed: string[] = []
  for (const { label, target } of labels) {
    if (!/^[\p{L}\p{N}_]{1,40}$/u.test(label)) {
      throw new ApiProblem('invalid_request', `Нет такой метки: ${label}`, { label })
    }
    if (target?.kind === 'accounts') {
      const stranger = target.accounts.find((code) => !known.has(code))
      if (stranger) throw new ApiProblem('invalid_request', `Нет такой страницы: ${stranger}`)
    }
    const was = before.get(label) ?? null
    if (JSON.stringify(was) === JSON.stringify(target)) continue
    changed.push(label)
    if (target === null) {
      await tx.execute(sql`
        DELETE FROM policy_settings
         WHERE model_id = ${modelId}::uuid AND account_id IS NULL AND item_type IS NULL
           AND key = ${LABEL_PREFIX + label}`)
    } else {
      await tx.execute(sql`
        INSERT INTO policy_settings (model_id, key, value, updated_by)
        VALUES (${modelId}::uuid, ${LABEL_PREFIX + label}, ${JSON.stringify(target)}::jsonb,
                ${actorId}::uuid)
        ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE
           SET value = excluded.value, updated_by = excluded.updated_by, updated_at = now(),
               row_version = policy_settings.row_version + 1`)
    }
    await logAction(tx, {
      modelId,
      subjectKind: 'policy_settings',
      subjectLabel: label,
      before: { Страница: targetText(was) },
      after: { Страница: targetText(target) },
    })
  }
  return changed
}

function targetText(target: LabelTarget | null): string {
  if (!target) return '—'
  if (target.kind === 'accounts') return target.accounts.join(', ')
  return target.kind === 'post_number' ? 'номер поста дня' : 'страница неизвестна'
}
