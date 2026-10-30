import { randomUUID } from 'node:crypto'
import type { MakeMasterCommand } from '@contentops/contracts/commands/object-files'
import type { MakePpvCommand } from '@contentops/contracts/commands/objects'
import type { AcceptResult } from '@contentops/contracts/domain/inbox'
import type { Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import { acceptGroup } from '../intake/accept'
import { webSource } from '../intake/upload'
import { handleOf, memberships } from './detail'
import { type ItemRow, publicIdOfRow } from './ids'

/**
 * A new PPV from a file already in the catalog (SPEC §6.1): «PPV из кастома как есть» and
 * «Сделать мастером PPV» из сырья — a draft of intake over the same version (origin
 * `derived`), accepted by the same action: the number is issued at acceptance, the blob is not
 * processed again, the link («PPV из кастома», «выделен из») is written with it.
 */

interface SourceVersion {
  versionId: string
  sha: Buffer
  byteSize: number
}

interface NewPpv {
  kind: MakePpvCommand['kind']
  title: string
  secondPerson: boolean | null
}

async function versionBytes(tx: Tx, modelId: string, versionId: string): Promise<SourceVersion> {
  const { rows } = await tx.execute<{ sha: Buffer; byte_size: string }>(sql`
    SELECT v.master_sha256 AS sha, b.byte_size
      FROM asset_versions v JOIN blobs b ON b.sha256 = v.master_sha256
     WHERE v.model_id = ${modelId}::uuid AND v.id = ${versionId}::uuid`)
  const row = rows[0]
  if (!row) throw new ApiProblem('not_found', 'Такой версии файла нет')
  return { versionId, sha: row.sha, byteSize: Number(row.byte_size) }
}

async function acceptDerivedPpv(
  tx: Tx,
  model: ModelScope,
  actor: Actor,
  source: SourceVersion,
  ppv: NewPpv,
  link: { relation: 'ppv_from_custom' | 'extracted_from'; parent: ItemRow; path: string },
): Promise<AcceptResult> {
  const sourceId = await webSource(tx, model.id)
  const from = publicIdOfRow(link.parent)
  const { rows: groups } = await tx.execute<{ id: string }>(sql`
    INSERT INTO inbox_groups (
      model_id, source_id, group_key, grouping, evidence, proposed_type, proposed_title,
      proposed_ppv_kind, has_second_person
    ) VALUES (
      ${model.id}::uuid, ${sourceId}::uuid, ${`derived:${from}:${randomUUID()}`}, 'manual',
      ${JSON.stringify({ root: from, path: link.path, files: 1 })}::jsonb, 'PPV',
      ${ppv.title.trim()}, ${ppv.kind}, ${ppv.secondPerson}
    )
    RETURNING id`)
  const groupId = (groups[0] as { id: string }).id
  await tx.execute(sql`
    INSERT INTO inbox_drafts (
      model_id, group_id, from_version_id, origin, state, byte_size, path, source_sha256,
      source_blob_sha256, master_sha256, master_is_source, master_verified_at, ready_at,
      proposed_role
    ) VALUES (
      ${model.id}::uuid, ${groupId}::uuid, ${source.versionId}::uuid, 'derived', 'ready',
      ${source.byteSize}, ${link.path}, ${source.sha}, ${source.sha}, ${source.sha}, true, now(),
      now(), 'master'
    )`)
  const result = await acceptGroup(tx, model, actor, groupId, { as: 'default', how: 'new' })
  await linkNewPpv(tx, model, actor, result.item_id, link.relation, link.parent.id)
  return result
}

/** The link of a new PPV to the object it was made from. */
export async function linkNewPpv(
  tx: Tx,
  model: ModelScope,
  actor: Actor,
  publicId: string,
  relation: 'ppv_from_custom' | 'extracted_from',
  parentId: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO provenance (model_id, relation, child_item_id, parent_item_id, basis, created_by)
    SELECT ${model.id}::uuid, ${relation}, c.id, ${parentId}::uuid, 'manual', ${actor.id}::uuid
      FROM content_items c
     WHERE c.model_id = ${model.id}::uuid AND public_item_id(c.type, c.number) = ${publicId}`)
}

/**
 * A custom a PPV may be made from (DESIGN §4.5, §6.6): a live CUS without a PPV of its own;
 * `asIs` — only when the fan's name does not sound in the video (the order's name wins over
 * the object's, catalog index of migration 0004).
 */
export async function requireCustomForPpv(
  tx: Tx,
  model: ModelScope,
  custom: ItemRow,
  asIs: boolean,
): Promise<void> {
  const source = publicIdOfRow(custom)
  if (custom.type !== 'CUS') throw new ApiProblem('invalid_request', 'PPV делается из кастома')
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
  if (!asIs) return
  const { rows: names } = await tx.execute<{ name: string | null }>(sql`
    SELECT name_in_media AS name FROM catalog_index
     WHERE model_id = ${model.id}::uuid AND item_id = ${custom.id}::uuid`)
  if (names[0]?.name !== 'no') {
    throw new ApiProblem('accept_blocked', 'Имя фана может звучать — нужен свой монтаж', {
      reason: 'fan_name',
    })
  }
}

/**
 * «Сделать PPV» из кастома, «Взять мастер как есть» (DESIGN §6.6). Свой монтаж приходит
 * загрузкой с целью «PPV из CUS-…» (`POST …/uploads`, SPEC §6.1) — эта команда его не берёт.
 */
export async function makePpvFromCustom(
  tx: Tx,
  model: ModelScope,
  custom: ItemRow,
  body: MakePpvCommand,
  actor: Actor,
): Promise<AcceptResult> {
  const source = publicIdOfRow(custom)
  if (body.source !== 'as_is') {
    throw new ApiProblem(
      'invalid_request',
      `Свой монтаж загружается с целью «PPV из ${source}»: «Загрузить свой монтаж»`,
    )
  }
  await requireCustomForPpv(tx, model, custom, true)
  const { rows: masters } = await tx.execute<{ version_id: string }>(sql`
    SELECT a.current_version_id AS version_id
      FROM item_memberships im
      JOIN assets a ON a.model_id = im.model_id AND a.id = im.asset_id
     WHERE im.model_id = ${model.id}::uuid AND im.item_id = ${custom.id}::uuid
       AND im.kind = 'owned' AND im.role = 'master' AND im.variant_no = 0
       AND im.removed_at IS NULL
     LIMIT 1`)
  const master = masters[0]
  if (!master) {
    throw new ApiProblem('accept_blocked', `У ${source} нет мастера`, { reason: 'no_master' })
  }
  return acceptDerivedPpv(
    tx,
    model,
    actor,
    await versionBytes(tx, model.id, master.version_id),
    { kind: body.kind, title: body.title, secondPerson: custom.has_second_person },
    { relation: 'ppv_from_custom', parent: custom, path: `${source} · мастер` },
  )
}

/**
 * «Сделать мастером PPV» (DESIGN §4.5): видео из сырья становится мастером нового PPV как
 * есть; связь «выделен из» ведёт к съёмке, файл в сырье остаётся.
 */
export async function makeMasterFromRaw(
  tx: Tx,
  model: ModelScope,
  raw: ItemRow,
  body: MakeMasterCommand,
  actor: Actor,
): Promise<AcceptResult> {
  if (raw.type !== 'RAW') throw new ApiProblem('invalid_request', 'Это можно только у сырья')
  const file = (await memberships(tx, model, [raw.id])).find(
    (row) =>
      row.kind === 'owned' && handleOf(row.role, row.ordinal, row.variant_no) === body.file_key,
  )
  if (!file) {
    throw new ApiProblem('invalid_request', 'Такого файла в объекте нет', {
      keys: [body.file_key],
    })
  }
  if (file.media_kind !== 'video') {
    throw new ApiProblem('invalid_request', 'Мастером становится видео')
  }
  const result = await acceptDerivedPpv(
    tx,
    model,
    actor,
    await versionBytes(tx, model.id, file.version_id),
    { kind: body.kind, title: body.title, secondPerson: raw.has_second_person },
    { relation: 'extracted_from', parent: raw, path: `${publicIdOfRow(raw)}/${body.file_key}` },
  )
  // The shooting day of the footage is the PPV's.
  await tx.execute(sql`
    UPDATE content_items c SET shot_on = r.shot_on
      FROM content_items r
     WHERE c.model_id = ${model.id}::uuid AND public_item_id(c.type, c.number) = ${result.item_id}
       AND r.model_id = c.model_id AND r.id = ${raw.id}::uuid AND r.shot_on IS NOT NULL`)
  return result
}
