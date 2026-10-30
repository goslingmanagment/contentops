import type { AcceptCommand } from '@contentops/contracts/commands/inbox'
import type { AcceptResult } from '@contentops/contracts/domain/inbox'
import { orderTitleOf } from '@contentops/contracts/order-card'
import { setJournalItem, type Tx, values } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { findItem, type ItemRow, publicIdOf } from '../catalog/ids'
import { tagIds } from '../catalog/markup-writes'
import { issueNumber } from '../catalog/numbers'
import { logItemAction, touchItem } from '../catalog/writes'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import { materializeClaims } from '../legacy/materialize'
import { handleOf } from '../media/downloads'
import { lockBlobForReference } from '../media/storage-ops'
import { markDeliveredParts } from '../orders/writes'
import { aliasOpenDuplicates, resolveAlias } from './fetch'

/**
 * «Принять» (SPEC §4.1, §6.1, schema §5 «Принятие группы», §9.3): one transaction after the
 * idempotency key — locks in a fixed order (group → drafts → target object → counter → blobs by
 * ascending SHA-256), every file of the group ready (a partial group is refused, never thinned),
 * a number only for a new object and only after the legacy reservation of its type, then the
 * object, files, versions, memberships, aliases and tags, the order delivery when an order is
 * chosen, the drafts resolved and one `action` row. A failure before commit spends no number.
 */

type DbType = values.ContentType
type Role = values.AssetRole

export interface AcceptOptions extends AcceptCommand {
  /** «принято при загрузке»: a web upload with a target accepted by itself. */
  how?: AcceptResult['how']
  /** The role a web upload names itself: processed frames of a set are its `ed` files. */
  role?: Role
}

/**
 * Exact duplicates inside one group (SPEC §6.2): one file per bytes, the other drafts become
 * aliases of it and need no master of their own (schema §5 «подтверждены дублями»). A twin
 * that is ready keeps the file; the order of the files stays the drafts' order.
 */
function splitTwins(drafts: readonly DraftRow[]): {
  files: DraftRow[]
  twins: { draft: DraftRow; of: DraftRow }[]
} {
  const bytesOf = (draft: DraftRow) => draft.source_hex ?? draft.master_hex
  const keeper = new Map<string, DraftRow>()
  for (const draft of drafts) {
    const bytes = bytesOf(draft)
    if (!bytes) continue
    const kept = keeper.get(bytes)
    if (!kept || (!kept.master_verified && draft.master_verified)) keeper.set(bytes, draft)
  }
  const files: DraftRow[] = []
  const twins: { draft: DraftRow; of: DraftRow }[] = []
  for (const draft of drafts) {
    const bytes = bytesOf(draft)
    const kept = bytes ? keeper.get(bytes) : undefined
    if (kept && kept !== draft) twins.push({ draft, of: kept })
    else files.push(draft)
  }
  return { files, twins }
}

/**
 * «Принять как есть» (SPEC §9.2, schema §9.2 «Принятие»): a broken source — decode errors or
 * truncated — that opens and gave a preview is its own master by the KM's decision, which sets
 * `master_verified_at`. An unreadable source kept no bytes as a master and keeps waiting for a
 * replacement. Returns the drafts taken as they are.
 */
async function takeBrokenAsIs(tx: Tx, model: ModelScope, drafts: DraftRow[]): Promise<number> {
  const failed = drafts.filter((draft) => draft.blocked_reason === 'master_failed')
  if (failed.length === 0) {
    throw blocked('not_broken', 'Принимать как есть нечего: исходник не битый')
  }
  const { rows } = await tx.execute<{ id: string }>(sql`
    UPDATE inbox_drafts d
       SET master_verified_at = now(), master_is_source = true, blocked_reason = NULL, error = NULL,
           updated_at = now(), row_version = row_version + 1
     WHERE d.model_id = ${model.id}::uuid
       AND d.id = ANY (${sql.param(failed.map((draft) => draft.id))}::uuid[])
       AND d.master_sha256 IS NOT NULL AND d.master_sha256 = d.source_sha256
       AND EXISTS (SELECT 1 FROM master_checks c
                    WHERE c.source_sha256 = d.source_sha256
                      AND c.report ->> 'acceptance' = 'accept_as_is_only')
       AND EXISTS (SELECT 1 FROM rendition_generations g
                    WHERE g.input_sha256 = d.source_sha256 AND g.state = 'ready'
                      AND g.kind IN ('preview', 'thumb640'))
    RETURNING d.id`)
  const taken = new Set(rows.map((row) => row.id))
  for (const draft of drafts) {
    if (!taken.has(draft.id)) continue
    draft.blocked_reason = null
    draft.master_verified = true
  }
  return taken.size
}

interface GroupRow extends Record<string, unknown> {
  id: string
  source_id: string
  proposed_type: DbType | null
  proposed_title: string | null
  proposed_title_en: string | null
  proposed_description: string | null
  proposed_tags: string[] | null
  proposed_ppv_kind: values.PpvKind | null
  proposed_purpose: values.RawPurpose | null
  has_second_person: boolean | null
  custom_order_id: string | null
  created_item_id: string | null
}

interface DraftRow extends Record<string, unknown> {
  id: string
  path: string | null
  byte_size: string | null
  origin: values.DraftOrigin
  master_hex: string | null
  source_hex: string | null
  master_verified: boolean
  blocked_reason: values.DraftBlockedReason | null
  proposed_role: Role | null
  proposed_ordinal: number | null
  target_item_id: string | null
  target_asset_id: string | null
  source_revision_id: string | null
  source_object_id: string | null
  resource_id: string | null
  web_upload_id: string | null
  client_filename: string | null
  media_kind: values.MediaKind | null
  arrived_at: string | null
}

function blocked(reason: string, message: string, details: Record<string, unknown> = {}) {
  return new ApiProblem('accept_blocked', message, { reason, ...details })
}

export async function lockGroupForDecision(
  tx: Tx,
  model: ModelScope,
  groupId: string,
): Promise<GroupRow> {
  const { rows } = await tx.execute<GroupRow>(sql`
    SELECT g.id, g.source_id, g.proposed_type, g.proposed_title, g.proposed_title_en,
           g.proposed_description, g.proposed_tags, g.proposed_ppv_kind, g.proposed_purpose,
           g.has_second_person, g.custom_order_id,
           (SELECT i.id FROM content_items i
             WHERE i.model_id = g.model_id AND i.created_from_group_id = g.id) AS created_item_id
      FROM inbox_groups g
     WHERE g.model_id = ${model.id}::uuid AND g.id = ${groupId}::uuid
     FOR UPDATE OF g`)
  const [group] = rows
  if (!group) throw new ApiProblem('not_found', 'Такой группы нет')
  return group
}

/** Unresolved drafts of the group under their row locks, in id order. */
export async function lockOpenDrafts(
  tx: Tx,
  model: ModelScope,
  groupId: string,
): Promise<DraftRow[]> {
  const { rows } = await tx.execute<DraftRow>(sql`
    SELECT d.id, d.path, d.byte_size, d.origin, encode(d.master_sha256, 'hex') AS master_hex,
           encode(d.source_sha256, 'hex') AS source_hex, d.master_verified_at IS NOT NULL AS master_verified,
           d.blocked_reason, d.proposed_role, d.proposed_ordinal, d.target_item_id,
           d.target_asset_id, d.source_revision_id, r.source_object_id, o.resource_id,
           d.web_upload_id, u.client_filename, b.media_kind,
           coalesce(r.remote_created_at, u.completed_at, d.discovered_at) AS arrived_at
      FROM inbox_drafts d
      LEFT JOIN source_revisions r ON r.model_id = d.model_id AND r.id = d.source_revision_id
      LEFT JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
      LEFT JOIN web_uploads u ON u.model_id = d.model_id AND u.id = d.web_upload_id
      LEFT JOIN blobs b ON b.sha256 = d.master_sha256
     WHERE d.model_id = ${model.id}::uuid AND d.group_id = ${groupId}::uuid AND d.state <> 'resolved'
     ORDER BY d.id
     FOR UPDATE OF d`)
  return rows
}

/** Roles of the files of a new object by its type (naming §3, `values.rolesByType`). */
function rolesFor(type: DbType, drafts: readonly DraftRow[]): Map<string, Role> {
  const videos = drafts.filter((draft) => draft.media_kind === 'video')
  const photos = drafts.filter((draft) => draft.media_kind !== 'video')
  const roles = new Map<string, Role>()
  const bySize = [...videos].sort((a, b) => Number(b.byte_size ?? 0) - Number(a.byte_size ?? 0))
  switch (type) {
    case 'PPV':
      if (videos.length > 2) throw blocked('video_in_set', 'Видео больше двух — разделите группу')
      for (const [index, draft] of bySize.entries()) {
        roles.set(draft.id, index === 0 ? 'master' : 'teaser')
      }
      for (const draft of photos) roles.set(draft.id, 'pic')
      break
    case 'CUS':
      if (videos.length > 1)
        throw blocked('video_in_set', 'В кастоме одно видео — разделите группу')
      for (const draft of videos) roles.set(draft.id, 'master')
      for (const draft of photos) roles.set(draft.id, 'pic')
      break
    case 'FYP':
      if (videos.length !== 1 || photos.length > 0) {
        throw blocked('video_in_set', 'Фуп — один ролик: разделите группу')
      }
      roles.set(videos[0]?.id as string, 'master')
      break
    case 'SET':
      if (videos.length > 0) throw blocked('video_in_set', 'Видео среди фото — решите, куда его')
      for (const draft of photos) roles.set(draft.id, 'raw')
      break
    case 'SXT':
    case 'LIFE':
      for (const draft of videos) roles.set(draft.id, 'clip')
      for (const draft of photos) roles.set(draft.id, 'pic')
      break
    case 'RAW':
      for (const draft of drafts) roles.set(draft.id, 'raw')
      break
    case 'PRM':
      throw blocked('promo', 'Подборки Промо собираются в разделе «Промо»')
  }
  return roles
}

/** Role of a file added to an existing object by «Дополнить…». */
function appendRole(type: DbType, draft: DraftRow, extend: AcceptCommand['extend']): Role {
  if (extend?.role === 'teaser') return 'teaser'
  if (extend?.role === 'master_version') return 'master'
  const video = draft.media_kind === 'video'
  switch (type) {
    case 'SET':
      if (video) throw blocked('video_in_set', 'Видео в сет не добавляется')
      return 'raw'
    case 'RAW':
      return 'raw'
    case 'SXT':
    case 'LIFE':
      return video ? 'clip' : 'pic'
    case 'PPV':
    case 'CUS':
      return video ? 'master' : 'pic'
    case 'FYP':
      if (!video) throw blocked('video_in_set', 'В фуп добавляется только ролик')
      return 'master'
    case 'PRM':
      throw blocked('promo', 'Подборки Промо пополняются в разделе «Промо»')
  }
}

const { rolesByType } = values
const ORDINAL_ROLES = new Set<Role>(['pic', 'raw', 'ed', 'clip'])

function rolesFits(type: DbType, role: Role): boolean {
  return (rolesByType[type] as readonly Role[]).includes(role)
}

/** The owned membership `role<ordinal>` of an object: live asset, or the handle is taken. */
async function ownedAsset(tx: Tx, modelId: string, itemId: string, role: Role, ordinal: number) {
  const { rows } = await tx.execute<{ asset_id: string; removed: boolean }>(sql`
    SELECT asset_id, removed_at IS NOT NULL AS removed FROM item_memberships
     WHERE model_id = ${modelId}::uuid AND item_id = ${itemId}::uuid AND kind = 'owned'
       AND role = ${role} AND ordinal = ${ordinal} AND variant_no = 0`)
  const row = rows[0]
  if (!row) return null
  return { live: row.removed ? null : row.asset_id, taken: true }
}

/** «Обработанный кадр ← исходный» (provenance `processed_from`): `ed07` from `raw07`. */
async function processedFrom(
  tx: Tx,
  modelId: string,
  itemId: string,
  ordinal: number,
  childVersionId: string,
  actor: Actor,
) {
  await tx.execute(sql`
    INSERT INTO provenance (model_id, relation, child_version_id, parent_version_id, basis, created_by)
    SELECT m.model_id, 'processed_from', ${childVersionId}::uuid, a.current_version_id,
           'processed_frame', ${actor.id}::uuid
      FROM item_memberships m
      JOIN assets a ON a.model_id = m.model_id AND a.id = m.asset_id
     WHERE m.model_id = ${modelId}::uuid AND m.item_id = ${itemId}::uuid AND m.kind = 'owned'
       AND m.role = 'raw' AND m.ordinal = ${ordinal} AND m.removed_at IS NULL
    ON CONFLICT DO NOTHING`)
}

interface ItemRef {
  id: string
  type: DbType
  number: number
}

async function nextOrdinals(tx: Tx, modelId: string, itemId: string): Promise<Map<Role, number>> {
  const { rows } = await tx.execute<{ role: Role; max: number | null }>(sql`
    SELECT role, max(ordinal) AS max FROM item_memberships
     WHERE model_id = ${modelId}::uuid AND item_id = ${itemId}::uuid AND kind = 'owned'
     GROUP BY role`)
  return new Map(rows.map((row) => [row.role, row.max ?? 0]))
}

async function nextPosition(tx: Tx, modelId: string, itemId: string): Promise<number> {
  const { rows } = await tx.execute<{ max: number | null }>(sql`
    SELECT max(display_position) AS max FROM item_memberships
     WHERE model_id = ${modelId}::uuid AND item_id = ${itemId}::uuid`)
  return (rows[0]?.max ?? 0) + 1
}

/** The owned live membership of a role without an ordinal (`master`, `teaser`) of an object. */
async function singleRoleAsset(tx: Tx, modelId: string, itemId: string, role: Role) {
  const { rows } = await tx.execute<{ asset_id: string }>(sql`
    SELECT asset_id FROM item_memberships
     WHERE model_id = ${modelId}::uuid AND item_id = ${itemId}::uuid AND kind = 'owned'
       AND role = ${role} AND variant_no = 0 AND removed_at IS NULL`)
  return rows[0]?.asset_id ?? null
}

interface CreatedFile {
  draftId: string
  versionId: string
  assetId: string
  membershipId: string | null
  handle: string
  media: values.MediaKind
}

async function probeOf(tx: Tx, master: Buffer) {
  const { rows } = await tx.execute<{
    duration_ms: string | null
    width: number | null
    height: number | null
  }>(sql`
    SELECT duration_ms, width, height FROM blob_probes WHERE sha256 = ${master}
     ORDER BY kind, computed_at DESC LIMIT 1`)
  return rows[0] ?? { duration_ms: null, width: null, height: null }
}

/** A new version of `assetId` (or a new asset with its first version) from a draft's master. */
async function writeVersion(
  tx: Tx,
  modelId: string,
  draft: DraftRow,
  actor: Actor,
  target: { assetId: string } | { itemId: string; media: values.MediaKind },
): Promise<{ assetId: string; versionId: string }> {
  const master = Buffer.from(draft.master_hex as string, 'hex')
  const source = draft.source_hex ? Buffer.from(draft.source_hex, 'hex') : null
  const probe = await probeOf(tx, master)
  const { rows: ids } = await tx.execute<{ asset: string; version: string }>(
    sql`SELECT uuidv7() AS asset, uuidv7() AS version`,
  )
  const fresh = ids[0] as { asset: string; version: string }
  let assetId: string
  let versionNo = 1
  if ('assetId' in target) {
    assetId = target.assetId
    const { rows } = await tx.execute<{ next: number }>(sql`
      SELECT coalesce(max(version_no), 0) + 1 AS next FROM asset_versions
       WHERE model_id = ${modelId}::uuid AND asset_id = ${assetId}::uuid`)
    versionNo = rows[0]?.next ?? 1
  } else {
    assetId = fresh.asset
    await tx.execute(sql`
      INSERT INTO assets (model_id, id, created_in_item_id, media_kind, current_version_id, created_by)
      VALUES (${modelId}::uuid, ${assetId}::uuid, ${target.itemId}::uuid, ${target.media},
              ${fresh.version}::uuid, ${actor.id}::uuid)`)
  }
  await tx.execute(sql`
    INSERT INTO asset_versions (
      model_id, id, asset_id, version_no, master_sha256, source_sha256, source_revision_id,
      duration_ms, width, height, created_by
    ) VALUES (
      ${modelId}::uuid, ${fresh.version}::uuid, ${assetId}::uuid, ${versionNo}, ${master},
      ${source}, ${draft.source_revision_id}::uuid, ${probe.duration_ms}, ${probe.width},
      ${probe.height}, ${actor.id}::uuid
    )`)
  if ('assetId' in target) {
    await tx.execute(sql`
      UPDATE assets SET current_version_id = ${fresh.version}::uuid
       WHERE model_id = ${modelId}::uuid AND id = ${assetId}::uuid`)
  }
  return { assetId, versionId: fresh.version }
}

/** Old paths, the id at the source and the uploaded name stay findable (naming §9). */
async function writeAliases(
  tx: Tx,
  modelId: string,
  draft: DraftRow,
  assetId: string,
  actor: Actor,
) {
  if (draft.source_object_id) {
    await tx.execute(sql`
      INSERT INTO aliases (model_id, kind, value_raw, asset_id, source_object_id, created_by)
      SELECT model_id, 'legacy_path', path_raw, ${assetId}::uuid, source_object_id, ${actor.id}::uuid
        FROM source_paths
       WHERE model_id = ${modelId}::uuid AND source_object_id = ${draft.source_object_id}::uuid
      ON CONFLICT DO NOTHING`)
  }
  if (draft.resource_id) {
    await tx.execute(sql`
      INSERT INTO aliases (model_id, kind, value_raw, asset_id, source_object_id, created_by)
      VALUES (${modelId}::uuid, 'resource_id', ${draft.resource_id}, ${assetId}::uuid,
              ${draft.source_object_id}::uuid, ${actor.id}::uuid)
      ON CONFLICT DO NOTHING`)
  }
  if (draft.client_filename) {
    await tx.execute(sql`
      INSERT INTO aliases (model_id, kind, value_raw, asset_id, created_by)
      VALUES (${modelId}::uuid, 'legacy_name', ${draft.client_filename}, ${assetId}::uuid, ${actor.id}::uuid)
      ON CONFLICT DO NOTHING`)
  }
}

async function addMembership(
  tx: Tx,
  modelId: string,
  item: ItemRef,
  assetId: string,
  role: Role,
  ordinal: number | null,
  position: number,
  actor: Actor,
): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO item_memberships (
      model_id, item_id, item_type, asset_id, kind, role, ordinal, display_position, added_by
    ) VALUES (
      ${modelId}::uuid, ${item.id}::uuid, ${item.type}, ${assetId}::uuid, 'owned', ${role},
      ${ordinal}, ${position}, ${actor.id}::uuid
    )
    RETURNING id`)
  return (rows[0] as { id: string }).id
}

function nextStep(type: DbType): string | null {
  switch (type) {
    case 'SET':
      return 'Отобрать кадры'
    case 'RAW':
      return null
    default:
      return 'В план'
  }
}

/** The title of an order, as the orders API words it (from its brief). */
async function orderTitle(tx: Tx, modelId: string, orderId: string): Promise<string | null> {
  const { rows } = await tx.execute<{ brief: string }>(sql`
    SELECT brief FROM custom_orders WHERE model_id = ${modelId}::uuid AND id = ${orderId}::uuid`)
  return rows[0] ? orderTitleOf(rows[0].brief) || null : null
}

/** The open order a CUS was delivered for: its latest live delivery; closed orders take none. */
async function openOrderOf(tx: Tx, modelId: string, itemId: string): Promise<string | null> {
  const { rows } = await tx.execute<{ order_id: string }>(sql`
    SELECT d.order_id FROM custom_order_deliveries d
      JOIN custom_orders o ON o.model_id = d.model_id AND o.id = d.order_id
     WHERE d.model_id = ${modelId}::uuid AND d.item_id = ${itemId}::uuid AND d.retracts_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM custom_order_deliveries r WHERE r.retracts_id = d.id)
       AND o.status NOT IN ('closed', 'cancelled')
     ORDER BY d.linked_at DESC, d.id DESC
     LIMIT 1`)
  return rows[0]?.order_id ?? null
}

/** Sealed composition of the delivered versions and the delivery rows of the order (§8.2). */
async function recordDelivery(
  tx: Tx,
  modelId: string,
  orderId: string,
  item: ItemRef,
  files: readonly CreatedFile[],
  drafts: readonly DraftRow[],
  actor: Actor,
) {
  const deliveredAt =
    drafts
      .map((draft) => draft.arrived_at)
      .filter((at): at is string => at !== null)
      .sort()[0] ?? null
  for (const part of ['video', 'photos'] as const) {
    const chosen = files.filter((file) => (part === 'video') === (file.media === 'video'))
    if (chosen.length === 0) continue
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO asset_manifests (model_id, purpose, origin_item_id, entry_count, created_by)
      VALUES (${modelId}::uuid, 'submission', ${item.id}::uuid, ${chosen.length}, ${actor.id}::uuid)
      RETURNING id`)
    const manifestId = (rows[0] as { id: string }).id
    for (const [index, file] of chosen.entries()) {
      await tx.execute(sql`
        INSERT INTO asset_manifest_entries (
          model_id, manifest_id, position, item_id, membership_id, asset_id, asset_version_id,
          handle_snapshot
        ) VALUES (
          ${modelId}::uuid, ${manifestId}::uuid, ${index + 1}, ${item.id}::uuid,
          ${file.membershipId}::uuid, ${file.assetId}::uuid, ${file.versionId}::uuid, ${file.handle}
        )`)
    }
    await tx.execute(sql`
      INSERT INTO custom_order_deliveries (
        model_id, order_id, part, item_id, manifest_id, delivered_at, basis, draft_id, linked_by
      ) VALUES (
        ${modelId}::uuid, ${orderId}::uuid, ${part}, ${item.id}::uuid, ${manifestId}::uuid,
        coalesce(${deliveredAt}::timestamptz, now()),
        ${JSON.stringify({ chosen: 'intake', files: chosen.length })}::jsonb,
        ${chosen[0]?.draftId ?? null}::uuid, ${actor.id}::uuid
      )`)
  }
}

export async function acceptGroup(
  tx: Tx,
  model: ModelScope,
  actor: Actor,
  groupId: string,
  options: AcceptOptions,
): Promise<AcceptResult> {
  const group = await lockGroupForDecision(tx, model, groupId)
  const drafts = await lockOpenDrafts(tx, model, groupId)
  if (drafts.length === 0) throw new ApiProblem('case_resolved', 'Группа уже решена')
  const asIs = options.as_is ? await takeBrokenAsIs(tx, model, drafts) : 0
  const stuck = drafts.find((draft) => draft.blocked_reason)
  if (stuck) {
    throw blocked(stuck.blocked_reason as string, 'Сначала примите решение по группе')
  }
  const { files, twins } = splitTwins(drafts)
  const notReady = files.filter((draft) => !draft.master_verified || !draft.master_hex)
  if (notReady.length > 0) {
    // A partial group is refused, never thinned (schema §5).
    throw blocked('not_ready', 'Не все файлы готовы: мастер ещё не проверен', {
      files: notReady.length,
    })
  }

  // The target object: «Дополнить…», a new revision of an accepted file, or the object this
  // group already made.
  const draftTarget = drafts.find((draft) => draft.target_item_id)?.target_item_id ?? null
  let target: ItemRow | null = null
  if (options.extend) {
    target = await findItem(tx, model, options.extend.item_id, { lock: true })
  } else if (options.as !== 'separate' && (draftTarget || group.created_item_id)) {
    const { rows } = await tx.execute<{ public_id: string }>(sql`
      SELECT public_item_id(type, number) AS public_id FROM content_items
       WHERE model_id = ${model.id}::uuid AND id = ${(draftTarget ?? group.created_item_id) as string}::uuid`)
    if (rows[0]) target = await findItem(tx, model, rows[0].public_id, { lock: true })
  }
  const type = target ? target.type : group.proposed_type
  if (!type) throw blocked('needs_type', 'Сначала выберите тип')
  if (!target && group.created_item_id && options.as === 'separate') {
    // One group makes one object (schema §4): «Отдельным объектом» is a split first.
    throw blocked('separate', 'Сначала вынесите файлы в отдельную группу')
  }
  const roles = target ? null : rolesFor(type, files)

  // Bytes by ascending SHA-256 (schema §9.3): two accepts over shared bytes never deadlock.
  const masters = [...new Set(files.map((draft) => draft.master_hex as string))].sort()
  for (const hex of masters) {
    if (!(await lockBlobForReference(tx, hex))) {
      throw blocked('bytes_missing', 'Байтов мастера нет на месте', { sha256: hex })
    }
  }

  let item: ItemRef
  let how: AcceptResult['how']
  if (target) {
    item = { id: target.id, type: target.type, number: target.number }
    how = options.how ?? 'extend'
    await setJournalItem(tx, item.id)
  } else {
    const number = await issueNumber(tx, model.id, type)
    // A delivery without its own title is called as the order is (DESIGN §6.6: the PPV made
    // from it later takes this title without typing).
    const title =
      group.proposed_title ??
      (type === 'CUS' && group.custom_order_id
        ? await orderTitle(tx, model.id, group.custom_order_id)
        : null)
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO content_items (
        model_id, type, number, title, title_en, description, ppv_kind, raw_purpose,
        has_second_person, name_in_media, created_from_group_id, origin, created_by
      ) VALUES (
        ${model.id}::uuid, ${type}, ${number}, ${title}, ${group.proposed_title_en},
        ${group.proposed_description},
        ${type === 'PPV' ? (group.proposed_ppv_kind ?? 'bundle') : null},
        ${type === 'RAW' ? (group.proposed_purpose ?? 'unknown') : null},
        ${group.has_second_person ?? false}, ${type === 'CUS' ? 'unknown' : null},
        ${group.id}::uuid, 'intake', ${actor.id}::uuid
      )
      RETURNING id`)
    item = { id: (rows[0] as { id: string }).id, type, number }
    how = options.how ?? (group.custom_order_id ? 'delivery' : 'new')
    await setJournalItem(tx, item.id)
  }

  const ordinals = await nextOrdinals(tx, model.id, item.id)
  let position = await nextPosition(tx, model.id, item.id)
  const created: CreatedFile[] = []
  for (const draft of files) {
    const media: values.MediaKind = draft.media_kind ?? 'image'
    // A role the draft already carries (a processed frame bound to its source) wins when it
    // fits the type of the object.
    const proposed =
      !roles && draft.proposed_role && rolesFits(type, draft.proposed_role)
        ? draft.proposed_role
        : null
    const role = roles
      ? (roles.get(draft.id) as Role)
      : (proposed ?? options.role ?? appendRole(type, draft, options.extend))
    // `ed07` is the processed version of `raw07` (naming §3): the same number, and a second
    // processed version of that frame is a new version of the same file.
    const bound = role === 'ed' && draft.proposed_ordinal !== null ? draft.proposed_ordinal : null
    const sameFrame = bound !== null ? await ownedAsset(tx, model.id, item.id, 'ed', bound) : null
    // New bytes of a file that is already here: a new version of that file.
    const existing =
      draft.target_asset_id ??
      sameFrame?.live ??
      (target && (role === 'master' || role === 'teaser')
        ? await singleRoleAsset(tx, model.id, item.id, role)
        : null)
    if (existing) {
      const written = await writeVersion(tx, model.id, draft, actor, { assetId: existing })
      await writeAliases(tx, model.id, draft, written.assetId, actor)
      if (bound !== null)
        await processedFrom(tx, model.id, item.id, bound, written.versionId, actor)
      created.push({ draftId: draft.id, ...written, membershipId: null, handle: role, media })
      continue
    }
    // A handle is never reused (schema §4): a removed `ed07` sends the file to the next number.
    const ordinal = !ORDINAL_ROLES.has(role)
      ? null
      : bound !== null && !sameFrame?.taken
        ? bound
        : (ordinals.get(role) ?? 0) + 1
    if (ordinal !== null) ordinals.set(role, Math.max(ordinals.get(role) ?? 0, ordinal))
    const written = await writeVersion(tx, model.id, draft, actor, { itemId: item.id, media })
    if (bound !== null) await processedFrom(tx, model.id, item.id, bound, written.versionId, actor)
    const membershipId = await addMembership(
      tx,
      model.id,
      item,
      written.assetId,
      role,
      ordinal,
      position,
      actor,
    )
    position += 1
    await writeAliases(tx, model.id, draft, written.assetId, actor)
    created.push({
      draftId: draft.id,
      ...written,
      membershipId,
      handle: handleOf({ role, ordinal, variant_no: 0 }),
      media,
    })
  }

  if (!target) {
    const tags = await tagIds(tx, model, group.proposed_tags ?? [], actor)
    for (const tagId of tags.values()) {
      await tx.execute(sql`
        INSERT INTO item_tags (model_id, item_id, tag_id, source, added_by)
        VALUES (${model.id}::uuid, ${item.id}::uuid, ${tagId}::uuid, 'human', ${actor.id}::uuid)
        ON CONFLICT DO NOTHING`)
    }
    // Statuses of the fields move from the group to the object (schema §5).
    await tx.execute(sql`
      UPDATE annotation_fields SET group_id = NULL, item_id = ${item.id}::uuid
       WHERE model_id = ${model.id}::uuid AND group_id = ${group.id}::uuid`)
  } else {
    await touchItem(tx, model, target)
  }

  // A delivery of the order: the group's own order, or — for a new master version of a CUS
  // (the fix after a revision) — the open order the CUS was delivered for: «версии после
  // правок — к тому же заказу» (SPEC §4), a second delivery with `{master v2}` (schema §9.2).
  const orderId =
    item.type !== 'CUS'
      ? null
      : (group.custom_order_id ??
        (target && options.extend?.role === 'master_version'
          ? await openOrderOf(tx, model.id, item.id)
          : null))
  if (orderId) {
    await recordDelivery(tx, model.id, orderId, item, created, drafts, actor)
    await markDeliveredParts(tx, model, orderId, actor)
  }

  for (const { draft, of } of twins) {
    const file = created.find((one) => one.draftId === of.id) as CreatedFile
    await resolveAlias(
      tx,
      model.id,
      draft.id,
      { version_id: file.versionId, asset_id: file.assetId, item_id: item.id, type: item.type },
      draft.source_object_id,
      { decidedBy: actor.id },
    )
  }

  const outcome = target ? 'append' : 'new_item'
  for (const file of created) {
    await tx.execute(sql`
      UPDATE inbox_drafts
         SET state = 'resolved', outcome = ${outcome}, applied_item_id = ${item.id}::uuid,
             applied_version_id = ${file.versionId}::uuid, decided_at = now(),
             decided_by = ${actor.id}::uuid, updated_at = now(), row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND id = ${file.draftId}::uuid`)
  }
  await tx.execute(sql`
    UPDATE inbox_groups SET closed_at = coalesce(closed_at, now()), updated_at = now(),
           row_version = row_version + 1
     WHERE model_id = ${model.id}::uuid AND id = ${group.id}::uuid`)

  // Claims of the old names on these files and their folders may become placements now
  // (SPEC §6.3): only those whose label the КМ confirmed for a page.
  await materializeClaims(tx, model.id, actor.id, {
    objectIds: drafts.flatMap((draft) => (draft.source_object_id ? [draft.source_object_id] : [])),
  })

  // The same bytes waiting in other groups are aliases of these files from now on (§6.2).
  const accepted = files.flatMap((draft) => [draft.source_hex, draft.master_hex])
  const elsewhere = await aliasOpenDuplicates(tx, model.id, group.id, [
    ...new Set(accepted.filter((hex): hex is string => Boolean(hex))),
  ])

  const publicId = publicIdOf(item.type, item.number)
  await logItemAction(tx, model, item, {
    action: how === 'upload' ? 'draft.accept_on_upload' : 'draft.accept',
    after: {
      Как: target ? `дополнение ${publicId}` : `новый объект ${publicId}`,
      Файлов: String(created.length),
      ...(twins.length + elsewhere > 0 ? { Дублей: String(twins.length + elsewhere) } : {}),
      ...(asIs > 0 ? { 'Как есть': `битый исходник: ${asIs}` } : {}),
      ...(how === 'upload' ? { Принято: 'при загрузке' } : {}),
    },
  })
  return { item_id: publicId, how, next_step: target ? null : nextStep(item.type) }
}

/** «Отклонить» (SPEC §6.1): the drafts are decided, their bytes stay (§9.1). */
export async function rejectGroup(
  tx: Tx,
  model: ModelScope,
  actor: Actor,
  groupId: string,
  reason: string | null,
): Promise<number> {
  await lockGroupForDecision(tx, model, groupId)
  const drafts = await lockOpenDrafts(tx, model, groupId)
  if (drafts.length === 0) throw new ApiProblem('case_resolved', 'Группа уже решена')
  await tx.execute(sql`
    UPDATE inbox_drafts
       SET state = 'resolved', outcome = 'rejected', reject_reason = ${reason || null},
           rejected_at = now(), decided_at = now(), decided_by = ${actor.id}::uuid,
           blocked_reason = NULL, updated_at = now(), row_version = row_version + 1
     WHERE model_id = ${model.id}::uuid AND id = ANY (${sql.param(drafts.map((draft) => draft.id))}::uuid[])`)
  return drafts.length
}

/**
 * «Вернуть в работу» (schema §9.3): rejected drafts go back to `ready` while their bytes are
 * on disk — the trigger `inbox_draft_transition` checks it under the blob's row lock.
 */
export async function reopenGroup(tx: Tx, model: ModelScope, groupId: string): Promise<number> {
  await lockGroupForDecision(tx, model, groupId)
  const { rows } = await tx.execute<{ id: string }>(sql`
    UPDATE inbox_drafts
       SET state = 'ready', outcome = NULL, reopened_at = now(), reopen_count = reopen_count + 1,
           decided_at = NULL, decided_by = NULL, updated_at = now(), row_version = row_version + 1
     WHERE model_id = ${model.id}::uuid AND group_id = ${groupId}::uuid
       AND state = 'resolved' AND outcome = 'rejected'
    RETURNING id`)
  if (rows.length === 0) throw new ApiProblem('case_resolved', 'Возвращать нечего')
  return rows.length
}
