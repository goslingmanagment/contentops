import type {
  FieldStatus,
  MarkupField,
  MarkupFieldKey,
  MarkupValue,
} from '@contentops/contracts/domain/markup'
import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { instant } from '../commands'
import type { ModelScope } from '../context'
import type { DbItemType } from './ids'

/**
 * Markup fields of an object with their own status and version (SPEC §5, schema §3.2).
 * Statuses live in `annotation_fields`: `confirmed` ⇔ the confirmed version is the current
 * one. The version on the wire is `value_version + 1` (the schema starts at 0, «подтверждено
 * пустым»; the contract's versions are positive). Chronology belongs to the current version
 * of the master; selling texts to PPV.
 */

/** Field names of the schema for the keys of the contract. */
export const SCHEMA_FIELD: Record<MarkupFieldKey, string> = {
  title: 'title',
  title_en: 'title_en',
  tags: 'tags',
  description: 'description',
  timeline: 'chronology',
  platform_texts: 'platform_texts',
}

export interface MarkupTarget {
  /** `content_items.id`. */
  uid: string
  type: DbItemType
  title: string | null
  title_en: string | null
  description: string | null
}

export interface FieldState extends Record<string, unknown> {
  id: string
  item_id: string | null
  version_id: string | null
  field: string
  value_version: number
  confirmed_value_version: number | null
  confirmed_at: string | null
  confirmed_by: string | null
}

export interface MasterVersion extends Record<string, unknown> {
  item_id: string
  asset_id: string
  version_id: string
}

/** The current version of the master of each object (`master`, base file, not `uN`). */
export async function masterVersions(
  q: Queryable,
  model: ModelScope,
  itemIds: readonly string[],
): Promise<Map<string, MasterVersion>> {
  if (itemIds.length === 0) return new Map()
  const { rows } = await q.execute<MasterVersion>(sql`
    SELECT im.item_id, a.id AS asset_id, a.current_version_id AS version_id
      FROM item_memberships im
      JOIN assets a ON a.model_id = im.model_id AND a.id = im.asset_id
     WHERE im.model_id = ${model.id}::uuid AND im.item_id = ANY(${sql.param([...itemIds])}::uuid[])
       AND im.kind = 'owned' AND im.role = 'master' AND im.variant_no = 0
       AND im.removed_at IS NULL`)
  return new Map(rows.map((row) => [row.item_id, row]))
}

function statusOf(state: FieldState | undefined, filled: boolean): FieldStatus {
  if (state && state.confirmed_value_version === state.value_version) return 'confirmed'
  return filled ? 'draft_import' : 'empty'
}

function fieldOf(
  value: MarkupValue,
  state: FieldState | undefined,
  filled: boolean,
  names: ReadonlyMap<string, string>,
  status: FieldStatus = statusOf(state, filled),
): MarkupField {
  const confirmed = status === 'confirmed' || status === 'confirmed_previous_version'
  return {
    field: value,
    status,
    version: (state?.value_version ?? 0) + 1,
    confirmed_by:
      confirmed && state?.confirmed_by ? (names.get(state.confirmed_by) ?? 'Система') : null,
    confirmed_at: confirmed && state?.confirmed_at ? instant(state.confirmed_at) : null,
    source_hint: null,
  }
}

interface PlatformTextRow extends Record<string, unknown> {
  item_id: string
  variant_no: number
  body: string | null
  value_version: number
  confirmed_value_version: number | null
  confirmed_at: string | null
  confirmed_by: string | null
}

interface ChronologyRow extends Record<string, unknown> {
  asset_version_id: string
  at_ms: number
  text: string
}

/** Markup of several objects at once: «Разметка на проверку» and the object page. */
export async function markupFields(
  q: Queryable,
  model: ModelScope,
  targets: readonly MarkupTarget[],
): Promise<Map<string, MarkupField[]>> {
  const result = new Map<string, MarkupField[]>()
  if (targets.length === 0) return result
  const uids = targets.map((target) => target.uid)
  const masters = await masterVersions(q, model, uids)
  const masterIds = [...masters.values()].map((master) => master.version_id)
  const assetIds = [...masters.values()].map((master) => master.asset_id)
  const [states, tags, chronology, texts] = await Promise.all([
    q.execute<FieldState & { asset_id: string | null }>(sql`
      SELECT f.id, f.item_id, f.version_id, v.asset_id, f.field, f.value_version::int AS value_version,
             f.confirmed_value_version::int AS confirmed_value_version,
             f.confirmed_at::text AS confirmed_at, f.confirmed_by
        FROM annotation_fields f
        LEFT JOIN asset_versions v ON v.model_id = f.model_id AND v.id = f.version_id
       WHERE f.model_id = ${model.id}::uuid
         AND (f.item_id = ANY(${sql.param(uids)}::uuid[])
              OR v.asset_id = ANY(${sql.param(assetIds)}::uuid[]))`),
    q.execute<{ item_id: string; slugs: string[] }>(sql`
      SELECT it.item_id, array_agg(DISTINCT coalesce(m.slug, t.slug)
                                   ORDER BY coalesce(m.slug, t.slug)) AS slugs
        FROM item_tags it JOIN tags t ON t.id = it.tag_id
        LEFT JOIN tags m ON m.id = t.merged_into_tag_id
       WHERE it.model_id = ${model.id}::uuid AND it.item_id = ANY(${sql.param(uids)}::uuid[])
       GROUP BY it.item_id`),
    q.execute<ChronologyRow>(sql`
      SELECT asset_version_id, at_ms::float8 AS at_ms, text FROM chronology_entries
       WHERE model_id = ${model.id}::uuid
         AND asset_version_id = ANY(${sql.param(masterIds)}::uuid[])
       ORDER BY at_ms`),
    q.execute<PlatformTextRow>(sql`
      SELECT item_id, variant_no, body, value_version::int AS value_version,
             confirmed_value_version::int AS confirmed_value_version,
             confirmed_at::text AS confirmed_at, confirmed_by
        FROM platform_texts
       WHERE model_id = ${model.id}::uuid AND item_id = ANY(${sql.param(uids)}::uuid[])
         AND platform = 'generic' AND account_id IS NULL AND locale = 'en'
         AND variant_no IN (1, 2)`),
  ])
  const people = new Set<string>()
  for (const row of [...states.rows, ...texts.rows]) {
    if (row.confirmed_by) people.add(row.confirmed_by)
  }
  const names = await principalNames(q, [...people])
  const tagsOf = new Map(tags.rows.map((row) => [row.item_id, row.slugs]))

  for (const target of targets) {
    const own = (field: string) =>
      states.rows.find((row) => row.item_id === target.uid && row.field === field)
    const title = target.title ?? ''
    const titleEn = target.title_en ?? ''
    const description = target.description ?? ''
    const slugs = tagsOf.get(target.uid) ?? []
    const fields: MarkupField[] = [
      fieldOf({ key: 'title', value: title }, own('title'), title !== '', names),
      fieldOf({ key: 'title_en', value: titleEn }, own('title_en'), titleEn !== '', names),
      fieldOf({ key: 'tags', value: slugs }, own('tags'), slugs.length > 0, names),
      fieldOf(
        { key: 'description', value: description },
        own('description'),
        description !== '',
        names,
      ),
    ]
    const master = masters.get(target.uid)
    if (master) {
      const segments = chronology.rows
        .filter((row) => row.asset_version_id === master.version_id)
        .map((row) => ({ start_s: Math.round(row.at_ms / 1000), label: row.text }))
      const ofMaster = states.rows.filter(
        (row) => row.field === 'chronology' && row.asset_id === master.asset_id,
      )
      const current = ofMaster.find((row) => row.version_id === master.version_id)
      let status = statusOf(current, segments.length > 0)
      const earlier = ofMaster.find(
        (row) =>
          row.version_id !== master.version_id && row.confirmed_value_version === row.value_version,
      )
      if (status !== 'confirmed' && earlier) status = 'confirmed_previous_version'
      fields.push(
        fieldOf(
          { key: 'timeline', value: segments },
          status === 'confirmed_previous_version' ? earlier : current,
          segments.length > 0,
          names,
          status,
        ),
      )
    }
    if (target.type === 'PPV') fields.push(platformTextsField(target.uid, texts.rows, names))
    result.set(target.uid, fields)
  }
  return result
}

/** Two English texts of a PPV: `generic/en/1` for the wall, `generic/en/2` for messages. */
function platformTextsField(
  uid: string,
  rows: readonly PlatformTextRow[],
  names: ReadonlyMap<string, string>,
): MarkupField {
  const wall = rows.find((row) => row.item_id === uid && row.variant_no === 1)
  const message = rows.find((row) => row.item_id === uid && row.variant_no === 2)
  const filled = Boolean(wall?.body || message?.body)
  const value = wall || message ? { wall: wall?.body ?? '', message: message?.body ?? '' } : null
  const state: FieldState | undefined = wall
    ? {
        id: uid,
        item_id: uid,
        version_id: null,
        field: 'platform_texts',
        value_version: wall.value_version,
        confirmed_value_version:
          wall.confirmed_value_version === wall.value_version &&
          (!message || message.confirmed_value_version === message.value_version)
            ? wall.confirmed_value_version
            : null,
        confirmed_at: wall.confirmed_at,
        confirmed_by: wall.confirmed_by,
      }
    : undefined
  return fieldOf({ key: 'platform_texts', value }, state, filled, names)
}

export async function principalNames(
  q: Queryable,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const { rows } = await q.execute<{ id: string; name: string }>(sql`
    SELECT id, display_name AS name FROM principals
     WHERE id = ANY(${sql.param([...new Set(ids)])}::uuid[])`)
  return new Map(rows.map((row) => [row.id, row.name]))
}
