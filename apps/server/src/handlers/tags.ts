import type { Tag } from '@contentops/contracts/domain/markup'
import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { requireActor } from '../commands'
import type { Actor } from '../context'
import type { HandlerRegistry } from '../handlers'
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

export function tagHandlers({ db }: Services): HandlerRegistry {
  return {
    admin: {
      tags: async ({ ctx }) => ({
        items: dictionary(await tagRows(db, requireActor(ctx))),
        next_cursor: null,
      }),
    },
  }
}
