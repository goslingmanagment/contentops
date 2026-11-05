import { randomUUID } from 'node:crypto'
import type { CopyOfCommand } from '@contentops/contracts/commands/object-files'
import { setJournalItem, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { Actor, ModelScope, RequestContext } from '../context'
import { ApiProblem } from '../errors'
import { acceptGroup } from '../intake/accept'
import { webSource } from '../intake/upload'
import { handleOf, type MembershipRow, memberships } from './detail'
import { findItem, type ItemRow, publicIdOfRow } from './ids'
import { checkItemVersion, lockItem, lockItems, logItemAction, touchItem } from './writes'

/**
 * Decisions about a file accepted before, taken on its object (SPEC §6.1, §6.2; the repair of
 * the catalog of 05.11.2026 did them by SQL with the draft trigger off):
 *
 * - «Это копия <файл>» — a compressed preview or a second export of a file elsewhere in the
 *   catalog: it leaves its object, every name of it (path, ID at the source, old handles) finds
 *   the original, its accepted drafts become duplicate aliases of the original, collections that
 *   pointed at it point at the original. Its bytes and versions stay;
 * - «Не контент» — the file leaves its object, its accepted drafts are refused with the reason:
 *   «Вернуть в работу» in «Приехало» brings them back;
 * - «Новая версия мастера из файла» — the bytes of a file already in the catalog become the next
 *   version of a FYP's or a PPV's master: a draft over that version (origin `derived`), accepted
 *   as a new master version, as «Сделать мастером PPV» does. The master keeps its handle; the
 *   download name of the new version carries `_v2` (naming §5), so the name of the old one still
 *   means the old bytes for an exact match with Hub (SPEC §7).
 *
 * The master leaves its object only with everything else, as with «Перенести в…».
 */

const isMaster = (row: MembershipRow) =>
  row.kind === 'owned' && row.role === 'master' && row.variant_no === 0

const keyOf = (row: MembershipRow) => handleOf(row.role, row.ordinal, row.variant_no)

/** Live owned files of the object by their handles; an unknown one refuses the command. */
async function ownedByKeys(tx: Tx, model: ModelScope, item: ItemRow, keys: readonly string[]) {
  const all = (await memberships(tx, model, [item.id])).filter((row) => row.kind === 'owned')
  const byKey = new Map(all.map((row) => [keyOf(row), row]))
  const unknown = keys.filter((key) => byKey.get(key)?.variant_no !== 0)
  if (unknown.length > 0) {
    throw new ApiProblem('invalid_request', 'Таких файлов в объекте нет', { keys: unknown })
  }
  return { all, picked: [...new Set(keys)].map((key) => byKey.get(key) as MembershipRow) }
}

function requireMasterGoesLast(
  picked: readonly MembershipRow[],
  all: readonly MembershipRow[],
): void {
  if (picked.length < all.length && picked.some(isMaster)) {
    throw new ApiProblem(
      'invalid_request',
      'Мастер не уходит из объекта один — без него останутся тизер, части или кадры',
    )
  }
}

/** The file leaves its object; a cover it was stops being one. */
async function leave(tx: Tx, model: ModelScope, item: ItemRow, row: MembershipRow) {
  await tx.execute(sql`
    UPDATE item_memberships
       SET removed_at = now(), display_position = NULL, row_version = row_version + 1
     WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`)
  await tx.execute(sql`
    UPDATE content_items SET cover_membership_id = NULL
     WHERE model_id = ${model.id}::uuid AND id = ${item.id}::uuid
       AND cover_membership_id = ${row.id}::uuid`)
}

/** `LIFE-005/pic34` → the object's public ID and the handle. */
function splitAddress(address: string): { id: string; key: string } {
  const [id = '', key = ''] = address.split('/')
  return { id, key }
}

/** Promo collections that point at the file: their references move to the original. */
async function moveReferences(
  tx: Tx,
  model: ModelScope,
  from: string,
  to: { assetId: string; video: boolean },
  actor: Actor,
): Promise<number> {
  const { rows } = await tx.execute<{ id: string; item_id: string }>(sql`
    UPDATE item_memberships
       SET removed_at = now(), display_position = NULL, row_version = row_version + 1
     WHERE model_id = ${model.id}::uuid AND asset_id = ${from}::uuid AND kind = 'reference'
       AND removed_at IS NULL
    RETURNING id, item_id`)
  for (const row of rows) {
    const { rows: present } = await tx.execute<{ id: string; kind: string; live: boolean }>(sql`
      SELECT id, kind, removed_at IS NULL AS live FROM item_memberships
       WHERE model_id = ${model.id}::uuid AND item_id = ${row.item_id}::uuid
         AND asset_id = ${to.assetId}::uuid`)
    const { rows: tops } = await tx.execute<{ position: number; top: number }>(sql`
      SELECT coalesce(max(display_position), 0)::int AS position,
             coalesce(max(ordinal) FILTER (WHERE role = ${to.video ? 'clip' : 'pic'}), 0)::int AS top
        FROM item_memberships
       WHERE model_id = ${model.id}::uuid AND item_id = ${row.item_id}::uuid`)
    const top = tops[0] ?? { position: 0, top: 0 }
    const there = present[0]
    if (there?.live || (there && there.kind !== 'reference')) continue
    if (there) {
      await tx.execute(sql`
        UPDATE item_memberships
           SET removed_at = NULL, display_position = ${top.position + 1}, added_at = now(),
               added_by = ${actor.id}::uuid, row_version = row_version + 1
         WHERE model_id = ${model.id}::uuid AND id = ${there.id}::uuid`)
      continue
    }
    await tx.execute(sql`
      INSERT INTO item_memberships (model_id, item_id, item_type, asset_id, variant_no, kind, role,
                                    ordinal, display_position, added_by)
      VALUES (${model.id}::uuid, ${row.item_id}::uuid, 'PRM', ${to.assetId}::uuid, 0, 'reference',
              ${to.video ? 'clip' : 'pic'}, ${top.top + 1}, ${top.position + 1}, ${actor.id}::uuid)`)
  }
  return rows.length
}

/**
 * «Это копия <файл>»: every named file of this object is a copy of a live file of the model
 * (the same object too). One command for several pairs; a file named as an original may not be a
 * copy in the same command.
 */
export async function markCopies(
  tx: Tx,
  model: ModelScope,
  id: string,
  body: CopyOfCommand,
  ctx: RequestContext,
  actor: Actor,
): Promise<void> {
  const originals = body.files.map((file) => splitAddress(file.original))
  const locked = await lockItems(tx, model, [...new Set([id, ...originals.map((one) => one.id)])])
  const item = locked.get(id)
  if (!item) throw new Error('locked items vanished')
  await setJournalItem(tx, item.id)
  await checkItemVersion(tx, ctx, item)
  const { all, picked } = await ownedByKeys(
    tx,
    model,
    item,
    body.files.map((file) => file.key),
  )
  requireMasterGoesLast(picked, all)
  const ownerRows = new Map<string, MembershipRow[]>()
  for (const other of locked.values()) {
    ownerRows.set(
      other.id,
      (await memberships(tx, model, [other.id])).filter((row) => row.kind === 'owned'),
    )
  }
  const copies = new Set(body.files.map((file) => `${id}/${file.key}`))
  const pairs = body.files.map((file, index) => {
    const copy = picked.find((row) => keyOf(row) === file.key) as MembershipRow
    const at = originals[index] as { id: string; key: string }
    const owner = locked.get(at.id) as ItemRow
    const original = ownerRows.get(owner.id)?.find((row) => keyOf(row) === at.key)
    if (original?.variant_no !== 0) {
      throw new ApiProblem('invalid_request', `${file.original}: такого файла нет`, {
        original: file.original,
      })
    }
    if (copies.has(file.original)) {
      throw new ApiProblem('invalid_request', `${file.original} сам отмечен копией`, {
        original: file.original,
      })
    }
    if (original.asset_id === copy.asset_id) {
      throw new ApiProblem('invalid_request', 'Файл не копия самого себя', { key: file.key })
    }
    if (original.media_kind !== copy.media_kind) {
      throw new ApiProblem(
        'invalid_request',
        `${id}/${file.key} и ${file.original} — фото и видео: копией быть не может`,
        { key: file.key },
      )
    }
    return { copy, original, owner, address: file.original }
  })

  let references = 0
  for (const { copy, original, owner } of pairs) {
    await leave(tx, model, item, copy)
    // Every name of the copy finds the original; its handle here becomes one more.
    await tx.execute(sql`
      UPDATE aliases a SET asset_id = ${original.asset_id}::uuid
       WHERE a.model_id = ${model.id}::uuid AND a.asset_id = ${copy.asset_id}::uuid
         AND NOT EXISTS (SELECT 1 FROM aliases b
                          WHERE b.model_id = a.model_id AND b.kind = a.kind
                            AND b.value_norm = a.value_norm
                            AND b.asset_id = ${original.asset_id}::uuid)`)
    await tx.execute(sql`
      INSERT INTO aliases (model_id, kind, value_raw, asset_id, created_by)
      VALUES (${model.id}::uuid, 'sub_handle', ${`${publicIdOfRow(item)}/${keyOf(copy)}`},
              ${original.asset_id}::uuid, ${actor.id}::uuid)
      ON CONFLICT ON CONSTRAINT aliases_value DO NOTHING`)
    // Drafts that were duplicates of the copy follow it; its accepted ones become duplicates.
    await tx.execute(sql`
      UPDATE inbox_drafts
         SET duplicate_of_version_id = ${original.version_id}::uuid,
             applied_item_id = ${owner.id}::uuid, applied_version_id = ${original.version_id}::uuid,
             updated_at = now(), row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND outcome = 'alias'
         AND duplicate_of_version_id IN (SELECT v.id FROM asset_versions v
                                          WHERE v.model_id = ${model.id}::uuid
                                            AND v.asset_id = ${copy.asset_id}::uuid)`)
    await tx.execute(sql`
      UPDATE inbox_drafts
         SET outcome = 'alias', duplicate_of_version_id = ${original.version_id}::uuid,
             applied_item_id = ${owner.id}::uuid, applied_version_id = ${original.version_id}::uuid,
             decided_at = now(), decided_by = ${actor.id}::uuid, blocked_reason = NULL,
             updated_at = now(), row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND outcome IN ('new_item', 'append')
         AND applied_version_id IN (SELECT v.id FROM asset_versions v
                                     WHERE v.model_id = ${model.id}::uuid
                                       AND v.asset_id = ${copy.asset_id}::uuid)`)
    references += await moveReferences(
      tx,
      model,
      copy.asset_id,
      { assetId: original.asset_id, video: original.media_kind === 'video' },
      actor,
    )
  }

  const words = (pair: (typeof pairs)[number]) => `${keyOf(pair.copy)} → ${pair.address}`
  await touchItem(tx, model, item)
  await logItemAction(tx, model, item, {
    subject: publicIdOfRow(item),
    after: {
      Копии: pairs.map(words).join(', '),
      ...(references > 0 ? { 'Ссылок промо на оригинал': String(references) } : {}),
    },
  })
  for (const owner of locked.values()) {
    if (owner.id === item.id) continue
    const mine = pairs.filter((pair) => pair.owner.id === owner.id)
    if (mine.length === 0) continue
    await setJournalItem(tx, owner.id)
    await touchItem(tx, model, owner)
    await logItemAction(tx, model, owner, {
      subject: publicIdOfRow(owner),
      after: {
        'Копии его файлов': mine
          .map((pair) => `${publicIdOfRow(item)}/${keyOf(pair.copy)} → ${keyOf(pair.original)}`)
          .join(', '),
      },
    })
  }
}

/** «Не контент»: the files leave, their accepted drafts are refused with the reason. */
export async function markNotContent(
  tx: Tx,
  model: ModelScope,
  item: ItemRow,
  keys: readonly string[],
  reason: string,
  ctx: RequestContext,
  actor: Actor,
): Promise<void> {
  await checkItemVersion(tx, ctx, item)
  const { all, picked } = await ownedByKeys(tx, model, item, keys)
  requireMasterGoesLast(picked, all)
  const assets = picked.map((row) => row.asset_id)
  const { rows: decided } = await tx.execute<{ asset_id: string }>(sql`
    SELECT DISTINCT v.asset_id FROM inbox_drafts d
      JOIN asset_versions v ON v.model_id = d.model_id AND v.id = d.applied_version_id
     WHERE d.model_id = ${model.id}::uuid AND d.outcome IN ('new_item', 'append')
       AND v.asset_id = ANY(${sql.param(assets)}::uuid[])`)
  const withDraft = new Set(decided.map((row) => row.asset_id))
  const without = picked.filter((row) => !withDraft.has(row.asset_id)).map(keyOf)
  if (without.length > 0) {
    throw new ApiProblem(
      'invalid_request',
      `Не из приёмки: ${without.join(', ')} — уберите из объекта («Убрать из объекта…»)`,
      { keys: without },
    )
  }
  const { rows: promo } = await tx.execute<{ id: string }>(sql`
    SELECT DISTINCT public_item_id(i.type, i.number) AS id FROM item_memberships r
      JOIN content_items i ON i.model_id = r.model_id AND i.id = r.item_id AND i.deleted_at IS NULL
     WHERE r.model_id = ${model.id}::uuid AND r.kind = 'reference' AND r.removed_at IS NULL
       AND r.asset_id = ANY(${sql.param(assets)}::uuid[])`)
  if (promo.length > 0) {
    throw new ApiProblem(
      'item_in_use',
      `Файлы в промо-подборках ${promo.map((row) => row.id).join(', ')} — сначала уберите их оттуда`,
      { uses: promo.map((row) => row.id) },
    )
  }
  for (const row of picked) await leave(tx, model, item, row)
  await tx.execute(sql`
    UPDATE inbox_drafts d
       SET outcome = 'rejected', reject_reason = ${reason}, rejected_at = now(), decided_at = now(),
           decided_by = ${actor.id}::uuid, applied_item_id = NULL, applied_version_id = NULL,
           blocked_reason = NULL, updated_at = now(), row_version = row_version + 1
      FROM asset_versions v
     WHERE d.model_id = ${model.id}::uuid AND d.outcome IN ('new_item', 'append')
       AND v.model_id = d.model_id AND v.id = d.applied_version_id
       AND v.asset_id = ANY(${sql.param(assets)}::uuid[])`)
  await touchItem(tx, model, item)
  await logItemAction(tx, model, item, {
    subject: publicIdOfRow(item),
    before: { Файлы: picked.map(keyOf).join(', ') },
    after: { 'Не контент': reason },
  })
}

/**
 * The file an address names: the live one of the object, else the one that had the handle last
 * (a file that left: a copy of a merged FYP, a file moved away).
 */
async function fileAt(tx: Tx, model: ModelScope, address: string) {
  const { id, key } = splitAddress(address)
  const item = await findItem(tx, model, id, { withTombstones: true })
  const { rows } = await tx.execute<{
    asset_id: string
    version_id: string
    media_kind: 'video' | 'image'
    sha: Buffer
    source_sha: Buffer
    byte_size: string
  }>(sql`
    SELECT m.asset_id, a.current_version_id AS version_id, a.media_kind,
           v.master_sha256 AS sha, coalesce(v.source_sha256, v.master_sha256) AS source_sha,
           b.byte_size
      FROM item_memberships m
      JOIN assets a ON a.model_id = m.model_id AND a.id = m.asset_id
      JOIN asset_versions v ON v.model_id = a.model_id AND v.id = a.current_version_id
      JOIN blobs b ON b.sha256 = v.master_sha256
     WHERE m.model_id = ${model.id}::uuid AND m.item_id = ${item.id}::uuid AND m.kind = 'owned'
       AND CASE WHEN m.variant_no > 0 THEN 'u' || m.variant_no
                WHEN m.ordinal IS NULL THEN m.role
                ELSE m.role || lpad(m.ordinal::text, 2, '0') END = ${key}
     ORDER BY m.removed_at IS NULL DESC, m.added_at DESC
     LIMIT 1`)
  const file = rows[0]
  if (!file) throw new ApiProblem('not_found', `${address}: такого файла нет`, { from: address })
  return file
}

/** «Новая версия мастера из файла» of a FYP or a PPV. */
export async function masterVersionFrom(
  tx: Tx,
  model: ModelScope,
  id: string,
  from: string,
  ctx: RequestContext,
  actor: Actor,
): Promise<void> {
  const item = await lockItem(tx, model, id)
  await checkItemVersion(tx, ctx, item)
  if (item.type !== 'FYP' && item.type !== 'PPV') {
    throw new ApiProblem(
      'invalid_request',
      'Новая версия мастера из файла — у фупа и PPV; кастом правится сдачей',
    )
  }
  const master = (await memberships(tx, model, [item.id])).find(isMaster)
  if (!master) throw new ApiProblem('invalid_request', `У ${publicIdOfRow(item)} нет мастера`)
  const file = await fileAt(tx, model, from)
  if (file.media_kind !== 'video') throw new ApiProblem('invalid_request', 'Мастер — видео')
  if (file.asset_id === master.asset_id) {
    throw new ApiProblem('invalid_request', `${from} — и есть мастер ${publicIdOfRow(item)}`)
  }
  if (file.sha.toString('hex') === master.master_hex) {
    throw new ApiProblem('invalid_request', `У мастера ${publicIdOfRow(item)} уже эти байты`)
  }
  const sourceId = await webSource(tx, model.id)
  const { rows: groups } = await tx.execute<{ id: string }>(sql`
    INSERT INTO inbox_groups (model_id, source_id, group_key, grouping, evidence, proposed_type)
    VALUES (${model.id}::uuid, ${sourceId}::uuid,
            ${`derived:${publicIdOfRow(item)}:${randomUUID()}`}, 'manual',
            ${JSON.stringify({ root: from, path: from, files: 1 })}::jsonb, ${item.type})
    RETURNING id`)
  const groupId = (groups[0] as { id: string }).id
  await tx.execute(sql`
    INSERT INTO inbox_drafts (
      model_id, group_id, from_version_id, origin, state, byte_size, path, source_sha256,
      source_blob_sha256, master_sha256, master_is_source, master_verified_at, ready_at,
      proposed_role
    ) VALUES (
      ${model.id}::uuid, ${groupId}::uuid, ${file.version_id}::uuid, 'derived', 'ready',
      ${Number(file.byte_size)}, ${from}, ${file.source_sha}, ${file.sha}, ${file.sha},
      ${file.source_sha.equals(file.sha)}, now(),
      now(),
      'master'
    )`)
  await acceptGroup(tx, model, actor, groupId, {
    as: 'default',
    extend: { item_id: publicIdOfRow(item), role: 'master_version' },
  })
  const { rows: versions } = await tx.execute<{ version_no: number }>(sql`
    SELECT v.version_no FROM assets a
      JOIN asset_versions v ON v.model_id = a.model_id AND v.id = a.current_version_id
     WHERE a.model_id = ${model.id}::uuid AND a.id = ${master.asset_id}::uuid`)
  await setJournalItem(tx, item.id)
  await logItemAction(tx, model, item, {
    subject: publicIdOfRow(item),
    before: { Мастер: `v${master.version_no}` },
    after: { Мастер: `v${versions[0]?.version_no ?? '?'} из ${from}` },
  })
}
