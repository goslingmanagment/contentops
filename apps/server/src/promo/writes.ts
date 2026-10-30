import { randomUUID } from 'node:crypto'
import type { AddToPromoCommand, MemberRef, PrepareHandoffCommand } from '@contentops/contracts'
import { slugOf } from '@contentops/contracts/download-name'
import { enqueueWork, logAction, setJournalItem, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { findItem, publicIdOf } from '../catalog/ids'
import { issueNumber } from '../catalog/numbers'
import { logItemAction, touchItem } from '../catalog/writes'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import type { FileRow } from '../media/downloads'
import type { PipelineDigests } from '../media/pipeline'
import { exportKeyOf, storedPlan } from '../media/work/export'
import { planHandoff } from './issue'
import {
  findChannel,
  findCollection,
  findContractor,
  type HandoffSummary,
  handleOf,
  materialKey,
  materialRows,
} from './views'

/**
 * Changing «Промо» (SPEC §5, §7.1): links to existing files without copying bytes, one file
 * once per collection, a new `PRM` number only for a new collection; «Подготовить передачу»
 * seals the versions and the format and starts the build; «Передано» adds the date and the
 * author, once. None of these is a publication.
 */

const memberKey = (ref: MemberRef) => `${ref.item_id}/${ref.file_key}`

interface Resolved {
  asset_id: string
  media_kind: 'video' | 'image'
  variant_no: number
}

/** The files the screen names (`SET-069/ed03`); an unknown one refuses the command. */
async function resolveFiles(tx: Tx, model: ModelScope, refs: readonly MemberRef[]) {
  const result = new Map<string, Resolved>()
  const byItem = new Map<string, MemberRef[]>()
  for (const ref of refs) byItem.set(ref.item_id, [...(byItem.get(ref.item_id) ?? []), ref])
  for (const [itemId, wanted] of byItem) {
    const item = await findItem(tx, model, itemId)
    const { rows } = await tx.execute<{
      asset_id: string
      role: string
      ordinal: number | null
      variant_no: number
      media_kind: 'video' | 'image'
    }>(sql`
      SELECT im.asset_id, im.role, im.ordinal, im.variant_no, a.media_kind
        FROM item_memberships im
        JOIN assets a ON a.model_id = im.model_id AND a.id = im.asset_id
       WHERE im.model_id = ${model.id}::uuid AND im.item_id = ${item.id}::uuid
         AND im.removed_at IS NULL`)
    const byHandle = new Map(
      rows.map((row) => [handleOf(row.role, row.ordinal, row.variant_no), row]),
    )
    for (const ref of wanted) {
      const row = byHandle.get(ref.file_key)
      if (!row) {
        throw new ApiProblem('not_found', `${memberKey(ref)}: такого файла нет`, {
          member: memberKey(ref),
        })
      }
      result.set(memberKey(ref), row)
    }
  }
  return result
}

/** A new collection of the channel with the next `PRM` number (SPEC §4.1). */
async function newCollection(
  tx: Tx,
  model: ModelScope,
  channel: { id: string; title: string },
  title: string | null,
  actor: Actor,
) {
  const number = await issueNumber(tx, model.id, 'PRM')
  const id = randomUUID()
  await setJournalItem(tx, id)
  const name = title?.trim() || `${channel.title} · ${publicIdOf('PRM', number)}`
  await tx.execute(sql`
    INSERT INTO content_items (model_id, id, type, number, title, origin, promo_channel_id,
                               created_by)
    VALUES (${model.id}::uuid, ${id}::uuid, 'PRM', ${number}, ${name}, 'manual',
            ${channel.id}::uuid, ${actor.id}::uuid)`)
  // The name was typed by a person: confirmed at once (SPEC §5).
  await tx.execute(sql`
    INSERT INTO annotation_fields (model_id, item_id, field, value_version, confirmed_value_version,
                                   confirmed_at, confirmed_by, updated_by)
    VALUES (${model.id}::uuid, ${id}::uuid, 'title', 1, 1, now(), ${actor.id}::uuid,
            ${actor.id}::uuid)`)
  await logAction(tx, {
    modelId: model.id,
    action: 'promo.create',
    subjectKind: 'content_items',
    subjectId: id,
    subjectLabel: publicIdOf('PRM', number),
    itemId: id,
    after: [
      ['Канал', channel.title],
      ['Название', name],
    ],
  })
  return { id, type: 'PRM' as const, number }
}

/**
 * «Добавить в → Промо → канал»: references to the files, the source object and its folders
 * stay as they are; a file already in the collection is not added twice.
 */
export async function addToCollection(
  tx: Tx,
  model: ModelScope,
  body: AddToPromoCommand,
  actor: Actor,
): Promise<string> {
  const channel = await findChannel(tx, model, body.channel)
  const item =
    body.collection === 'new'
      ? await newCollection(tx, model, channel, body.title, actor)
      : await findCollection(tx, model, body.collection, { lock: true })
  if ('channel_code' in item && item.channel_code !== channel.code) {
    throw new ApiProblem('invalid_request', `${body.collection} — подборка другого канала`, {
      collection: body.collection,
      channel: body.channel,
    })
  }
  await setJournalItem(tx, item.id)
  const files = await resolveFiles(tx, model, body.members)
  const { rows: present } = await tx.execute<{
    asset_id: string
    removed: boolean
  }>(sql`
    SELECT asset_id, removed_at IS NOT NULL AS removed FROM item_memberships
     WHERE model_id = ${model.id}::uuid AND item_id = ${item.id}::uuid`)
  const state = new Map(present.map((row) => [row.asset_id, row.removed]))
  const { rows: tops } = await tx.execute<{ position: number; clip: number; pic: number }>(sql`
    SELECT coalesce(max(display_position), 0)::int AS position,
           coalesce(max(ordinal) FILTER (WHERE role = 'clip'), 0)::int AS clip,
           coalesce(max(ordinal) FILTER (WHERE role = 'pic'), 0)::int AS pic
      FROM item_memberships
     WHERE model_id = ${model.id}::uuid AND item_id = ${item.id}::uuid`)
  const top = { position: 0, clip: 0, pic: 0, ...tops[0] }
  let added = 0
  for (const file of new Map([...files.values()].map((f) => [f.asset_id, f])).values()) {
    const removed = state.get(file.asset_id)
    if (removed === false) continue
    top.position += 1
    added += 1
    if (removed === true) {
      await tx.execute(sql`
        UPDATE item_memberships
           SET removed_at = NULL, display_position = ${top.position}, added_at = now(),
               added_by = ${actor.id}::uuid, row_version = row_version + 1
         WHERE model_id = ${model.id}::uuid AND item_id = ${item.id}::uuid
           AND asset_id = ${file.asset_id}::uuid`)
      continue
    }
    const role = file.media_kind === 'video' ? 'clip' : 'pic'
    top[role] += 1
    if (top[role] > 999) {
      throw new ApiProblem('invalid_request', 'В подборке больше 999 файлов одного вида', {
        collection: publicIdOf(item.type, item.number),
      })
    }
    await tx.execute(sql`
      INSERT INTO item_memberships (model_id, item_id, item_type, asset_id, variant_no, kind, role,
                                    ordinal, display_position, added_by)
      VALUES (${model.id}::uuid, ${item.id}::uuid, 'PRM', ${file.asset_id}::uuid,
              ${file.variant_no}, 'reference', ${role}, ${top[role]}, ${top.position},
              ${actor.id}::uuid)`)
  }
  if (added > 0) {
    await tx.execute(sql`
      UPDATE content_items SET row_version = row_version + 1, updated_at = now()
       WHERE model_id = ${model.id}::uuid AND id = ${item.id}::uuid`)
    await logItemAction(tx, model, item, {
      after: { Канал: channel.title, Добавлено: String(added) },
    })
  }
  return publicIdOf(item.type, item.number)
}

/** «Убрать из подборки»: the membership is closed; the file and its object stay. */
export async function removeFromCollection(
  tx: Tx,
  model: ModelScope,
  collection: string,
  refs: readonly MemberRef[],
): Promise<void> {
  const item = await findCollection(tx, model, collection, { lock: true })
  await setJournalItem(tx, item.id)
  const files = await resolveFiles(tx, model, refs)
  const assets = [...new Set([...files.values()].map((file) => file.asset_id))]
  const { rowCount } = await tx.execute(sql`
    UPDATE item_memberships
       SET removed_at = now(), display_position = NULL, row_version = row_version + 1
     WHERE model_id = ${model.id}::uuid AND item_id = ${item.id}::uuid AND removed_at IS NULL
       AND asset_id = ANY(${sql.param(assets)}::uuid[])`)
  if (!rowCount) return
  await touchItem(tx, model, item)
  await logItemAction(tx, model, item, {
    before: { Материалы: refs.map(memberKey).join(', ') },
    after: { Материалы: '—' },
  })
}

/**
 * «Подготовить передачу» (SPEC §7.1, §9.3): the chosen files at their current (or pinned)
 * versions become a sealed manifest, the contractor's format is copied onto the handoff, and
 * the export work builds the ZIP from the copies of that format — ready ones reused, missing
 * ones built the same way a download builds them. An unsent handoff of the collection to
 * the same contractor is replaced by this one.
 */
export async function prepareHandoff(
  tx: Tx,
  model: ModelScope,
  collection: string,
  body: PrepareHandoffCommand,
  actor: Actor,
  digests: PipelineDigests,
): Promise<{ handoffId: string; workId: string }> {
  const item = await findCollection(tx, model, collection, { lock: true })
  await setJournalItem(tx, item.id)
  const contractor = await findContractor(tx, model, body.contractor_id)
  const rows = await materialRows(tx, model, { packages: [item.id] })
  const wanted = body.members ? new Set(body.members.map(memberKey)) : null
  if (wanted) {
    const known = new Set(rows.map((row) => memberKey(materialKey(row))))
    const missing = [...wanted].filter((key) => !known.has(key))
    if (missing.length > 0) {
      throw new ApiProblem('not_found', 'Этих материалов в подборке нет', { members: missing })
    }
  }
  let chosen = wanted ? rows.filter((row) => wanted.has(memberKey(materialKey(row)))) : rows
  if (body.exclude_already_handed && chosen.length > 0) {
    const { rows: given } = await tx.execute<{ asset_id: string }>(sql`
      SELECT DISTINCT e.asset_id FROM promo_deliveries d
        JOIN asset_manifest_entries e ON e.model_id = d.model_id AND e.manifest_id = d.manifest_id
       WHERE d.model_id = ${model.id}::uuid AND d.contractor_id = ${contractor.id}::uuid
         AND d.state = 'sent'`)
    const handed = new Set(given.map((row) => row.asset_id))
    chosen = chosen.filter((row) => !handed.has(row.asset_id))
  }
  if (chosen.length === 0) {
    throw new ApiProblem(
      'invalid_request',
      rows.length === 0
        ? 'Не выполнено: в подборке пока ничего'
        : 'Не выполнено: всё уже передавали этому подрядчику',
    )
  }
  const unavailable = chosen.find((row) => row.blob_state !== 'present')
  if (unavailable) {
    const key = materialKey(unavailable)
    throw new ApiProblem('unavailable', `${key.item_id}/${key.file_key}: байты файла недоступны`)
  }

  // The composition is sealed now: later versions and edits of the collection do not touch it.
  const prmId = publicIdOf(item.type, item.number)
  const manifestId = randomUUID()
  await tx.execute(sql`
    INSERT INTO asset_manifests (model_id, id, purpose, origin_item_id, entry_count, created_by)
    VALUES (${model.id}::uuid, ${manifestId}::uuid, 'delivery', ${item.id}::uuid,
            ${chosen.length}, ${actor.id}::uuid)`)
  for (const [index, row] of chosen.entries()) {
    const key = materialKey(row)
    await tx.execute(sql`
      INSERT INTO asset_manifest_entries (model_id, manifest_id, position, item_id, membership_id,
                                          asset_id, asset_version_id, handle_snapshot)
      VALUES (${model.id}::uuid, ${manifestId}::uuid, ${index + 1}, ${item.id}::uuid,
              ${row.membership_id}::uuid, ${row.asset_id}::uuid, ${row.version_id}::uuid,
              ${`${key.item_id}/${key.file_key}`})`)
  }

  const { rows: open } = await tx.execute<{ id: string }>(sql`
    SELECT d.id FROM promo_deliveries d
     WHERE d.model_id = ${model.id}::uuid AND d.package_item_id = ${item.id}::uuid
       AND d.contractor_id = ${contractor.id}::uuid AND d.state <> 'sent' AND d.origin = 'product'
       AND NOT EXISTS (SELECT 1 FROM promo_deliveries n WHERE n.corrects_id = d.id)
     ORDER BY d.created_at DESC LIMIT 1`)
  const files = await filesOf(tx, model, manifestId)
  const deliveryId = randomUUID()
  const plan = await planHandoff(tx, {
    modelId: model.id,
    modelCode: model.code,
    prm: { id: item.id, publicId: prmId },
    deliveryId,
    manifestId,
    format: contractor.format,
    strip: body.strip_metadata,
    principalId: actor.id,
    digests,
    zipName: `${prmId}_${slugOf(contractor.name) || 'handoff'}.zip`,
    files,
  })
  if (plan.files.some((file) => file.supply.kind === 'render') && digests.version === '') {
    throw new ApiProblem('unavailable', 'Медиаконвейер ещё не запускался: копии собирать некому')
  }
  const videos = chosen.filter((row) => row.media_kind === 'video').length
  const summary: HandoffSummary = {
    meta_stripped: body.strip_metadata,
    video_count: videos,
    photo_count: chosen.length - videos,
    estimated_bytes: plan.files.reduce(
      (sum, file) =>
        sum + (file.supply.kind === 'artifact' ? file.supply.bytes : Number(file.file.byte_size)),
      0,
    ),
  }
  await tx.execute(sql`
    INSERT INTO promo_deliveries (model_id, id, package_item_id, channel_id, contractor_id, format,
                                  manifest_id, state, prepared_at, prepared_by, summary, corrects_id)
    VALUES (${model.id}::uuid, ${deliveryId}::uuid, ${item.id}::uuid, ${item.promo_channel_id}::uuid,
            ${contractor.id}::uuid, ${contractor.format}, ${manifestId}::uuid, 'preparing', now(),
            ${actor.id}::uuid, ${JSON.stringify(summary)}::jsonb, ${open[0]?.id ?? null}::uuid)`)
  // The collection remembers whom it goes to.
  await tx.execute(sql`
    UPDATE content_items SET default_contractor_id = ${contractor.id}::uuid
     WHERE model_id = ${model.id}::uuid AND id = ${item.id}::uuid
       AND default_contractor_id IS DISTINCT FROM ${contractor.id}::uuid`)
  const { work } = await enqueueWork(tx, {
    modelId: model.id,
    kind: 'export',
    workKey: exportKeyOf(plan.receiptId),
    manifestId,
    checkpoint: { plan: storedPlan(plan) },
    priority: 500_000,
  })
  await logItemAction(tx, model, item, {
    action: 'promo.prepareHandoff',
    after: {
      Подрядчик: contractor.name,
      Состав: `${videos} видео, ${chosen.length - videos} фото`,
      Метаданные: body.strip_metadata ? 'стереть' : 'оставить',
    },
  })
  return { handoffId: deliveryId, workId: work.id }
}

/** The files of a sealed manifest at their versions, in its order, with their handles. */
async function filesOf(
  tx: Tx,
  model: ModelScope,
  manifestId: string,
): Promise<{ position: number; handle: string; file: FileRow }[]> {
  const { rows } = await tx.execute<FileRow & { position: number; handle: string }>(sql`
    SELECT e.position, e.handle_snapshot AS handle,
           m.id AS membership_id, m.kind, m.role, m.ordinal, m.variant_no, m.display_position,
           m.selected, m.life_use, a.media_kind, a.id AS asset_id, v.id AS version_id, v.version_no,
           v.master_sha256 AS master, b.ext, b.byte_size, v.duration_ms, v.width, v.height,
           b.state AS blob_state
      FROM asset_manifest_entries e
      JOIN item_memberships m ON m.model_id = e.model_id AND m.id = e.membership_id
      JOIN assets a ON a.model_id = e.model_id AND a.id = e.asset_id
      JOIN asset_versions v ON v.model_id = e.model_id AND v.id = e.asset_version_id
      JOIN blobs b ON b.sha256 = v.master_sha256
     WHERE e.model_id = ${model.id}::uuid AND e.manifest_id = ${manifestId}::uuid
     ORDER BY e.position`)
  return rows.map(({ position, handle, ...file }) => ({ position, handle, file: file as FileRow }))
}

/**
 * «Передано» (SPEC §5, §7.1): the date and the author on a prepared handoff; a repeat changes
 * nothing. The composition, the format and the issued names stay as they were sealed.
 */
export async function markSent(
  tx: Tx,
  model: ModelScope,
  collection: string,
  handoffId: string,
  actor: Actor,
): Promise<string> {
  const item = await findCollection(tx, model, collection, { lock: true })
  await setJournalItem(tx, item.id)
  const { rows } = await tx.execute<{
    id: string
    state: string
    replaced: boolean
    contractor: string
  }>(sql`
    SELECT d.id, d.state, c.name AS contractor,
           EXISTS (SELECT 1 FROM promo_deliveries n WHERE n.corrects_id = d.id) AS replaced
      FROM promo_deliveries d
      JOIN contractors c ON c.model_id = d.model_id AND c.id = d.contractor_id
     WHERE d.model_id = ${model.id}::uuid AND d.package_item_id = ${item.id}::uuid
       AND d.id = ${handoffId}::uuid
     FOR UPDATE OF d`)
  const row = rows[0]
  if (!row) throw new ApiProblem('not_found', 'Такой передачи нет', { handoff: handoffId })
  if (row.state === 'sent') return row.id
  if (row.replaced) {
    throw new ApiProblem('handoff_replaced', 'Эту передачу уже подготовили заново')
  }
  if (row.state !== 'prepared') {
    throw new ApiProblem('handoff_not_ready', 'Не выполнено: передача ещё готовится')
  }
  await tx.execute(sql`
    UPDATE promo_deliveries
       SET state = 'sent', sent_at = now(), sent_by = ${actor.id}::uuid, updated_at = now(),
           row_version = row_version + 1
     WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid AND state = 'prepared'`)
  await logItemAction(tx, model, item, { after: { Передано: row.contractor } })
  return row.id
}
