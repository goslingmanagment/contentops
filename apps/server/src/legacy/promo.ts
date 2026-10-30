import { randomUUID } from 'node:crypto'
import { logAction, type Queryable, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { issueNumber } from '../catalog/numbers'
import type { ModelScope } from '../context'

/**
 * SMM of the old disk in «Промо» (SPEC §6.3): a channel's folder becomes a collection `PRM` of
 * its channel with the folder's files; a file whose bytes the catalog already has is a link to
 * that file, not a copy. A folder a person marked «пак подрядчику» (with the contractor) is a
 * past handoff with the origin «импорт»: `sent` without a date or an author — the folder's date
 * stays a claim — so «уже передавали» counts it.
 */

const CHANNEL_WORDS: Record<string, string> = {
  yt: 'youtube',
  youtube: 'youtube',
  tw: 'twitter',
  twitter: 'twitter',
  x: 'twitter',
  insta: 'instagram',
  instagram: 'instagram',
  inst: 'instagram',
  reddit: 'reddit',
  gif: 'gif-sites',
  'гиф-сайты': 'gif-sites',
  sfs: 'sfs',
}

/** The channel of an SMM folder by its name: the code, the title or a usual short name. */
export async function channelOf(q: Queryable, modelId: string, name: string | null | undefined) {
  if (!name) return null
  const word = name.trim().toLowerCase()
  const code = CHANNEL_WORDS[word] ?? word
  const { rows } = await q.execute<{ id: string }>(sql`
    SELECT id FROM promo_channels
     WHERE model_id = ${modelId}::uuid AND archived_at IS NULL
       AND (lower(code) = ${code} OR lower(title) = ${word})
     ORDER BY lower(code) = ${code} DESC LIMIT 1`)
  return rows[0]?.id ?? null
}

/**
 * The files of the group that were exact duplicates of the catalog become links of the
 * collection; a group of only duplicates gets its collection here (acceptance had no files).
 */
export async function linkDuplicates(
  tx: Tx,
  model: ModelScope,
  groupId: string,
  channelId: string,
  itemId: string | null,
  title: string | null,
): Promise<string | null> {
  const { rows: dups } = await tx.execute<{ asset_id: string; media: string; variant: number }>(sql`
    SELECT DISTINCT v.asset_id, a.media_kind AS media, a.variant_no AS variant
      FROM inbox_drafts d
      JOIN asset_versions v ON v.model_id = d.model_id AND v.id = d.duplicate_of_version_id
      JOIN assets a ON a.model_id = v.model_id AND a.id = v.asset_id
     WHERE d.model_id = ${model.id}::uuid AND d.group_id = ${groupId}::uuid AND d.outcome = 'alias'`)
  if (dups.length === 0) return itemId
  let id = itemId
  if (!id) {
    const number = await issueNumber(tx, model.id, 'PRM')
    id = randomUUID()
    await tx.execute(sql`
      INSERT INTO content_items (model_id, id, type, number, title, origin, promo_channel_id,
                                 created_from_group_id)
      VALUES (${model.id}::uuid, ${id}::uuid, 'PRM', ${number}, ${title}, 'import',
              ${channelId}::uuid, ${groupId}::uuid)`)
  }
  const { rows: tops } = await tx.execute<{ position: number; clip: number; pic: number }>(sql`
    SELECT coalesce(max(display_position), 0)::int AS position,
           coalesce(max(ordinal) FILTER (WHERE role = 'clip'), 0)::int AS clip,
           coalesce(max(ordinal) FILTER (WHERE role = 'pic'), 0)::int AS pic
      FROM item_memberships WHERE model_id = ${model.id}::uuid AND item_id = ${id}::uuid`)
  const top = { position: 0, clip: 0, pic: 0, ...tops[0] }
  for (const dup of dups) {
    const role = dup.media === 'video' ? 'clip' : 'pic'
    top.position += 1
    top[role] += 1
    await tx.execute(sql`
      INSERT INTO item_memberships (model_id, item_id, item_type, asset_id, variant_no, kind, role,
                                    ordinal, display_position)
      SELECT ${model.id}::uuid, ${id}::uuid, 'PRM', ${dup.asset_id}::uuid, ${dup.variant},
             'reference', ${role}, ${top[role]}, ${top.position}
       WHERE NOT EXISTS (SELECT 1 FROM item_memberships
                          WHERE model_id = ${model.id}::uuid AND item_id = ${id}::uuid
                            AND asset_id = ${dup.asset_id}::uuid)`)
  }
  return id
}

/**
 * Past packs (SPEC §6.3): every SMM folder marked «пак подрядчику» whose collection exists gets
 * one handoff with the origin «импорт» — a sealed manifest of the collection's files. A repeat
 * finds the handoff by the case and writes nothing.
 */
export async function importPacks(tx: Tx, model: ModelScope): Promise<number> {
  const { rows } = await tx.execute<{
    case_id: string
    contractor_id: string
    item_id: string
    channel_id: string
    folder: string
    first_upload: string | null
    last_upload: string | null
  }>(sql`
    SELECT c.id AS case_id, (c.resolution ->> 'contractor_id')::uuid AS contractor_id,
           i.id AS item_id, i.promo_channel_id AS channel_id, c.details ->> 'path' AS folder,
           c.details ->> 'first_upload' AS first_upload, c.details ->> 'last_upload' AS last_upload
      FROM review_cases c
      JOIN inbox_groups g ON g.model_id = c.model_id AND g.folder_object_id = c.source_object_id
      JOIN content_items i ON i.model_id = g.model_id AND i.created_from_group_id = g.id
                          AND i.type = 'PRM' AND i.deleted_at IS NULL
     WHERE c.model_id = ${model.id}::uuid AND c.kind = 'smm_folder' AND c.state = 'resolved'
       AND c.resolution ->> 'option' = 'pack' AND c.resolution ? 'contractor_id'
       AND NOT EXISTS (SELECT 1 FROM promo_deliveries p
                        WHERE p.model_id = c.model_id AND p.origin = 'import'
                          AND p.summary ->> 'case_id' = c.id::text)`)
  let written = 0
  for (const pack of rows) {
    const { rows: files } = await tx.execute<{
      membership_id: string
      asset_id: string
      version_id: string
      handle: string
    }>(sql`
      SELECT m.id AS membership_id, m.asset_id, a.current_version_id AS version_id,
             m.role || lpad(coalesce(m.ordinal, 0)::text, 2, '0') AS handle
        FROM item_memberships m JOIN assets a ON a.model_id = m.model_id AND a.id = m.asset_id
       WHERE m.model_id = ${model.id}::uuid AND m.item_id = ${pack.item_id}::uuid
         AND m.removed_at IS NULL
       ORDER BY m.display_position`)
    if (files.length === 0) continue
    const manifestId = randomUUID()
    await tx.execute(sql`
      INSERT INTO asset_manifests (model_id, id, purpose, origin_item_id, entry_count)
      VALUES (${model.id}::uuid, ${manifestId}::uuid, 'delivery', ${pack.item_id}::uuid,
              ${files.length})`)
    for (const [index, file] of files.entries()) {
      await tx.execute(sql`
        INSERT INTO asset_manifest_entries (model_id, manifest_id, position, item_id,
                                            membership_id, asset_id, asset_version_id,
                                            handle_snapshot)
        VALUES (${model.id}::uuid, ${manifestId}::uuid, ${index + 1}, ${pack.item_id}::uuid,
                ${file.membership_id}::uuid, ${file.asset_id}::uuid, ${file.version_id}::uuid,
                ${file.handle})`)
    }
    const summary = {
      case_id: pack.case_id,
      folder: pack.folder,
      files: files.length,
      folder_date: pack.last_upload ?? pack.first_upload,
    }
    await tx.execute(sql`
      INSERT INTO promo_deliveries (model_id, package_item_id, channel_id, contractor_id,
                                    manifest_id, state, summary, origin)
      VALUES (${model.id}::uuid, ${pack.item_id}::uuid, ${pack.channel_id}::uuid,
              ${pack.contractor_id}::uuid, ${manifestId}::uuid, 'sent',
              ${JSON.stringify(summary)}::jsonb, 'import')`)
    await logAction(tx, {
      modelId: model.id,
      action: 'legacy.pack',
      subjectKind: 'promo_deliveries',
      itemId: pack.item_id,
      subjectLabel: pack.folder,
      after: { Файлов: String(files.length), Источник: 'импорт' },
    })
    written += 1
  }
  return written
}
