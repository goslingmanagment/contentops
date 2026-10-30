import { randomBytes, randomUUID } from 'node:crypto'
import type { PpvKind } from '@contentops/contracts/domain/catalog'
import { formatItemId, type ItemId, type ItemType } from '@contentops/contracts/domain/item-type'
import {
  type Actor,
  type Db,
  logAction,
  SYSTEM_ACTOR,
  setJournalItem,
  type Tx,
  withActorTx,
} from '@contentops/db'
import { sql } from 'drizzle-orm'
import { type DbItemType, dbType } from '../catalog/ids'
import { claimNumber, issueNumber } from '../catalog/numbers'

/**
 * Objects of the catalog as the product leaves them after acceptance (schema §5): numbers
 * from `id_counters`, files with versions over blob rows, memberships with roles and
 * handles, aliases, provenance, tags and markup fields with their states — all in one
 * transaction with the journal context, one `action` row per object.
 *
 * Test and dev only (PLAN 2а: «До приёмки (2в) объекты заводят тестовые фикстуры»): in the
 * product an object is created only by accepting a draft, a `PRM`, a split or a type change.
 * Blobs get random hashes unless a test gives real ones; no bytes are written.
 */

export type FixtureRole = 'master' | 'teaser' | 'pic' | 'raw' | 'ed' | 'clip' | 'thumb'

export interface FixtureFile {
  role: FixtureRole
  /** `pic07`; ordinal roles are numbered 1… per role in the given order when omitted. */
  ordinal?: number
  /** A unique FYP version `uN`: an asset of its own with a level (naming §3). */
  variant?: number
  uniqLevel?: 'soft' | 'trim' | 'mirror'
  /** By role when omitted: master, teaser and clip are videos. */
  media?: 'video' | 'image'
  /** Number of versions; the last one is current. */
  versions?: number
  durationS?: number
  width?: number
  height?: number
  bytes?: number
  /** Real bytes' hash and type; a random hash otherwise. One per version, oldest first. */
  sha256?: readonly Buffer[]
  mime?: string
  ext?: string
  selected?: boolean
  lifeUse?: 'feed' | 'chats' | 'both' | null
  /** Chronology of the current version (a master), by seconds. */
  chronology?: readonly { atS: number; text: string }[]
  /**
   * When the file appeared in the source (`remote_created_at` of a disk revision): every
   * version gets a source revision of the model's fixture disk. No source when omitted.
   */
  arrivedAt?: string
}

export type FixtureField =
  | 'title'
  | 'title_en'
  | 'description'
  | 'tags'
  | 'chronology'
  | 'platform_texts'

export type AliasKind =
  | 'legacy_path'
  | 'legacy_name'
  | 'legacy_id'
  | 'sub_handle'
  | 'merged_id'
  | 'vault_album'
  | 'registry_row'

export interface FixtureItem {
  type: ItemType
  /** Explicit number (the counter moves past it); the next number of the counter otherwise. */
  number?: number
  title?: string | null
  titleEn?: string | null
  description?: string | null
  ppvKind?: PpvKind
  rawPurpose?: 'fyp' | 'ppv' | 'mass_dm' | 'unknown'
  /** Code of the promo channel of a `PRM`; created when the model has none. */
  promoChannel?: string
  nameInMedia?: 'yes' | 'no' | 'unknown'
  /** `null` — «не проверено», as legacy import leaves it. */
  secondPerson?: boolean | null
  shotOn?: string
  /** When it arrived: the catalog's «приехало» without a source. */
  createdAt?: string
  tags?: readonly string[]
  /** Filled fields confirmed at once; the rest stay drafts (as import leaves them). */
  confirmed?: readonly FixtureField[] | 'all'
  platformTexts?: { wall: string; message: string }
  files?: readonly FixtureFile[]
  aliases?: readonly { kind: AliasKind; value: string }[]
  /** Files of other objects a `PRM` collection points at: `{ item: 'PPV-073', handle: 'teaser' }`. */
  references?: readonly { item: ItemId; handle: string }[]
}

export interface CreatedFile {
  assetId: string
  membershipId: string
  /** Oldest first; the last one is current. */
  versionIds: string[]
}

export interface CreatedItem {
  id: ItemId
  uid: string
  type: ItemType
  files: Map<string, CreatedFile>
}

const ORDINAL_ROLES = new Set<FixtureRole>(['pic', 'raw', 'ed', 'clip'])
const VIDEO_ROLES = new Set<FixtureRole>(['master', 'teaser', 'clip'])

export const FIXTURE_ACTOR: Actor = SYSTEM_ACTOR('фикстуры')

async function modelIdOf(tx: Tx, code: string): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`SELECT id FROM models WHERE code = ${code}`)
  const row = rows[0]
  if (!row) throw new Error(`fixtures: no model ${code}`)
  return row.id
}

async function channelId(tx: Tx, modelId: string, code: string): Promise<string> {
  await tx.execute(sql`
    INSERT INTO promo_channels (model_id, code, title) VALUES (${modelId}::uuid, ${code}, ${code})
    ON CONFLICT (model_id, code) DO NOTHING`)
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM promo_channels WHERE model_id = ${modelId}::uuid AND code = ${code}`)
  return rows[0]?.id ?? ''
}

/** A revision of a file on the model's fixture disk that appeared at `at`. */
async function sourceRevision(tx: Tx, modelId: string, at: string, bytes: number) {
  await tx.execute(sql`
    INSERT INTO sources (model_id, kind, label, root_path, credentials_ref)
    VALUES (${modelId}::uuid, 'yandex_disk', 'fixtures', '/', 'FIXTURES_DISK')
    ON CONFLICT (model_id, label) DO NOTHING`)
  const objectId = randomUUID()
  const revisionId = randomUUID()
  await tx.execute(sql`
    INSERT INTO source_objects (model_id, id, source_id, resource_id, current_path, current_name)
    SELECT ${modelId}::uuid, ${objectId}::uuid, id, ${objectId}, ${`/fixtures/${objectId}`},
           ${objectId}
      FROM sources WHERE model_id = ${modelId}::uuid AND label = 'fixtures'`)
  await tx.execute(sql`
    INSERT INTO source_revisions (model_id, id, source_object_id, sequence_no, byte_size,
                                  remote_created_at, detected_at)
    VALUES (${modelId}::uuid, ${revisionId}::uuid, ${objectId}::uuid, 1, ${bytes},
            ${at}::timestamptz, now())`)
  return revisionId
}

async function insertBlob(tx: Tx, file: FixtureFile, sha256: Buffer, bytes: number) {
  const video = (file.media ?? (VIDEO_ROLES.has(file.role) ? 'video' : 'image')) === 'video'
  const hex = sha256.toString('hex')
  await tx.execute(sql`
    INSERT INTO blobs (sha256, byte_size, mime, ext, media_kind, storage_key)
    VALUES (${sha256}, ${bytes}, ${file.mime ?? (video ? 'video/mp4' : 'image/jpeg')},
            ${file.ext ?? (video ? 'mp4' : 'jpg')}, ${video ? 'video' : 'image'},
            ${`blobs/sha256/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`})
    ON CONFLICT (sha256) DO NOTHING`)
}

function defaults(type: DbItemType, file: FixtureFile) {
  const video = (file.media ?? (VIDEO_ROLES.has(file.role) ? 'video' : 'image')) === 'video'
  const durationS = video
    ? (file.durationS ?? (file.role === 'master' ? (type === 'FYP' ? 9 : 300) : 20))
    : null
  return {
    video,
    durationS,
    width: file.width ?? (video ? 2160 : 3024),
    height: file.height ?? (video ? 3840 : 4032),
    bytes: file.bytes ?? (video ? Math.round((durationS ?? 10) * 3_900_000) : 2_400_000),
  }
}

async function insertFile(
  tx: Tx,
  modelId: string,
  item: { uid: string; type: DbItemType },
  file: FixtureFile,
  ordinal: number | null,
  position: number,
): Promise<CreatedFile> {
  const shape = defaults(item.type, file)
  const count = Math.max(1, file.versions ?? 1, file.sha256?.length ?? 0)
  const assetId = randomUUID()
  const versionIds = Array.from({ length: count }, () => randomUUID())
  const variant = file.variant ?? 0
  await tx.execute(sql`
    INSERT INTO assets (model_id, id, created_in_item_id, media_kind, current_version_id,
                        variant_kind, variant_no, uniq_level)
    VALUES (${modelId}::uuid, ${assetId}::uuid, ${item.uid}::uuid,
            ${shape.video ? 'video' : 'image'}, ${versionIds.at(-1)}::uuid,
            ${variant > 0 ? 'uniq' : 'none'}, ${variant},
            ${variant > 0 ? (file.uniqLevel ?? 'soft') : null})`)
  for (const [index, versionId] of versionIds.entries()) {
    const sha256 = file.sha256?.[index] ?? randomBytes(32)
    await insertBlob(tx, file, sha256, shape.bytes)
    const revision = file.arrivedAt
      ? await sourceRevision(tx, modelId, file.arrivedAt, shape.bytes)
      : null
    await tx.execute(sql`
      INSERT INTO asset_versions (model_id, id, asset_id, version_no, master_sha256, duration_ms,
                                  width, height, source_revision_id)
      VALUES (${modelId}::uuid, ${versionId}::uuid, ${assetId}::uuid, ${index + 1}, ${sha256},
              ${shape.durationS === null ? null : shape.durationS * 1000},
              ${shape.width}, ${shape.height}, ${revision}::uuid)`)
  }
  const membershipId = randomUUID()
  await tx.execute(sql`
    INSERT INTO item_memberships (model_id, id, item_id, item_type, asset_id, variant_no, kind,
                                  role, ordinal, display_position, selected, life_use)
    VALUES (${modelId}::uuid, ${membershipId}::uuid, ${item.uid}::uuid, ${item.type},
            ${assetId}::uuid, ${variant}, 'owned', ${file.role}, ${ordinal}, ${position},
            ${file.selected ?? false}, ${item.type === 'LIFE' ? (file.lifeUse ?? null) : null})`)
  return { assetId, membershipId, versionIds }
}

/** A tag of the shared dictionary, or a free tag of the model made on the way. */
async function tagId(tx: Tx, modelId: string, slug: string): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM tags WHERE slug = ${slug} AND (model_id IS NULL OR model_id = ${modelId}::uuid)
     ORDER BY model_id NULLS FIRST LIMIT 1`)
  if (rows[0]) return rows[0].id
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO tags (model_id, slug, label_ru) VALUES (${modelId}::uuid, ${slug}, ${slug})
    RETURNING id`)
  return inserted.rows[0]?.id ?? ''
}

async function fieldState(
  tx: Tx,
  modelId: string,
  target: { item?: string; version?: string },
  field: string,
  confirmed: boolean,
) {
  await tx.execute(sql`
    INSERT INTO annotation_fields (model_id, item_id, version_id, field, value_version,
                                   confirmed_value_version, confirmed_at)
    VALUES (${modelId}::uuid, ${target.item ?? null}::uuid, ${target.version ?? null}::uuid,
            ${field}, 1, ${confirmed ? 1 : null}, ${confirmed ? sql`now()` : null})`)
}

async function insertItem(
  tx: Tx,
  modelId: string,
  spec: FixtureItem,
  created: ReadonlyMap<ItemId, CreatedItem>,
): Promise<CreatedItem> {
  const type = dbType(spec.type)
  let number = spec.number
  if (number === undefined) number = await issueNumber(tx, modelId, type, { legacyCheck: false })
  else await claimNumber(tx, modelId, type, number)
  const uid = randomUUID()
  await setJournalItem(tx, uid)
  const channel =
    type === 'PRM' ? await channelId(tx, modelId, spec.promoChannel ?? 'reddit') : null
  await tx.execute(sql`
    INSERT INTO content_items (model_id, id, type, number, title, title_en, description, ppv_kind,
                               raw_purpose, shot_on, has_second_person, name_in_media, origin,
                               promo_channel_id, created_at, updated_at)
    VALUES (${modelId}::uuid, ${uid}::uuid, ${type}, ${number}, ${spec.title ?? null},
            ${spec.titleEn ?? null}, ${spec.description ?? null},
            ${type === 'PPV' ? (spec.ppvKind ?? 'bundle') : null},
            ${type === 'RAW' ? (spec.rawPurpose ?? 'unknown') : null}, ${spec.shotOn ?? null}::date,
            ${spec.secondPerson === undefined ? false : spec.secondPerson},
            ${type === 'CUS' ? (spec.nameInMedia ?? null) : null}, 'manual', ${channel}::uuid,
            coalesce(${spec.createdAt ?? null}::timestamptz, now()),
            coalesce(${spec.createdAt ?? null}::timestamptz, now()))`)
  const item: CreatedItem = {
    id: formatItemId(spec.type, number),
    uid,
    type: spec.type,
    files: new Map(),
  }
  const ordinals = new Map<FixtureRole, number>()
  for (const [index, file] of (spec.files ?? []).entries()) {
    let ordinal: number | null = null
    if (ORDINAL_ROLES.has(file.role)) {
      ordinal = file.ordinal ?? (ordinals.get(file.role) ?? 0) + 1
      ordinals.set(file.role, ordinal)
    }
    const made = await insertFile(tx, modelId, { uid, type }, file, ordinal, index + 1)
    const handle =
      (file.variant ?? 0) > 0
        ? `u${file.variant}`
        : ordinal === null
          ? file.role
          : `${file.role}${String(ordinal).padStart(2, '0')}`
    item.files.set(handle, made)
  }
  let position = (spec.files ?? []).length
  for (const [index, reference] of (spec.references ?? []).entries()) {
    const owner = created.get(reference.item)
    const file = owner?.files.get(reference.handle)
    if (!file) throw new Error(`fixtures: no ${reference.item}/${reference.handle} to reference`)
    const { rows } = await tx.execute<{ media_kind: string }>(sql`
      SELECT media_kind FROM assets WHERE model_id = ${modelId}::uuid AND id = ${file.assetId}::uuid`)
    position += 1
    await tx.execute(sql`
      INSERT INTO item_memberships (model_id, item_id, item_type, asset_id, kind, role, ordinal,
                                    display_position)
      VALUES (${modelId}::uuid, ${uid}::uuid, 'PRM', ${file.assetId}::uuid, 'reference',
              ${rows[0]?.media_kind === 'video' ? 'clip' : 'pic'}, ${index + 1}, ${position})`)
  }

  const confirmed = (field: FixtureField) =>
    spec.confirmed === 'all' || (spec.confirmed ?? []).includes(field)
  for (const field of ['title', 'title_en', 'description'] as const) {
    const value =
      field === 'title' ? spec.title : field === 'title_en' ? spec.titleEn : spec.description
    if (value) await fieldState(tx, modelId, { item: uid }, field, confirmed(field))
  }
  if (spec.tags && spec.tags.length > 0) {
    for (const slug of new Set(spec.tags)) {
      await tx.execute(sql`
        INSERT INTO item_tags (model_id, item_id, tag_id, source)
        VALUES (${modelId}::uuid, ${uid}::uuid, ${await tagId(tx, modelId, slug)}::uuid, 'import')`)
    }
    await fieldState(tx, modelId, { item: uid }, 'tags', confirmed('tags'))
  }
  const master = (spec.files ?? []).find((file) => file.role === 'master' && !file.variant)
  const masterVersion = item.files.get('master')?.versionIds.at(-1)
  if (master?.chronology && master.chronology.length > 0 && masterVersion) {
    for (const segment of master.chronology) {
      await tx.execute(sql`
        INSERT INTO chronology_entries (model_id, item_id, asset_version_id, at_ms, text, source)
        VALUES (${modelId}::uuid, ${uid}::uuid, ${masterVersion}::uuid, ${segment.atS * 1000},
                ${segment.text}, 'import')`)
    }
    await fieldState(tx, modelId, { version: masterVersion }, 'chronology', confirmed('chronology'))
  }
  if (spec.platformTexts && type === 'PPV') {
    const done = confirmed('platform_texts')
    for (const [variant, body] of [spec.platformTexts.wall, spec.platformTexts.message].entries()) {
      await tx.execute(sql`
        INSERT INTO platform_texts (model_id, item_id, platform, locale, variant_no, body,
                                    value_version, confirmed_value_version, confirmed_at, source)
        VALUES (${modelId}::uuid, ${uid}::uuid, 'generic', 'en', ${variant + 1}, ${body}, 1,
                ${done ? 1 : null}, ${done ? sql`now()` : null}, 'import')`)
    }
  }
  for (const alias of spec.aliases ?? []) {
    await tx.execute(sql`
      INSERT INTO aliases (model_id, kind, value_raw, item_id)
      VALUES (${modelId}::uuid, ${alias.kind}, ${alias.value}, ${uid}::uuid)`)
  }
  await logAction(tx, {
    modelId,
    subjectKind: 'content_items',
    subjectId: uid,
    subjectLabel: item.id,
    itemId: uid,
  })
  return item
}

/**
 * Creates the objects in one transaction, in order: a `PRM` may point at files of objects
 * made earlier in the same call.
 */
export async function createCatalogItems(
  db: Db,
  model: string,
  items: readonly FixtureItem[],
  actor: Actor = FIXTURE_ACTOR,
): Promise<CreatedItem[]> {
  const context = { actor, action: 'fixtures.seed', requestId: randomUUID() }
  return withActorTx(db, context, async (tx) => {
    const modelId = await modelIdOf(tx, model)
    const created = new Map<ItemId, CreatedItem>()
    for (const spec of items) {
      const item = await insertItem(tx, modelId, spec, created)
      created.set(item.id, item)
    }
    return [...created.values()]
  })
}

/** Provenance between objects: `PPV-073 ← CUS-181` is `{ child: 'PPV-073', parent: 'CUS-181' }`. */
export interface FixtureLink {
  child: ItemId
  parent: ItemId
  relation: 'montage_from' | 'ppv_from_custom' | 'extracted_from' | 'remaster_from' | 'frame_from'
  /** Not confirmed yet: ◆ «Подтвердить / Убрать». */
  suggested?: boolean
}

export async function linkCatalogItems(
  db: Db,
  model: string,
  links: readonly FixtureLink[],
): Promise<void> {
  const context = { actor: FIXTURE_ACTOR, action: 'fixtures.seed', requestId: randomUUID() }
  await withActorTx(db, context, async (tx) => {
    const modelId = await modelIdOf(tx, model)
    for (const link of links) {
      await tx.execute(sql`
        INSERT INTO provenance (model_id, relation, child_item_id, parent_item_id, basis)
        SELECT ${modelId}::uuid, ${link.relation}, child.id, parent.id,
               ${link.suggested ? 'suggested' : 'import'}
          FROM content_items child, content_items parent
         WHERE child.model_id = ${modelId}::uuid AND parent.model_id = ${modelId}::uuid
           AND public_item_id(child.type, child.number) = ${link.child}
           AND public_item_id(parent.type, parent.number) = ${link.parent}`)
    }
  })
}

/** A tombstone as «Удалить» leaves it: the object keeps its number and files. */
export async function tombstoneCatalogItem(db: Db, model: string, id: ItemId): Promise<void> {
  const context = { actor: FIXTURE_ACTOR, action: 'fixtures.seed', requestId: randomUUID() }
  await withActorTx(db, context, async (tx) => {
    const modelId = await modelIdOf(tx, model)
    await tx.execute(sql`
      UPDATE content_items SET deleted_at = now(), delete_reason = 'фикстура'
       WHERE model_id = ${modelId}::uuid AND public_item_id(type, number) = ${id}`)
  })
}
