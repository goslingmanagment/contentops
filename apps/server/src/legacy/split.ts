import type { Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { ModelScope } from '../context'
import { autoAcceptGroup } from './auto-accept'

/**
 * ◆ «Разделить архив?» (SPEC §6.3, DESIGN §4.8): an archive with several shoots inside is
 * accepted by its parts — the numbered folders inside, else its top folders. «Разделить» makes a
 * group per part with the part's old number; «Одним объектом» keeps one group. Either way the
 * groups may then be accepted by the import itself.
 */
export async function splitArchive(
  tx: Tx,
  model: ModelScope,
  groupId: string,
  split: boolean,
): Promise<string[]> {
  const { rows } = await tx.execute<{
    group_key: string
    evidence: {
      parts?: Record<string, string>
      numbers?: Record<string, unknown>
      legacy?: { anchor: string }
    } | null
  }>(sql`
    SELECT group_key, evidence FROM inbox_groups
     WHERE model_id = ${model.id}::uuid AND id = ${groupId}::uuid`)
  const group = rows[0]
  const parts = group?.evidence?.parts ?? {}
  const groups = [groupId]
  if (split && group) {
    const byPart = new Map<string, string[]>()
    for (const [revision, part] of Object.entries(parts)) {
      byPart.set(part, [...(byPart.get(part) ?? []), revision])
    }
    // The first part stays in this group (its answer is still this group); the others move.
    const [first, ...rest] = [...byPart.keys()].sort()
    const firstNumber = (first !== undefined ? group.evidence?.numbers?.[first] : null) ?? null
    await tx.execute(sql`
      UPDATE inbox_groups
         SET evidence = coalesce(evidence, '{}'::jsonb)
               || jsonb_build_object('number', ${JSON.stringify(firstNumber)}::jsonb,
                                     'part', ${first ?? ''}::text),
             proposed_type = coalesce(${(firstNumber as { type?: string } | null)?.type ?? null},
                                      proposed_type),
             updated_at = now(), row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND id = ${groupId}::uuid`)
    for (const part of rest) {
      const revisions = byPart.get(part) ?? []
      const number = group.evidence?.numbers?.[part] ?? null
      const evidence = {
        legacy: {
          unit: part || group.evidence?.legacy?.anchor,
          anchor: group.evidence?.legacy?.anchor,
        },
        number,
        split_from: groupId,
      }
      const { rows: created } = await tx.execute<{ id: string }>(sql`
        INSERT INTO inbox_groups (
          model_id, source_id, group_key, grouping, folder_object_id, evidence, proposed_type,
          proposed_title, proposed_title_en, proposed_tags, proposed_ppv_kind, proposed_purpose
        )
        SELECT model_id, source_id, ${`${group.group_key}:${part}`}, 'folder', folder_object_id,
               ${JSON.stringify(evidence)}::jsonb,
               coalesce(${(number as { type?: string } | null)?.type ?? null}, proposed_type),
               proposed_title, proposed_title_en, proposed_tags, proposed_ppv_kind, proposed_purpose
          FROM inbox_groups WHERE model_id = ${model.id}::uuid AND id = ${groupId}::uuid
        ON CONFLICT (model_id, source_id, group_key) DO UPDATE SET updated_at = now()
        RETURNING id`)
      const id = (created[0] as { id: string }).id
      groups.push(id)
      await tx.execute(sql`
        UPDATE inbox_drafts SET group_id = ${id}::uuid, updated_at = now(),
               row_version = row_version + 1
         WHERE model_id = ${model.id}::uuid AND group_id = ${groupId}::uuid AND state <> 'resolved'
           AND source_revision_id = ANY (${sql.param(revisions)}::uuid[])`)
    }
  }
  await tx.execute(sql`
    UPDATE inbox_drafts SET blocked_reason = NULL, updated_at = now(), row_version = row_version + 1
     WHERE model_id = ${model.id}::uuid AND group_id = ANY (${sql.param(groups)}::uuid[])
       AND blocked_reason = 'archive_split'`)
  for (const id of groups) await tx.transaction((inner) => autoAcceptGroup(inner, model, id))
  return groups
}
