import { randomUUID } from 'node:crypto'
import type { MakePpvCommand } from '@contentops/contracts/commands/objects'
import type { AcceptResult } from '@contentops/contracts/domain/inbox'
import type { Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import { acceptGroup } from '../intake/accept'
import { webSource } from '../intake/upload'
import { type ItemRow, publicIdOfRow } from './ids'

/**
 * «Сделать PPV» из кастома с «Взять мастер как есть» (DESIGN §4.5, §6.6; SPEC §6.1): черновик
 * приёмки над той же версией мастера, принятый тем же действием, — номер выдаётся при
 * принятии, блоб повторно не обрабатывается; связь «PPV из кастома» пишется сама, имя фана
 * не переносится. Как есть — только когда имени фана в ролике нет; иначе нужен свой монтаж.
 */
export async function makePpvFromCustom(
  tx: Tx,
  model: ModelScope,
  custom: ItemRow,
  body: MakePpvCommand,
  actor: Actor,
): Promise<AcceptResult> {
  const source = publicIdOfRow(custom)
  if (custom.type !== 'CUS') {
    throw new ApiProblem('invalid_request', 'PPV делается из кастома')
  }
  if (body.source !== 'as_is') {
    throw new ApiProblem('not_implemented', 'Свой монтаж для PPV из кастома — следующим шагом')
  }
  // The name of the order wins over the object's own (catalog index, migration 0004).
  const { rows: names } = await tx.execute<{ name: string | null }>(sql`
    SELECT name_in_media AS name FROM catalog_index
     WHERE model_id = ${model.id}::uuid AND item_id = ${custom.id}::uuid`)
  if (names[0]?.name !== 'no') {
    throw new ApiProblem('accept_blocked', 'Имя фана может звучать — нужен свой монтаж', {
      reason: 'fan_name',
    })
  }
  const { rows: made } = await tx.execute<{ id: string }>(sql`
    SELECT public_item_id(c.type, c.number) AS id
      FROM provenance p
      JOIN content_items c ON c.model_id = p.model_id AND c.id = p.child_item_id
     WHERE p.model_id = ${model.id}::uuid AND p.parent_item_id = ${custom.id}::uuid
       AND p.relation = 'ppv_from_custom' AND p.voided_by_id IS NULL AND c.deleted_at IS NULL
     LIMIT 1`)
  if (made[0]) {
    throw new ApiProblem('accept_blocked', `PPV из ${source} уже есть: ${made[0].id}`, {
      reason: 'already_made',
      item_id: made[0].id,
    })
  }
  const { rows: masters } = await tx.execute<{
    version_id: string
    sha: Buffer
    byte_size: string
  }>(sql`
    SELECT v.id AS version_id, v.master_sha256 AS sha, b.byte_size
      FROM item_memberships im
      JOIN assets a ON a.model_id = im.model_id AND a.id = im.asset_id
      JOIN asset_versions v ON v.model_id = a.model_id AND v.id = a.current_version_id
      JOIN blobs b ON b.sha256 = v.master_sha256
     WHERE im.model_id = ${model.id}::uuid AND im.item_id = ${custom.id}::uuid
       AND im.kind = 'owned' AND im.role = 'master' AND im.variant_no = 0
       AND im.removed_at IS NULL
     LIMIT 1`)
  const master = masters[0]
  if (!master) {
    throw new ApiProblem('accept_blocked', `У ${source} нет мастера`, { reason: 'no_master' })
  }

  const sourceId = await webSource(tx, model.id)
  const { rows: groups } = await tx.execute<{ id: string }>(sql`
    INSERT INTO inbox_groups (
      model_id, source_id, group_key, grouping, evidence, proposed_type, proposed_title,
      proposed_ppv_kind, has_second_person
    ) VALUES (
      ${model.id}::uuid, ${sourceId}::uuid, ${`ppv-from:${source}:${randomUUID()}`}, 'manual',
      ${JSON.stringify({ root: `PPV из ${source}`, path: source, files: 1 })}::jsonb, 'PPV',
      ${body.title.trim()}, ${body.kind}, ${custom.has_second_person}
    )
    RETURNING id`)
  const groupId = (groups[0] as { id: string }).id
  await tx.execute(sql`
    INSERT INTO inbox_drafts (
      model_id, group_id, from_version_id, origin, state, byte_size, path, source_sha256,
      source_blob_sha256, master_sha256, master_is_source, master_verified_at, ready_at,
      proposed_role
    ) VALUES (
      ${model.id}::uuid, ${groupId}::uuid, ${master.version_id}::uuid, 'derived', 'ready',
      ${Number(master.byte_size)}, ${`${source} · мастер`}, ${master.sha}, ${master.sha},
      ${master.sha}, true, now(), now(), 'master'
    )`)
  const result = await acceptGroup(tx, model, actor, groupId, { as: 'default', how: 'new' })
  await tx.execute(sql`
    INSERT INTO provenance (model_id, relation, child_item_id, parent_item_id, basis, created_by)
    SELECT ${model.id}::uuid, 'ppv_from_custom', c.id, ${custom.id}::uuid, 'manual',
           ${actor.id}::uuid
      FROM content_items c
     WHERE c.model_id = ${model.id}::uuid AND public_item_id(c.type, c.number) = ${result.item_id}`)
  return result
}
