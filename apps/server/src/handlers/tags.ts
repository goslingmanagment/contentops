import { TAG_GROUP_LABEL, type Tag } from '@contentops/contracts/domain/markup'
import { logAction, type Queryable, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { lastChange, requireActor } from '../commands'
import type { Actor, RequestContext } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { orderedFields } from '../journal/describe'
import type { Services } from '../services'

/**
 * The tag dictionary (SPEC §8.3, schema §3.2): shared known tags with their group, and free
 * tags of each model, visible only to those who see the model. `uses` counts live objects.
 * The dictionary has no version column: the version of a tag is the number of its changes
 * in the journal plus one, so «Настройки › Теги» changes go with `If-Match` all the same.
 */

export interface TagRow extends Record<string, unknown> {
  id: string
  model_id: string | null
  slug: string
  label_ru: string
  tag_group: Tag['group']
  uses: number
  changes: number
}

/** Models whose free tags the actor sees: every model for the owner. */
function visibleModels(actor: Actor) {
  return actor.role === 'owner'
    ? sql`SELECT id FROM models`
    : sql`SELECT id FROM models WHERE code = ANY(${sql.param([...actor.models])}::text[])`
}

export async function tagRows(q: Queryable, actor: Actor, slug?: string): Promise<TagRow[]> {
  const { rows } = await q.execute<TagRow>(sql`
    SELECT t.id, t.model_id, t.slug, t.label_ru, t.tag_group,
           (SELECT count(*)::int FROM item_tags it
              JOIN content_items i ON i.model_id = it.model_id AND i.id = it.item_id
             WHERE it.tag_id = t.id AND i.deleted_at IS NULL
               AND it.model_id IN (${visibleModels(actor)})) AS uses,
           (SELECT count(*)::int FROM action_log a
             WHERE a.subject_kind = 'tags' AND a.subject_id = t.id AND a.entry_kind = 'action'
               AND a.result = 'ok') AS changes
      FROM tags t
     WHERE t.merged_into_tag_id IS NULL
       AND (t.model_id IS NULL OR t.model_id IN (${visibleModels(actor)}))
       ${slug === undefined ? sql`` : sql`AND t.slug = ${slug}`}
     ORDER BY t.model_id NULLS FIRST, t.slug`)
  return rows
}

/** A free tag without a Russian name keeps its slug as the label (`label_ru` is NOT NULL). */
export function tagOf(row: TagRow): Tag {
  return {
    key: row.slug,
    ru: row.label_ru === row.slug ? null : row.label_ru,
    group: row.tag_group,
    uses: row.uses,
    version: row.changes + 1,
  }
}

/** One line per slug: a free tag named the same in two models is one word of the dictionary. */
export function dictionary(rows: readonly TagRow[]): Tag[] {
  const bySlug = new Map<string, Tag>()
  for (const row of rows) {
    const known = bySlug.get(row.slug)
    if (known) known.uses += row.uses
    else bySlug.set(row.slug, tagOf(row))
  }
  return [...bySlug.values()]
}

async function lockedTag(tx: Tx, actor: Actor, slug: string): Promise<TagRow[]> {
  const rows = await tagRows(tx, actor, slug)
  if (rows.length === 0) throw new ApiProblem('not_found', 'Такого тега нет')
  await tx.execute(sql`
    SELECT 1 FROM tags WHERE id = ANY(${sql.param(rows.map((row) => row.id))}::uuid[]) FOR UPDATE`)
  return rows
}

function groupWords(group: Tag['group']): string {
  return group ? TAG_GROUP_LABEL[group] : 'без группы'
}

/** «Настройки › Теги»: the Russian name and the group, by the tag's version. */
async function updateTag(
  tx: Tx,
  ctx: RequestContext,
  actor: Actor,
  slug: string,
  change: { ru?: string | null; group?: Tag['group'] },
): Promise<Tag> {
  const rows = await lockedTag(tx, actor, slug)
  const [first] = rows
  if (!first) throw new ApiProblem('not_found', 'Такого тега нет')
  const current = tagOf(first)
  if (ctx.ifMatch === null) {
    throw new ApiProblem('precondition_required', 'Нужна версия записи (If-Match)')
  }
  if (ctx.ifMatch !== current.version) {
    throw new ApiProblem('version_mismatch', 'Тег уже изменили', {
      ...(await lastChange(tx, 'tags', first.id)),
      field: 'тег',
      current_version: current.version,
      current_value: current,
    })
  }
  const label = change.ru === undefined ? first.label_ru : (change.ru ?? slug)
  const group = change.group === undefined ? first.tag_group : change.group
  for (const row of rows) {
    await tx.execute(sql`
      UPDATE tags SET label_ru = ${label}, tag_group = ${group} WHERE id = ${row.id}::uuid`)
    await logAction(tx, {
      modelId: row.model_id,
      subjectKind: 'tags',
      subjectId: row.id,
      subjectLabel: slug,
      before: orderedFields({ Название: first.label_ru, Группа: groupWords(first.tag_group) }),
      after: orderedFields({ Название: label, Группа: groupWords(group) }),
    })
  }
  return dictionary(await tagRows(tx, actor, slug))[0] as Tag
}

/** «Слить с…»: objects of the tag get `into`, the tag stays as a pointer to it. */
async function mergeTag(tx: Tx, actor: Actor, slug: string, into: string): Promise<Tag> {
  if (slug === into) throw new ApiProblem('invalid_request', 'Тег не сливается сам с собой')
  const sources = await lockedTag(tx, actor, slug)
  const targets = await lockedTag(tx, actor, into)
  for (const source of sources) {
    const target = targets.find(
      (candidate) => candidate.model_id === null || candidate.model_id === source.model_id,
    )
    if (!target) {
      throw new ApiProblem('invalid_request', 'Свободный тег одной модели не принимает чужие теги')
    }
    await tx.execute(sql`
      INSERT INTO item_tags (model_id, item_id, tag_id, source, added_by)
      SELECT model_id, item_id, ${target.id}::uuid, source, ${actor.id}::uuid FROM item_tags
       WHERE tag_id = ${source.id}::uuid
      ON CONFLICT (model_id, item_id, tag_id) DO NOTHING`)
    await tx.execute(sql`DELETE FROM item_tags WHERE tag_id = ${source.id}::uuid`)
    await tx.execute(sql`
      UPDATE tags SET merged_into_tag_id = ${target.id}::uuid WHERE id = ${source.id}::uuid`)
    await logAction(tx, {
      modelId: source.model_id,
      subjectKind: 'tags',
      subjectId: source.id,
      subjectLabel: `${slug} → ${into}`,
    })
  }
  return dictionary(await tagRows(tx, actor, into))[0] as Tag
}

export function tagHandlers({ db, command }: Services): HandlerRegistry {
  return {
    admin: {
      tags: async ({ ctx }) => ({
        items: dictionary(await tagRows(db, requireActor(ctx))),
        next_cursor: null,
      }),
    },
    settings: {
      updateTag: ({ params, body, ctx }) =>
        command({ ctx, body }, (tx, actor) => updateTag(tx, ctx, actor, params.tag, body)),
      mergeTag: ({ params, body, ctx }) =>
        command({ ctx, body }, (tx, actor) => mergeTag(tx, actor, params.tag, body.into)),
    },
  }
}
