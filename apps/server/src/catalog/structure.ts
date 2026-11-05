import { ITEM_TYPE_INFO, type ItemId, type ItemType } from '@contentops/contracts/domain/item-type'
import { setJournalItem, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { Actor, ModelScope, RequestContext } from '../context'
import { ApiProblem } from '../errors'
import { findChannel } from '../promo/views'
import { handleOf, type MembershipRow, memberships } from './detail'
import { holdsOf, lockPagesOf, movePlacements, refuseHeld, releaseCandidates } from './holds'
import {
  type DbItemType,
  dbType,
  findItem,
  type ItemRow,
  itemTypeOfDb,
  publicIdOf,
  publicIdOfRow,
} from './ids'
import { issueNumber } from './numbers'
import { checkItemVersion, lockItem, lockItems, logItemAction, touchItem } from './writes'

/**
 * Changes of the catalog's structure (SPEC §4.1, §6.3, schema §3.2): a type change is a new
 * object with a new number, the files move and the old ID becomes an alias; a removal is a
 * tombstone that can be taken back; objects of one type merge (the lower number stays, the other
 * is a tombstone and an alias), picked files go to a new object of the same type («Выделить») or
 * to an existing object of any type («Перенести в…»). One command, one transaction; versions are
 * never created or changed, the old sub-handles stay as aliases (`RAW-0035/raw03`).
 *
 * What lived on the old object moves, it is not copied: the links of origin, the aliases, the
 * placements that follow the object (`holds.ts`); nothing of it stays on a tombstone but the
 * record of the merge itself («Слит из»).
 */

type Role = MembershipRow['role']

const ORDINAL_ROLES = new Set<Role>(['pic', 'raw', 'ed', 'clip'])

/** The handle of a file in its object. */
const keyOf = (row: Pick<MembershipRow, 'role' | 'ordinal' | 'variant_no'>) =>
  handleOf(row.role, row.ordinal, row.variant_no)

const isMaster = (row: MembershipRow) =>
  row.kind === 'owned' && row.role === 'master' && row.variant_no === 0

/**
 * The role a file takes in an object of the type; `null` — it has no place there. A role
 * without a number (master, teaser, cover frame) is the object's once and for ever: a removed
 * one keeps it (`item_memberships_handle`), so a second master never comes in.
 */
function roleIn(type: DbItemType, row: MembershipRow, taken: ReadonlySet<Role>): Role | null {
  const video = row.media_kind === 'video'
  const free = (role: Role) => !taken.has(role)
  switch (type) {
    case 'PPV':
      if (!video) return row.role === 'thumb' && free('thumb') ? 'thumb' : 'pic'
      if (row.role === 'teaser' && free('teaser')) return 'teaser'
      return free('master') ? 'master' : null
    case 'CUS':
      if (!video) return 'pic'
      return free('master') ? 'master' : 'clip'
    case 'FYP':
      return video && free('master') ? 'master' : null
    case 'SET':
      if (video) return null
      return row.role === 'ed' ? 'ed' : 'raw'
    case 'SXT':
    case 'LIFE':
    case 'PRM':
      return video ? 'clip' : 'pic'
    case 'RAW':
      return 'raw'
    default:
      return null
  }
}

interface Target {
  id: string
  type: DbItemType
  number: number
  publicId: ItemId
}

const targetOf = (item: ItemRow): Target => ({
  id: item.id,
  type: item.type,
  number: item.number,
  publicId: publicIdOfRow(item),
})

/**
 * A file's place in the target: a new membership, the one it had there before, or nothing — a
 * reference to a file the collection already holds only closes.
 */
interface Place {
  row: MembershipRow
  kind: 'owned' | 'reference'
  role: Role
  ordinal: number | null
  /** The file was in the target before: its own handle comes back (one membership per file). */
  reopen: string | null
  drop?: boolean
}

/** What the target already used: roles without a number, numbers by role, files it held. */
interface Slots {
  taken: Set<Role>
  top: Map<Role, number>
  position: number
  past: Map<string, { id: string; kind: string; role: Role; ordinal: number | null; live: boolean }>
}

/** A new object has used nothing yet. */
const emptySlots = (): Slots => ({ taken: new Set(), top: new Map(), position: 0, past: new Map() })

async function slotsOf(tx: Tx, model: ModelScope, itemId: string): Promise<Slots> {
  const { rows } = await tx.execute<{
    id: string
    asset_id: string
    kind: string
    role: Role
    ordinal: number | null
    variant_no: number
    live: boolean
    display_position: number | null
  }>(sql`
    SELECT id, asset_id, kind, role, ordinal, variant_no, removed_at IS NULL AS live,
           display_position
      FROM item_memberships
     WHERE model_id = ${model.id}::uuid AND item_id = ${itemId}::uuid`)
  const slots = emptySlots()
  for (const row of rows) {
    if (row.kind === 'owned' && row.variant_no === 0 && row.ordinal === null) {
      slots.taken.add(row.role)
    }
    if (row.ordinal !== null) {
      slots.top.set(row.role, Math.max(slots.top.get(row.role) ?? 0, row.ordinal))
    }
    slots.position = Math.max(slots.position, row.display_position ?? 0)
    slots.past.set(row.asset_id, {
      id: row.id,
      kind: row.kind,
      role: row.role,
      ordinal: row.ordinal,
      live: row.live,
    })
  }
  return slots
}

/** Where every file goes in the target; the handles of files without a place are named. */
function placesIn(
  target: Pick<Target, 'type'>,
  slots: Slots,
  rows: readonly MembershipRow[],
): { places: Place[]; homeless: string[] } {
  // A master takes the master's place before any other video of the same command.
  const ordered = [...rows].sort((left, right) => Number(isMaster(right)) - Number(isMaster(left)))
  const places: Place[] = []
  const homeless: string[] = []
  for (const row of ordered) {
    const past = slots.past.get(row.asset_id)
    // A unique version `uN` belongs to its montage.
    if (row.variant_no > 0) {
      homeless.push(keyOf(row))
      continue
    }
    if (row.kind === 'reference') {
      if (target.type !== 'PRM' || (past && !past.live && past.kind !== 'reference')) {
        homeless.push(keyOf(row))
      } else if (past?.live) {
        places.push({
          row,
          kind: 'reference',
          role: row.role,
          ordinal: null,
          reopen: null,
          drop: true,
        })
      } else {
        places.push({
          row,
          kind: 'reference',
          role: row.role,
          ordinal: null,
          reopen: past?.id ?? null,
        })
      }
      continue
    }
    // The target holds the file by reference (one membership per file and object).
    if (past && (past.live || past.kind !== 'owned')) {
      homeless.push(keyOf(row))
      continue
    }
    if (past) {
      places.push({ row, kind: 'owned', role: past.role, ordinal: past.ordinal, reopen: past.id })
      continue
    }
    const role = roleIn(target.type, row, slots.taken)
    if (role === null) {
      homeless.push(keyOf(row))
      continue
    }
    if (!ORDINAL_ROLES.has(role)) slots.taken.add(role)
    places.push({ row, kind: 'owned', role, ordinal: null, reopen: null })
  }
  return { places, homeless }
}

function refuseHomeless(homeless: readonly string[], where: string, hint = ''): void {
  if (homeless.length === 0) return
  throw new ApiProblem(
    'invalid_request',
    `В ${where} не встанут файлы: ${homeless.join(', ')}${hint}`,
    { keys: homeless },
  )
}

const placeWords = (target: Target) =>
  `${target.publicId} (${ITEM_TYPE_INFO[itemTypeOfDb(target.type)].noun})`

/**
 * Files move to another object: the old membership closes, the old handle becomes an alias of
 * the file, the new one takes the next free number of its role (handles are never reused,
 * removed ones count too); a file that was in the target before gets its own handle back. The
 * chronology of the moved versions goes with them; a cover that left is the target's if it has
 * none. Answers the new handle of every moved file by the old one.
 */
async function moveFiles(
  tx: Tx,
  model: ModelScope,
  from: ItemRow,
  to: Target,
  slots: Slots,
  places: readonly Place[],
  actor: Actor,
): Promise<Map<string, string>> {
  const fromId = publicIdOfRow(from)
  const handles = new Map<string, string>()
  let cover: string | null = null
  for (const place of places) {
    const { row } = place
    await tx.execute(sql`
      UPDATE item_memberships
         SET removed_at = now(), display_position = NULL, row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`)
    if (row.kind === 'owned') {
      await tx.execute(sql`
        INSERT INTO aliases (model_id, kind, value_raw, asset_id, created_by)
        VALUES (${model.id}::uuid, 'sub_handle', ${`${fromId}/${keyOf(row)}`},
                ${row.asset_id}::uuid, ${actor.id}::uuid)
        ON CONFLICT ON CONSTRAINT aliases_value DO NOTHING`)
    }
    if (place.drop) continue
    slots.position += 1
    const selected = to.type === 'SET' && from.type === 'SET' && row.selected
    const lifeUse = to.type === 'LIFE' && from.type === 'LIFE' ? row.life_use : null
    let membership: string
    let ordinal = place.ordinal
    if (place.reopen) {
      await tx.execute(sql`
        UPDATE item_memberships
           SET removed_at = NULL, display_position = ${slots.position}, selected = ${selected},
               life_use = ${lifeUse}, added_at = now(), added_by = ${actor.id}::uuid,
               row_version = row_version + 1
         WHERE model_id = ${model.id}::uuid AND id = ${place.reopen}::uuid`)
      membership = place.reopen
    } else {
      if (ORDINAL_ROLES.has(place.role)) {
        ordinal = (slots.top.get(place.role) ?? 0) + 1
        slots.top.set(place.role, ordinal)
      }
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO item_memberships (model_id, item_id, item_type, asset_id, variant_no, kind,
                                      role, ordinal, display_position, selected, life_use,
                                      added_by)
        VALUES (${model.id}::uuid, ${to.id}::uuid, ${to.type}, ${row.asset_id}::uuid, 0,
                ${place.kind}, ${place.role}, ${ordinal}, ${slots.position}, ${selected},
                ${lifeUse}, ${actor.id}::uuid)
        RETURNING id`)
      membership = (rows[0] as { id: string }).id
    }
    handles.set(keyOf(row), handleOf(place.role, ordinal, 0))
    if (from.cover_membership_id === row.id) cover = membership
  }
  await moveChronology(
    tx,
    model,
    from.id,
    to.id,
    places.filter((place) => place.kind === 'owned').map((place) => place.row.asset_id),
  )
  if (cover) {
    await tx.execute(sql`
      UPDATE content_items SET cover_membership_id = NULL
       WHERE model_id = ${model.id}::uuid AND id = ${from.id}::uuid`)
    await tx.execute(sql`
      UPDATE content_items SET cover_membership_id = ${cover}::uuid
       WHERE model_id = ${model.id}::uuid AND id = ${to.id}::uuid AND cover_membership_id IS NULL`)
  }
  return handles
}

/** Chronology of the moved versions goes with them (`item_id` is fixed: delete and re-insert). */
async function moveChronology(
  tx: Tx,
  model: ModelScope,
  fromId: string,
  toId: string,
  assetIds: readonly string[] | null,
) {
  if (assetIds !== null && assetIds.length === 0) return
  const { rows } = await tx.execute<{
    asset_version_id: string
    at_ms: string
    end_ms: string | null
    text: string
    source: string
    frame_artifact_id: string | null
    created_at: string
    created_by: string | null
  }>(sql`
    DELETE FROM chronology_entries c
     WHERE c.model_id = ${model.id}::uuid AND c.item_id = ${fromId}::uuid
       ${
         assetIds === null
           ? sql``
           : sql`AND c.asset_version_id IN (
               SELECT v.id FROM asset_versions v
                WHERE v.model_id = c.model_id
                  AND v.asset_id = ANY(${sql.param([...assetIds])}::uuid[]))`
       }
    RETURNING asset_version_id, at_ms::text, end_ms::text, text, source, frame_artifact_id,
              created_at::text, created_by`)
  for (const entry of rows) {
    await tx.execute(sql`
      INSERT INTO chronology_entries (model_id, item_id, asset_version_id, at_ms, end_ms, text,
                                      source, frame_artifact_id, created_at, created_by)
      VALUES (${model.id}::uuid, ${toId}::uuid, ${entry.asset_version_id}::uuid,
              ${entry.at_ms}::bigint, ${entry.end_ms}::bigint, ${entry.text}, ${entry.source},
              ${entry.frame_artifact_id}::uuid, ${entry.created_at}::timestamptz,
              ${entry.created_by}::uuid)`)
  }
}

/** A new object of the model with the next number of its type (legacy pass required). */
async function newItem(
  tx: Tx,
  model: ModelScope,
  type: DbItemType,
  source: ItemRow,
  actor: Actor,
  channelId: string | null = null,
): Promise<Target> {
  const number = await issueNumber(tx, model.id, type)
  const channel = type === 'PRM' ? (channelId ?? source.promo_channel_id) : null
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO content_items (model_id, type, number, title, title_en, description, ppv_kind,
                               raw_purpose, shot_on, has_second_person, name_in_media, origin,
                               promo_channel_id, default_contractor_id, created_by)
    SELECT model_id, ${type}, ${number}, title, title_en, description,
           ${type === 'PPV' ? sql`coalesce(ppv_kind, 'bundle')` : sql`NULL`},
           ${type === 'RAW' ? sql`coalesce(raw_purpose, 'unknown')` : sql`NULL`},
           shot_on, has_second_person, ${type === 'CUS' ? sql`name_in_media` : sql`NULL`},
           'manual', ${channel}::uuid,
           ${type === 'PRM' && source.type === 'PRM' ? sql`default_contractor_id` : sql`NULL`},
           ${actor.id}::uuid
      FROM content_items WHERE model_id = ${model.id}::uuid AND id = ${source.id}::uuid
    RETURNING id`)
  const id = rows[0]?.id
  if (!id) throw new Error('new item insert returned nothing')
  return { id, type, number, publicId: publicIdOf(type, number) }
}

/**
 * The object lives on in another one: its tags and item-level markup states are the other's
 * too, its aliases and its old ID name the other one, and what was merged into it before points
 * at the other one now.
 */
async function carryOver(tx: Tx, model: ModelScope, from: ItemRow, toId: string) {
  await tx.execute(sql`
    INSERT INTO item_tags (model_id, item_id, tag_id, source, group_at_import, added_by)
    SELECT model_id, ${toId}::uuid, tag_id, source, group_at_import, added_by FROM item_tags
     WHERE model_id = ${model.id}::uuid AND item_id = ${from.id}::uuid
    ON CONFLICT (model_id, item_id, tag_id) DO NOTHING`)
  await tx.execute(sql`
    INSERT INTO annotation_fields (model_id, item_id, field, value_version,
                                   confirmed_value_version, confirmed_at, confirmed_by, updated_by)
    SELECT model_id, ${toId}::uuid, field, value_version, confirmed_value_version, confirmed_at,
           confirmed_by, updated_by
      FROM annotation_fields WHERE model_id = ${model.id}::uuid AND item_id = ${from.id}::uuid
    ON CONFLICT ON CONSTRAINT annotation_fields_target DO NOTHING`)
  // An alias the other object already has stays where it is: one is enough.
  await tx.execute(sql`
    UPDATE aliases a SET item_id = ${toId}::uuid
     WHERE a.model_id = ${model.id}::uuid AND a.item_id = ${from.id}::uuid
       AND NOT EXISTS (SELECT 1 FROM aliases b
                        WHERE b.model_id = a.model_id AND b.kind = a.kind
                          AND b.value_norm = a.value_norm AND b.item_id = ${toId}::uuid)`)
  await tx.execute(sql`
    INSERT INTO aliases (model_id, kind, value_raw, item_id)
    VALUES (${model.id}::uuid, 'merged_id', ${publicIdOfRow(from)}, ${toId}::uuid)
    ON CONFLICT ON CONSTRAINT aliases_value DO NOTHING`)
  await tx.execute(sql`
    UPDATE content_items SET merged_into_item_id = ${toId}::uuid
     WHERE model_id = ${model.id}::uuid AND merged_into_item_id = ${from.id}::uuid`)
}

/**
 * Links of origin move to the other object: drawn again with the other end (the ends of a link
 * never change) and taken off the old one. A link between the two — or with what was merged into
 * the other one before — becomes nothing; one the other object already has is not drawn twice; a
 * circle is refused.
 */
async function moveLinks(tx: Tx, model: ModelScope, from: ItemRow, to: Target): Promise<number> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT p.id FROM provenance p
     WHERE p.model_id = ${model.id}::uuid AND p.voided_by_id IS NULL
       AND (p.child_item_id = ${from.id}::uuid OR p.parent_item_id = ${from.id}::uuid)
       AND NOT EXISTS (SELECT 1 FROM provenance q
                        WHERE q.model_id = p.model_id AND q.voided_by_id = p.id)
     FOR UPDATE`)
  if (rows.length === 0) return 0
  const ids = sql.param(rows.map((row) => row.id))
  const { rows: carried } = await tx.execute<{ n: number }>(sql`
    WITH carried AS (
      SELECT model_id, relation,
             CASE WHEN child_item_id = ${from.id}::uuid THEN ${to.id}::uuid ELSE child_item_id END
               AS child_item_id,
             child_version_id,
             CASE WHEN parent_item_id = ${from.id}::uuid THEN ${to.id}::uuid ELSE parent_item_id END
               AS parent_item_id,
             parent_version_id, params, basis, work_id, created_at, created_by
        FROM provenance
       WHERE model_id = ${model.id}::uuid AND id = ANY(${ids}::uuid[])
         AND NOT coalesce(child_item_id = ${from.id}::uuid AND parent_item_id = ${to.id}::uuid, false)
         AND NOT coalesce(child_item_id = ${to.id}::uuid AND parent_item_id = ${from.id}::uuid, false)
         -- A link to what was merged into the other object is a link of it with itself.
         AND NOT (relation <> 'merged_from' AND EXISTS (
               SELECT 1 FROM content_items t
                WHERE t.model_id = provenance.model_id AND t.merged_into_item_id = ${to.id}::uuid
                  AND t.id = CASE WHEN child_item_id = ${from.id}::uuid THEN parent_item_id
                                  ELSE child_item_id END))
    ), drawn AS (
      INSERT INTO provenance (model_id, relation, child_item_id, child_version_id, parent_item_id,
                              parent_version_id, params, basis, work_id, created_at, created_by)
      SELECT * FROM carried
      ON CONFLICT ON CONSTRAINT provenance_link DO NOTHING
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM carried`)
  await tx.execute(sql`
    DELETE FROM provenance WHERE model_id = ${model.id}::uuid AND id = ANY(${ids}::uuid[])`)
  const { rows: circle } = await tx.execute<{ found: boolean }>(sql`
    WITH RECURSIVE up (item_id) AS (
      SELECT parent_item_id FROM provenance
       WHERE model_id = ${model.id}::uuid AND child_item_id = ${to.id}::uuid
         AND parent_item_id IS NOT NULL AND voided_by_id IS NULL
      UNION
      SELECT p.parent_item_id FROM provenance p JOIN up ON p.child_item_id = up.item_id
       WHERE p.model_id = ${model.id}::uuid AND p.voided_by_id IS NULL
         AND p.parent_item_id IS NOT NULL
    )
    SELECT EXISTS (SELECT 1 FROM up WHERE item_id = ${to.id}::uuid) AS found`)
  if (circle[0]?.found) {
    throw new ApiProblem(
      'invalid_request',
      `Связи ${publicIdOfRow(from)} замкнут круг в ${to.publicId}: сначала уберите лишнюю связь`,
    )
  }
  return carried[0]?.n ?? 0
}

async function tombstone(
  tx: Tx,
  model: ModelScope,
  item: ItemRow,
  actor: Actor,
  into: string | null,
) {
  await tx.execute(sql`
    UPDATE content_items
       SET deleted_at = now(), deleted_by = ${actor.id}::uuid, merged_into_item_id = ${into}::uuid,
           row_version = row_version + 1, updated_at = now()
     WHERE model_id = ${model.id}::uuid AND id = ${item.id}::uuid`)
}

/** A handoff of a collection belongs to it for ever (`promo_deliveries` is fixed). */
async function requireNoHandoffs(tx: Tx, model: ModelScope, item: ItemRow, what: string) {
  if (item.type !== 'PRM') return
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM promo_deliveries
     WHERE model_id = ${model.id}::uuid AND package_item_id = ${item.id}::uuid`)
  const n = rows[0]?.n ?? 0
  if (n > 0) {
    throw new ApiProblem('item_in_use', `${what} нельзя: у ${publicIdOfRow(item)} передач: ${n}`, {
      uses: [`передач: ${n}`],
    })
  }
}

/** Words of the journal for what followed the object. */
function followed(counts: {
  files?: number
  links?: number
  claims?: number
  placements?: number
  candidates?: number
}): Record<string, string> {
  const out: Record<string, string> = {}
  if (counts.files) out.Файлов = String(counts.files)
  if (counts.links) out['Связей перенесено'] = String(counts.links)
  if (counts.claims) out['Отметок «выходило» перенесено'] = String(counts.claims)
  if (counts.placements) out['Размещений перенесено'] = String(counts.placements)
  if (counts.candidates) out['Кандидатов Hub снято'] = String(counts.candidates)
  return out
}

/**
 * «Сменить тип» (SPEC §4.1): a new object with a new number; files, fields, links and the claims
 * of old names move. Plan rows, deliveries, promo references and confirmed placements hold it;
 * candidates of the history pass are taken back. A promo collection needs its channel.
 */
export async function changeType(
  tx: Tx,
  model: ModelScope,
  id: string,
  body: { type: ItemType; channel?: string | null },
  ctx: RequestContext,
  actor: Actor,
): Promise<ItemId> {
  const pages = await lockPagesOf(tx, model, [(await findItem(tx, model, id)).id])
  const item = await lockItem(tx, model, id)
  await checkItemVersion(tx, ctx, item)
  const target = dbType(body.type)
  if (target === item.type) throw new ApiProblem('invalid_request', 'Тип уже такой')
  const channel =
    target === 'PRM' ? (body.channel ? await findChannel(tx, model, body.channel) : null) : null
  if (target === 'PRM' && !channel) {
    throw new ApiProblem('invalid_request', 'Промо-подборке нужен канал', { field: 'channel' })
  }
  const holds = await holdsOf(tx, model, item, pages)
  refuseHeld(item, holds, 'Сменить тип', { promo: true, kinds: ['confirmed'] })
  await requireNoHandoffs(tx, model, item, 'Сменить тип')
  const rows = await memberships(tx, model, [item.id])
  const slots = emptySlots()
  const { places, homeless } = placesIn({ type: target }, slots, rows)
  refuseHomeless(homeless, ITEM_TYPE_INFO[body.type].folder)
  const created = await newItem(tx, model, target, item, actor, channel?.id ?? null)
  await setJournalItem(tx, created.id)
  await moveFiles(tx, model, item, created, slots, places, actor)
  await carryOver(tx, model, item, created.id)
  const links = await moveLinks(tx, model, item, created)
  await moveChronology(tx, model, item.id, created.id, null)
  const claims = holds.placements.filter((placement) => placement.kind === 'claim')
  await movePlacements(tx, model, item, created, claims)
  const candidates = await releaseCandidates(tx, model, holds.placements, actor, 'change_type')
  const words = `${publicIdOfRow(item)} → ${created.publicId}`
  const after = followed({ links, claims: claims.length, candidates })
  await logItemAction(tx, model, created, { subject: words, after })
  await setJournalItem(tx, item.id)
  await tombstone(tx, model, item, actor, created.id)
  await logItemAction(tx, model, item, { subject: words, after })
  return created.publicId
}

/**
 * «Удалить»: a tombstone; the number, files and links stay for «Вернуть». Candidates of the
 * history pass do not hold it, they are taken back; everything else does.
 */
export async function removeItem(
  tx: Tx,
  model: ModelScope,
  id: string,
  ctx: RequestContext,
  actor: Actor,
) {
  const pages = await lockPagesOf(tx, model, [(await findItem(tx, model, id)).id])
  const item = await lockItem(tx, model, id)
  await checkItemVersion(tx, ctx, item)
  const holds = await holdsOf(tx, model, item, pages)
  refuseHeld(item, holds, 'Удалить', { promo: true, kinds: ['claim', 'confirmed'] })
  const candidates = await releaseCandidates(tx, model, holds.placements, actor, 'remove')
  await tombstone(tx, model, item, actor, null)
  await logItemAction(tx, model, item, {
    subject: `${publicIdOfRow(item)} «${item.title ?? ''}»`,
    after: followed({ candidates }),
  })
}

/** «Вернуть» a deleted object (not a merged one): the tombstone goes, the number is the same. */
export async function restoreItem(tx: Tx, model: ModelScope, item: ItemRow) {
  if (!item.deleted_at) throw new ApiProblem('invalid_request', 'Объект не удалён')
  if (item.merged_into_item_id) {
    throw new ApiProblem('invalid_request', 'Слитый объект не возвращается — он живёт в другом')
  }
  await tx.execute(sql`
    UPDATE content_items
       SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL,
           row_version = row_version + 1, updated_at = now()
     WHERE model_id = ${model.id}::uuid AND id = ${item.id}::uuid`)
  await logItemAction(tx, model, item, { subject: publicIdOfRow(item) })
}

/**
 * «Слить с…» (SPEC §4.1): two objects of one type become one; the lower number stays, the other
 * is a tombstone with its ID as an alias. Its files move with new handles and the old ones as
 * aliases, its links, aliases, claims and placements follow; candidates of the history pass are
 * taken back. Plan rows and deliveries of the other hold the merge, and so does a file that has
 * no place in the one that stays — a second master is refused, not dropped.
 */
export async function mergeItems(
  tx: Tx,
  model: ModelScope,
  id: string,
  into: string,
  ctx: RequestContext,
  actor: Actor,
): Promise<ItemId> {
  const found = [await findItem(tx, model, id), await findItem(tx, model, into)]
  const pages = await lockPagesOf(
    tx,
    model,
    found.map((item) => item.id),
  )
  const locked = await lockItems(tx, model, [id, into])
  const self = locked.get(id)
  const other = locked.get(into)
  if (!self || !other) throw new Error('locked items vanished')
  await setJournalItem(tx, self.id)
  await checkItemVersion(tx, ctx, self)
  if (self.id === other.id)
    throw new ApiProblem('invalid_request', 'Объект не сливается сам с собой')
  if (self.type !== other.type) {
    throw new ApiProblem(
      'invalid_request',
      `Сливаются объекты одного типа: ${publicIdOfRow(self)} и ${publicIdOfRow(other)} разные — перенесите файлы или смените тип`,
    )
  }
  if (self.type === 'PRM' && self.promo_channel_id !== other.promo_channel_id) {
    throw new ApiProblem('invalid_request', 'Подборки разных каналов не сливаются')
  }
  const [survivor, loser] = self.number < other.number ? [self, other] : [other, self]
  const holds = await holdsOf(tx, model, loser, pages)
  refuseHeld(loser, holds, 'Слить', { promo: false, kinds: [] })
  await requireNoHandoffs(tx, model, loser, 'Слить')
  const to = targetOf(survivor)
  const rows = await memberships(tx, model, [loser.id])
  const slots = await slotsOf(tx, model, survivor.id)
  const { places, homeless } = placesIn(to, slots, rows)
  refuseHomeless(
    homeless,
    placeWords(to),
    rows.some((row) => isMaster(row) && homeless.includes(keyOf(row)))
      ? ` — у ${to.publicId} уже есть мастер: отметьте мастер ${publicIdOfRow(loser)} копией или перенесите его`
      : '',
  )
  await setJournalItem(tx, survivor.id)
  await moveFiles(tx, model, loser, to, slots, places, actor)
  await moveChronology(tx, model, loser.id, survivor.id, null)
  await carryOver(tx, model, loser, survivor.id)
  const links = await moveLinks(tx, model, loser, to)
  await tx.execute(sql`
    INSERT INTO provenance (model_id, relation, child_item_id, parent_item_id, basis, created_by)
    VALUES (${model.id}::uuid, 'merged_from', ${survivor.id}::uuid, ${loser.id}::uuid, 'manual',
            ${actor.id}::uuid)
    ON CONFLICT ON CONSTRAINT provenance_link DO NOTHING`)
  const moving = holds.placements.filter((placement) => placement.kind !== 'candidate')
  await movePlacements(tx, model, loser, to, moving)
  const candidates = await releaseCandidates(tx, model, holds.placements, actor, 'merge')
  await touchItem(tx, model, survivor)
  const words = `${publicIdOfRow(loser)} → ${to.publicId}`
  const claims = moving.filter((placement) => placement.kind === 'claim').length
  const after = followed({
    files: places.length,
    links,
    claims,
    placements: moving.length - claims,
    candidates,
  })
  await logItemAction(tx, model, survivor, { subject: words, after })
  await setJournalItem(tx, loser.id)
  await tombstone(tx, model, loser, actor, survivor.id)
  await logItemAction(tx, model, loser, { subject: words, after })
  return to.publicId
}

/** Live owned files of the object named by their handles; an unknown one refuses the command. */
async function pickFiles(tx: Tx, model: ModelScope, item: ItemRow, keys: readonly string[]) {
  const all = await memberships(tx, model, [item.id])
  const byKey = new Map(all.map((row) => [keyOf(row), row]))
  const unknown = keys.filter((key) => !byKey.has(key))
  if (unknown.length > 0) {
    throw new ApiProblem('invalid_request', 'Таких файлов в объекте нет', { keys: unknown })
  }
  const picked = [...new Set(keys)].map((key) => byKey.get(key) as MembershipRow)
  return { all, picked }
}

/** The master leaves only with everything else: alone it would leave its parts without it. */
function requireMasterStays(picked: readonly MembershipRow[], all: readonly MembershipRow[]) {
  if (picked.length < all.length && picked.some(isMaster)) {
    throw new ApiProblem(
      'invalid_request',
      'Мастер не уходит из объекта один — без него останутся тизер, части или кадры',
    )
  }
}

/** «Выделить в новый объект» («в новую съёмку» у сырья): the picked files get a new number. */
export async function extractFiles(
  tx: Tx,
  model: ModelScope,
  item: ItemRow,
  keys: readonly string[],
  actor: Actor,
): Promise<ItemId> {
  const { all, picked } = await pickFiles(tx, model, item, keys)
  if (picked.length === all.length) {
    throw new ApiProblem(
      'invalid_request',
      'Все файлы сразу не выделяются — объект останется пустым: смените тип или слейте его',
    )
  }
  requireMasterStays(picked, all)
  const slots = emptySlots()
  const created = await newItem(tx, model, item.type, item, actor)
  const { places, homeless } = placesIn(created, slots, picked)
  refuseHomeless(homeless, placeWords(created))
  await setJournalItem(tx, created.id)
  const handles = await moveFiles(tx, model, item, created, slots, places, actor)
  await tx.execute(sql`
    INSERT INTO provenance (model_id, relation, child_item_id, parent_item_id, basis, created_by)
    VALUES (${model.id}::uuid, 'split_from', ${created.id}::uuid, ${item.id}::uuid, 'manual',
            ${actor.id}::uuid)`)
  const words = `${created.publicId} из ${publicIdOfRow(item)}`
  const after = { Файлы: movedWords(handles) }
  await logItemAction(tx, model, created, { subject: words, after })
  await setJournalItem(tx, item.id)
  await touchItem(tx, model, item)
  await logItemAction(tx, model, item, { subject: words, after })
  return created.publicId
}

const movedWords = (handles: ReadonlyMap<string, string>) =>
  [...handles].map(([from, to]) => (from === to ? from : `${from} → ${to}`)).join(', ')

/**
 * «Перенести в…»: the picked files go to an existing object of the model, of any type, with the
 * next numbers of its roles; a file that has no place there refuses the command. Everything may
 * go — the empty object stays for «Удалить» or «Слить».
 */
export async function moveFilesTo(
  tx: Tx,
  model: ModelScope,
  id: string,
  keys: readonly string[],
  into: string,
  ctx: RequestContext,
  actor: Actor,
): Promise<{ moved: number; left: number }> {
  const locked = await lockItems(tx, model, [id, into])
  const item = locked.get(id)
  const other = locked.get(into)
  if (!item || !other) throw new Error('locked items vanished')
  await setJournalItem(tx, item.id)
  await checkItemVersion(tx, ctx, item)
  if (item.id === other.id) throw new ApiProblem('invalid_request', 'Файлы уже в этом объекте')
  const { all, picked } = await pickFiles(tx, model, item, keys)
  requireMasterStays(picked, all)
  const to = targetOf(other)
  const slots = await slotsOf(tx, model, other.id)
  const { places, homeless } = placesIn(to, slots, picked)
  refuseHomeless(homeless, placeWords(to))
  await setJournalItem(tx, other.id)
  const handles = await moveFiles(tx, model, item, to, slots, places, actor)
  const words = `${publicIdOfRow(item)} → ${to.publicId}`
  const after = { Файлы: movedWords(handles) }
  await touchItem(tx, model, other)
  await logItemAction(tx, model, other, { subject: words, after })
  await setJournalItem(tx, item.id)
  await touchItem(tx, model, item)
  await logItemAction(tx, model, item, { subject: words, after })
  return { moved: places.length, left: all.length - places.length }
}
