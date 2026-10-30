import type { ConfirmMarkupCommand } from '@contentops/contracts/commands/objects'
import {
  MARKUP_FIELD_LABEL,
  type MarkupField,
  type MarkupFieldKey,
  type MarkupValue,
} from '@contentops/contracts/domain/markup'
import { formatDuration } from '@contentops/contracts/format'
import type { Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { Actor, ModelScope, RequestContext } from '../context'
import { ApiProblem } from '../errors'
import type { Snapshot } from '../journal/describe'
import { type ItemRow, publicIdOfRow } from './ids'
import { markupFields, masterVersions, SCHEMA_FIELD } from './markup'
import { logItemAction, touchItem, versionConflict } from './writes'

/**
 * Writing markup (SPEC §5): a person's edit of a field writes the value, raises the field's
 * `value_version` and confirms exactly that field; «Подтвердить всю разметку» confirms the
 * versions the person saw, a value that came later stays a draft. Each field is checked by
 * its own version (`If-Match` of the field).
 */

const FIELD_ACCUSATIVE: Record<MarkupFieldKey, string> = {
  title: 'название',
  title_en: 'английское название',
  tags: 'теги',
  description: 'описание',
  timeline: 'хронологию',
  platform_texts: 'тексты для платформы',
}

/** The value in words for «было → стало». */
function words(value: MarkupValue | undefined): string {
  if (!value) return '—'
  switch (value.key) {
    case 'tags':
      return value.value.join(', ') || '—'
    case 'timeline':
      return (
        value.value
          .map((segment) => `${formatDuration(segment.start_s)} ${segment.label}`)
          .join('; ') || '—'
      )
    case 'platform_texts':
      return value.value ? `${value.value.wall} / ${value.value.message}` : '—'
    default:
      return value.value || '—'
  }
}

async function fieldsOf(tx: Tx, model: ModelScope, item: ItemRow): Promise<MarkupField[]> {
  const fields = await markupFields(tx, model, [
    {
      uid: item.id,
      type: item.type,
      title: item.title,
      title_en: item.title_en,
      description: item.description,
    },
  ])
  return fields.get(item.id) ?? []
}

/** Raises the field's version and confirms it: the edit of a person is the confirmation. */
async function confirmEdit(
  tx: Tx,
  model: ModelScope,
  target: { item: string } | { version: string },
  field: string,
  actor: Actor,
) {
  const item = 'item' in target ? target.item : null
  const version = 'version' in target ? target.version : null
  await tx.execute(sql`
    INSERT INTO annotation_fields (model_id, item_id, version_id, field, value_version,
                                   confirmed_value_version, confirmed_at, confirmed_by,
                                   updated_by)
    VALUES (${model.id}::uuid, ${item}::uuid, ${version}::uuid, ${field}, 1, 1, now(),
            ${actor.id}::uuid, ${actor.id}::uuid)
    ON CONFLICT ON CONSTRAINT annotation_fields_target DO UPDATE
       SET value_version = annotation_fields.value_version + 1,
           confirmed_value_version = annotation_fields.value_version + 1,
           confirmed_at = now(), confirmed_by = excluded.confirmed_by,
           updated_at = now(), updated_by = excluded.updated_by`)
}

/** Keys of tags: a known tag by slug or Russian name, an unknown word becomes a free tag. */
export async function tagIds(
  tx: Tx,
  model: ModelScope,
  keys: readonly string[],
  actor: Actor,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  for (const raw of keys) {
    const key = raw.trim()
    const slug = key.toLowerCase()
    if (!slug) continue
    const { rows } = await tx.execute<{ id: string; slug: string }>(sql`
      SELECT coalesce(m.id, t.id) AS id, coalesce(m.slug, t.slug) AS slug FROM tags t
        LEFT JOIN tags m ON m.id = t.merged_into_tag_id
       WHERE (t.model_id IS NULL OR t.model_id = ${model.id}::uuid)
         AND (t.slug = ${slug} OR lower(t.label_ru) = ${slug})
       ORDER BY t.slug = ${slug} DESC, t.model_id NULLS FIRST LIMIT 1`)
    const known = rows[0]
    if (known) {
      ids.set(known.slug, known.id)
      continue
    }
    const created = await tx.execute<{ id: string }>(sql`
      INSERT INTO tags (model_id, slug, label_ru, created_by)
      VALUES (${model.id}::uuid, ${slug}, ${key}, ${actor.id}::uuid)
      ON CONFLICT ON CONSTRAINT tags_slug DO UPDATE SET slug = excluded.slug
      RETURNING id`)
    const id = created.rows[0]?.id
    if (id) ids.set(slug, id)
  }
  return ids
}

/** Adds and removes tags of one object; the result is its set of slugs. */
export async function changeTags(
  tx: Tx,
  model: ModelScope,
  item: ItemRow,
  change: { add: readonly string[]; remove: readonly string[]; replace?: boolean },
  actor: Actor,
): Promise<void> {
  const add = await tagIds(tx, model, change.add, actor)
  if (change.replace) {
    await tx.execute(sql`
      DELETE FROM item_tags WHERE model_id = ${model.id}::uuid AND item_id = ${item.id}::uuid
         AND NOT (tag_id = ANY(${sql.param([...add.values()])}::uuid[]))`)
  } else if (change.remove.length > 0) {
    const slugs = change.remove.map((key) => key.trim().toLowerCase())
    await tx.execute(sql`
      DELETE FROM item_tags it USING tags t
       WHERE it.model_id = ${model.id}::uuid AND it.item_id = ${item.id}::uuid
         AND t.id = it.tag_id AND (t.slug = ANY(${sql.param(slugs)}::text[])
                                   OR lower(t.label_ru) = ANY(${sql.param(slugs)}::text[]))`)
  }
  for (const id of add.values()) {
    await tx.execute(sql`
      INSERT INTO item_tags (model_id, item_id, tag_id, source, added_by)
      VALUES (${model.id}::uuid, ${item.id}::uuid, ${id}::uuid, 'human', ${actor.id}::uuid)
      ON CONFLICT (model_id, item_id, tag_id) DO NOTHING`)
  }
  await confirmEdit(tx, model, { item: item.id }, 'tags', actor)
}

async function writePlatformTexts(
  tx: Tx,
  model: ModelScope,
  item: ItemRow,
  value: { wall: string; message: string } | null,
  actor: Actor,
) {
  for (const [index, body] of [value?.wall ?? null, value?.message ?? null].entries()) {
    await tx.execute(sql`
      INSERT INTO platform_texts (model_id, item_id, platform, locale, variant_no, body,
                                  value_version, confirmed_value_version, confirmed_at,
                                  confirmed_by, source, updated_by)
      VALUES (${model.id}::uuid, ${item.id}::uuid, 'generic', 'en', ${index + 1}, ${body}, 1, 1,
              now(), ${actor.id}::uuid, 'human', ${actor.id}::uuid)
      ON CONFLICT ON CONSTRAINT platform_texts_variant DO UPDATE
         SET body = excluded.body, value_version = platform_texts.value_version + 1,
             confirmed_value_version = platform_texts.value_version + 1, confirmed_at = now(),
             confirmed_by = excluded.confirmed_by, source = 'human', updated_at = now(),
             updated_by = excluded.updated_by`)
  }
}

/** `PATCH …/i/<ID>/fields/<field>` with the field's `If-Match`. */
export async function updateField(
  tx: Tx,
  ctx: RequestContext,
  model: ModelScope,
  item: ItemRow,
  key: string,
  value: MarkupValue,
  actor: Actor,
): Promise<void> {
  if (value.key !== key) {
    throw new ApiProblem('invalid_request', 'Поле в адресе и в теле не совпадают', { field: key })
  }
  const field = (await fieldsOf(tx, model, item)).find((candidate) => candidate.field.key === key)
  if (!field) {
    throw new ApiProblem(
      'invalid_request',
      key === 'timeline' ? 'Хронология — у ролика с мастером' : 'Этого поля у объекта нет',
      { field: key },
    )
  }
  if (ctx.ifMatch === null) {
    throw new ApiProblem('precondition_required', 'Нужна версия поля (If-Match)')
  }
  if (ctx.ifMatch !== field.version) {
    throw await versionConflict(tx, item, MARKUP_FIELD_LABEL[value.key], field.version, field.field)
  }
  switch (value.key) {
    case 'title':
    case 'title_en':
    case 'description': {
      const text = value.value.trim() || null
      const column = sql.identifier(value.key)
      await tx.execute(sql`
        UPDATE content_items SET ${column} = ${text}
         WHERE model_id = ${model.id}::uuid AND id = ${item.id}::uuid`)
      await confirmEdit(tx, model, { item: item.id }, SCHEMA_FIELD[value.key], actor)
      break
    }
    case 'tags':
      await changeTags(tx, model, item, { add: value.value, remove: [], replace: true }, actor)
      break
    case 'timeline': {
      const master = (await masterVersions(tx, model, [item.id])).get(item.id)
      if (!master) throw new ApiProblem('invalid_request', 'Хронология — у ролика с мастером')
      await tx.execute(sql`
        DELETE FROM chronology_entries
         WHERE model_id = ${model.id}::uuid AND asset_version_id = ${master.version_id}::uuid`)
      const segments = [...new Map(value.value.map((s) => [s.start_s, s])).values()]
      for (const segment of segments) {
        await tx.execute(sql`
          INSERT INTO chronology_entries (model_id, item_id, asset_version_id, at_ms, text, source,
                                          created_by)
          VALUES (${model.id}::uuid, ${item.id}::uuid, ${master.version_id}::uuid,
                  ${Math.round(segment.start_s * 1000)}, ${segment.label}, 'human',
                  ${actor.id}::uuid)`)
      }
      await confirmEdit(tx, model, { version: master.version_id }, 'chronology', actor)
      break
    }
    case 'platform_texts':
      await writePlatformTexts(tx, model, item, value.value, actor)
      break
  }
  await touchItem(tx, model, item)
  const label = MARKUP_FIELD_LABEL[value.key]
  await logItemAction(tx, model, item, {
    subject: `${FIELD_ACCUSATIVE[value.key]} ${publicIdOfRow(item)}`,
    before: { [label]: words(field.field) } satisfies Snapshot,
    after: { [label]: words(value) },
  })
}

/** «Подтвердить всю разметку»: only the fields whose seen version is still the current one. */
export async function confirmMarkup(
  tx: Tx,
  model: ModelScope,
  item: ItemRow,
  command: ConfirmMarkupCommand,
  actor: Actor,
): Promise<number> {
  const fields = await fieldsOf(tx, model, item)
  const master = (await masterVersions(tx, model, [item.id])).get(item.id)
  let confirmed = 0
  for (const seen of command.fields) {
    const field = fields.find((candidate) => candidate.field.key === seen.key)
    if (!field || field.version !== seen.version) continue
    if (field.status === 'confirmed' || field.status === 'empty') continue
    const valueVersion = seen.version - 1
    if (seen.key === 'platform_texts') {
      await tx.execute(sql`
        UPDATE platform_texts
           SET confirmed_value_version = value_version, confirmed_at = now(),
               confirmed_by = ${actor.id}::uuid
         WHERE model_id = ${model.id}::uuid AND item_id = ${item.id}::uuid
           AND platform = 'generic' AND account_id IS NULL AND locale = 'en'`)
    } else {
      await tx.execute(sql`
        INSERT INTO annotation_fields (model_id, item_id, version_id, field, value_version,
                                       confirmed_value_version, confirmed_at, confirmed_by)
        SELECT ${model.id}::uuid,
               ${seen.key === 'timeline' ? null : item.id}::uuid,
               ${seen.key === 'timeline' ? (master?.version_id ?? null) : null}::uuid,
               ${SCHEMA_FIELD[seen.key]}, ${valueVersion}, ${valueVersion}, now(),
               ${actor.id}::uuid
        ON CONFLICT ON CONSTRAINT annotation_fields_target DO UPDATE
           SET confirmed_value_version = annotation_fields.value_version, confirmed_at = now(),
               confirmed_by = excluded.confirmed_by
         WHERE annotation_fields.value_version = ${valueVersion}`)
    }
    confirmed += 1
  }
  if (confirmed > 0) {
    await touchItem(tx, model, item)
    await logItemAction(tx, model, item, {
      subject: publicIdOfRow(item),
      after: { Подтверждено: `${confirmed}` },
    })
  }
  return confirmed
}
