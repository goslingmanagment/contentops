import type { CheckSuggestion } from '@contentops/contracts/domain/check'
import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { publicIdOf } from '../../catalog/ids'
import type { PostCase } from './cases'

/**
 * «по именам файлов: SET-046 · 15 из 15» (SPEC §7): a post without plan made by hand with the
 * original files of the disk (`IMG_0478.JPG` there, `IMG_0478.jpeg` on the platform) is not
 * exact by name, yet its files carry the source names of an object's files. Names are compared
 * by stem — without extension, case-insensitive. A suggestion needs two matched files, or the
 * only file of the post: a camera counter repeats across shoots, one name of many proves nothing.
 */

const MAX = 3

/** `IMG_0478.JPG` → `img_0478`; the same in SQL is `stemSql`. */
export function stemOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return (dot >= 0 ? name.slice(0, dot) : name).toLowerCase()
}

/** Without a regular expression: `left` and `strpos` cost little over every path of a model. */
const stemSql = (column: string) =>
  sql.raw(`lower(left(${column}, length(${column}) - strpos(reverse(${column}), '.')))`)

interface StemRow extends Record<string, unknown> {
  stem: string
  type: string
  number: number
  title: string | null
}

/**
 * Objects holding a file with each stem: live objects, memberships not removed. The source name
 * of a file is any path of the source object of any version of its asset; a file uploaded through
 * the web keeps the name it was uploaded with. One query for the whole list.
 */
async function objectsByStem(
  q: Queryable,
  modelId: string,
  stems: readonly string[],
): Promise<Map<string, { itemId: string; title: string; stems: Set<string> }>> {
  const wanted = sql`${sql.param([...stems])}::text[]`
  const { rows } = await q.execute<StemRow>(sql`
    WITH named AS (
      SELECT ${stemSql('p.name')} AS stem, v.asset_id
        FROM source_paths p
        JOIN source_revisions r ON r.model_id = p.model_id AND r.source_object_id = p.source_object_id
        JOIN asset_versions v ON v.model_id = r.model_id AND v.source_revision_id = r.id
       WHERE p.model_id = ${modelId}::uuid
         AND ${stemSql('p.name')} = ANY (${wanted})
      UNION
      SELECT ${stemSql('u.client_filename')} AS stem, v.asset_id
        FROM web_uploads u
        JOIN inbox_drafts d ON d.model_id = u.model_id AND d.web_upload_id = u.id
        JOIN asset_versions v ON v.model_id = d.model_id AND v.id = d.applied_version_id
       WHERE u.model_id = ${modelId}::uuid
         AND ${stemSql('u.client_filename')} = ANY (${wanted})
    )
    SELECT DISTINCT n.stem, i.type, i.number, i.title
      FROM named n
      JOIN item_memberships m ON m.model_id = ${modelId}::uuid AND m.asset_id = n.asset_id
                             AND m.removed_at IS NULL
      JOIN content_items i ON i.model_id = m.model_id AND i.id = m.item_id AND i.deleted_at IS NULL`)
  const out = new Map<string, { itemId: string; title: string; stems: Set<string> }>()
  for (const row of rows) {
    const itemId = publicIdOf(row.type, row.number)
    const entry = out.get(itemId) ?? { itemId, title: row.title ?? '', stems: new Set<string>() }
    entry.stems.add(row.stem)
    out.set(itemId, entry)
  }
  return out
}

/** Suggestions of every post without plan of the list, by post id. */
export async function suggestByNames(
  q: Queryable,
  modelId: string,
  cases: readonly PostCase[],
): Promise<Map<string, CheckSuggestion[]>> {
  const out = new Map<string, CheckSuggestion[]>()
  const posts = cases
    .filter((one) => one.kind === 'unplanned')
    .map((one) => ({
      id: one.post.id,
      stems: one.post.mains.map((file) => (file.filename ? stemOf(file.filename) : null)),
    }))
    .filter((post) => post.stems.some(Boolean))
  const stems = new Set(
    posts.flatMap((post) => post.stems.filter((stem): stem is string => !!stem)),
  )
  if (stems.size === 0) return out
  const objects = [...(await objectsByStem(q, modelId, [...stems])).values()]
  if (objects.length === 0) return out
  for (const post of posts) {
    const total = post.stems.length
    const found = objects
      .map((object) => ({
        item_id: object.itemId,
        title: object.title,
        matched: post.stems.filter((stem) => stem !== null && object.stems.has(stem)).length,
        total,
      }))
      .filter((one) => one.matched >= 2 || (total === 1 && one.matched === 1))
      .sort(
        (left, right) => right.matched - left.matched || left.item_id.localeCompare(right.item_id),
      )
      .slice(0, MAX)
    if (found.length > 0) out.set(post.id, found)
  }
  return out
}
