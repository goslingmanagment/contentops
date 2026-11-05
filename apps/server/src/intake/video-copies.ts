import type { Queryable, Tx } from '@contentops/db'
import { VIDEO_PRINT_PROFILE } from '@contentops/media'
import { type SQL, sql } from 'drizzle-orm'
import { handleSql } from '../catalog/ids'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import { resolveAlias } from './fetch'
import { phashMaxDistance } from './phash'

/**
 * «Похоже на ролик FYP-0019/master» (SPEC §6.2): the print of a video (`video_prints`, the
 * picture's duration and the pHash of ten frames) close to the print of an accepted video of
 * the same model. A montage of Ари came as the editor's original, a second export and a copy
 * with the loudness evened out — other bytes, the same picture. The hint is a candidate of the
 * draft and ◆ in «Приехало»: «Это копия» makes the file an alias of that video, as an exact
 * duplicate is; «Отдельный объект» lets the file go on. Nothing is decided by the print itself.
 */

/** Bits of a frame's pHash. */
const FRAME_BITS = 64

/**
 * The picture of a copy is as long as the original's within a few frames (a second export cut
 * three frames at the start); other takes of a shoot differ by seconds. The gate only narrows
 * what is compared: the frames decide.
 */
function durationGate(mine: SQL, theirs: SQL): SQL {
  return sql`abs(${theirs} - ${mine}) <= greatest(500, greatest(${mine}, ${theirs}) / 50)`
}

/**
 * The distance of two prints: the median of the frame distances (the lower one of ten). A copy
 * whose start was cut keeps most frames, though the frames near a cut land on the next shot.
 */
function printDistance(mine: SQL, theirs: SQL): SQL {
  return sql`(SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY bit_count(${theirs}[i] # ${mine}[i]))
                FROM generate_subscripts(${mine}, 1) i)`
}

/** Frames within the pHash threshold of a photo (85 %): «совпало 9 кадров из 10». */
const FRAME_CLOSE = phashMaxDistance(85) as number

function closeFrames(mine: SQL, theirs: SQL): SQL {
  return sql`(SELECT count(*)::int FROM generate_subscripts(${mine}, 1) i
               WHERE bit_count(${theirs}[i] # ${mine}[i]) <= ${FRAME_CLOSE})`
}

/**
 * `video_suggest_threshold` of the model, else the one for everything, as the largest median
 * distance in bits; `null` — not set, no hints (schema §9.2). «Похожесть роликов» on «Пороги»
 * is a percent of the 64 bits, as «Похожесть кадров» is.
 */
export async function videoSuggestDistance(q: Queryable, modelId: string): Promise<number | null> {
  const { rows } = await q.execute<{ value: unknown }>(sql`
    SELECT value FROM policy_settings
     WHERE key = 'video_suggest_threshold' AND account_id IS NULL AND item_type IS NULL
       AND (model_id IS NULL OR model_id = ${modelId}::uuid) AND value IS NOT NULL
     ORDER BY model_id NULLS LAST LIMIT 1`)
  const value = rows[0]?.value
  return typeof value === 'number' ? phashMaxDistance(value) : null
}

/** The version of the algorithm the prints are compared by: the newest one stored. */
async function printVersion(q: Queryable, sha: Buffer): Promise<string | null> {
  const { rows } = await q.execute<{ algo_version: string }>(sql`
    SELECT algo_version FROM video_prints
     WHERE sha256 = ${sha} AND algorithm = ${VIDEO_PRINT_PROFILE.algorithm}
     ORDER BY computed_at DESC LIMIT 1`)
  return rows[0]?.algo_version ?? null
}

interface Near extends Record<string, unknown> {
  item_id: string
  version_id: string
  distance: number
  close: number
  duration_ms: number
  mine_ms: number
}

/**
 * The hint for one open draft: its print against the accepted videos of the model — at most
 * three, the closest first. Not asked for a file made over an accepted version (`derived`), a
 * file with a target (an upload for an object, a new version) or the fix of a custom: there the
 * same picture is the point. Returns the number of open candidates of the draft.
 */
export async function similarVideos(tx: Tx, modelId: string, draftId: string): Promise<number> {
  const threshold = await videoSuggestDistance(tx, modelId)
  if (threshold === null) return 0
  const { rows: drafts } = await tx.execute<{ sha: Buffer | null }>(sql`
    SELECT d.source_sha256 AS sha FROM inbox_drafts d
     WHERE d.model_id = ${modelId}::uuid AND d.id = ${draftId}::uuid AND d.state <> 'resolved'
       AND d.origin <> 'derived' AND d.target_item_id IS NULL AND d.target_asset_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM inbox_draft_candidates c
                        WHERE c.model_id = d.model_id AND c.draft_id = d.id
                          AND c.kind = 'existing_item' AND c.dismissed_at IS NULL)`)
  const sha = drafts[0]?.sha
  if (!sha) return 0
  const version = await printVersion(tx, sha)
  if (!version) return 0
  const mine = sql`mine.frames`
  const theirs = sql`p.frames`
  const { rows } = await tx.execute<Near>(sql`
    WITH mine AS (
      SELECT duration_ms, frames FROM video_prints
       WHERE sha256 = ${sha} AND algorithm = ${VIDEO_PRINT_PROFILE.algorithm}
         AND algo_version = ${version}
    )
    SELECT near.* FROM mine, LATERAL (
      SELECT DISTINCT ON (v.id) m.item_id, v.id AS version_id, p.duration_ms,
             mine.duration_ms AS mine_ms, ${printDistance(mine, theirs)} AS distance,
             ${closeFrames(mine, theirs)} AS close
        FROM video_prints p
        JOIN asset_versions v ON v.model_id = ${modelId}::uuid
                             AND (v.source_sha256 = p.sha256 OR v.master_sha256 = p.sha256)
        JOIN assets a ON a.model_id = v.model_id AND a.id = v.asset_id
                     AND a.current_version_id = v.id AND a.variant_kind = 'none'
        JOIN item_memberships m ON m.model_id = v.model_id AND m.asset_id = v.asset_id
                               AND m.kind = 'owned' AND m.removed_at IS NULL
        JOIN content_items i ON i.model_id = m.model_id AND i.id = m.item_id AND i.deleted_at IS NULL
       WHERE p.algorithm = ${VIDEO_PRINT_PROFILE.algorithm} AND p.algo_version = ${version}
         AND p.sha256 <> ${sha} AND v.source_sha256 <> ${sha} AND v.master_sha256 <> ${sha}
         AND cardinality(p.frames) = cardinality(mine.frames)
         AND ${durationGate(sql`mine.duration_ms`, sql`p.duration_ms`)}
       ORDER BY v.id
    ) near
     WHERE near.distance <= ${threshold}
     ORDER BY near.distance, near.version_id
     LIMIT 3`)
  for (const near of rows) {
    const signals = {
      print_distance: Number(near.distance),
      frames_close: Number(near.close),
      frames: VIDEO_PRINT_PROFILE.permille.length,
      duration_ms: [Number(near.mine_ms), Number(near.duration_ms)],
    }
    await tx.execute(sql`
      INSERT INTO inbox_draft_candidates (model_id, draft_id, kind, item_id, version_id, score, signals)
      VALUES (${modelId}::uuid, ${draftId}::uuid, 'similar_video', ${near.item_id}::uuid,
              ${near.version_id}::uuid, ${1 - Number(near.distance) / FRAME_BITS},
              ${JSON.stringify(signals)}::jsonb)
      ON CONFLICT DO NOTHING`)
  }
  const open = await openCandidates(tx, modelId, [draftId])
  if (open.length > 0) {
    // ◆ on this file only; another question of the draft is answered first, then this one.
    await tx.execute(sql`
      UPDATE inbox_drafts SET blocked_reason = 'video_copy', updated_at = now(),
             row_version = row_version + 1
       WHERE model_id = ${modelId}::uuid AND id = ${draftId}::uuid AND state <> 'resolved'
         AND blocked_reason IS NULL`)
  }
  return open.length
}

/** Drafts among `draftIds` with a «похоже на ролик» nobody answered yet. */
export async function openCandidates(
  q: Queryable,
  modelId: string,
  draftIds: readonly string[],
): Promise<string[]> {
  if (draftIds.length === 0) return []
  const { rows } = await q.execute<{ draft_id: string }>(sql`
    SELECT DISTINCT c.draft_id FROM inbox_draft_candidates c
     WHERE c.model_id = ${modelId}::uuid AND c.draft_id = ANY (${sql.param([...draftIds])}::uuid[])
       AND c.kind = 'similar_video' AND c.dismissed_at IS NULL AND NOT c.chosen`)
  return rows.map((row) => row.draft_id)
}

/**
 * At an accept: open video drafts of other groups whose print is close to an accepted file of
 * this group get the hint now — two copies of one montage may wait in «Приехало» together.
 * A draft locked by a concurrent accept is skipped rather than waited for.
 */
export async function flagOpenCopies(
  tx: Tx,
  modelId: string,
  /** The accepted group, whose own drafts are not asked; `null` — a print of the library. */
  groupId: string | null,
  hexes: readonly string[],
): Promise<number> {
  if (hexes.length === 0) return 0
  const threshold = await videoSuggestDistance(tx, modelId)
  if (threshold === null) return 0
  const mine = sql`mine.frames`
  const theirs = sql`p.frames`
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT d.id FROM inbox_drafts d
     WHERE d.model_id = ${modelId}::uuid
       AND (${groupId}::uuid IS NULL OR d.group_id <> ${groupId}::uuid)
       AND d.state <> 'resolved' AND d.origin <> 'derived' AND d.target_item_id IS NULL
       AND EXISTS (
         SELECT 1 FROM video_prints p
           JOIN video_prints mine ON mine.algorithm = p.algorithm AND mine.algo_version = p.algo_version
                                 AND mine.sha256 IN (SELECT decode(h, 'hex') FROM unnest(${sql.param([...hexes])}::text[]) h)
          WHERE p.sha256 = d.source_sha256 AND p.algorithm = ${VIDEO_PRINT_PROFILE.algorithm}
            AND cardinality(p.frames) = cardinality(mine.frames)
            AND ${durationGate(sql`mine.duration_ms`, sql`p.duration_ms`)}
            AND ${printDistance(mine, theirs)} <= ${threshold})
     ORDER BY d.id
     FOR UPDATE OF d SKIP LOCKED`)
  let flagged = 0
  for (const row of rows) if ((await similarVideos(tx, modelId, row.id)) > 0) flagged += 1
  return flagged
}

/** `video_copy` stays only on drafts that still have a question: the others go on. */
async function liftAnswered(tx: Tx, modelId: string, groupId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE inbox_drafts d SET blocked_reason = NULL, updated_at = now(), row_version = row_version + 1
     WHERE d.model_id = ${modelId}::uuid AND d.group_id = ${groupId}::uuid
       AND d.state <> 'resolved' AND d.blocked_reason = 'video_copy'
       AND NOT EXISTS (SELECT 1 FROM inbox_draft_candidates c
                        WHERE c.model_id = d.model_id AND c.draft_id = d.id AND c.kind = 'similar_video'
                          AND c.dismissed_at IS NULL AND NOT c.chosen)`)
}

/**
 * The answer to ◆ «Похоже на ролик» for the file `fileKey`: `copy` — the file is an alias of
 * the closest video, as an exact duplicate is (its bytes stay out of the catalog, like those of
 * a refused file); otherwise it is a file of its own and goes on with its group.
 */
export async function answerVideoCopy(
  tx: Tx,
  model: ModelScope,
  actor: Actor,
  groupId: string,
  draft: { id: string; source_object_id: string | null },
  copy: boolean,
): Promise<void> {
  const { rows } = await tx.execute<{
    id: string
    version_id: string
    asset_id: string
    item_id: string
    type: string
  }>(sql`
    SELECT c.id, c.version_id, v.asset_id, c.item_id, i.type
      FROM inbox_draft_candidates c
      JOIN asset_versions v ON v.model_id = c.model_id AND v.id = c.version_id
      JOIN content_items i ON i.model_id = c.model_id AND i.id = c.item_id
     WHERE c.model_id = ${model.id}::uuid AND c.draft_id = ${draft.id}::uuid
       AND c.kind = 'similar_video' AND c.dismissed_at IS NULL AND NOT c.chosen
     ORDER BY c.score DESC NULLS LAST, c.created_at
     LIMIT 1`)
  const closest = rows[0]
  if (!closest) {
    throw new ApiProblem('accept_blocked', 'У этого файла нет вопроса «Похоже на ролик»', {
      reason: 'no_video_question',
    })
  }
  if (copy) {
    await tx.execute(sql`
      UPDATE inbox_draft_candidates SET chosen = true, chosen_at = now(), chosen_by = ${actor.id}::uuid
       WHERE model_id = ${model.id}::uuid AND id = ${closest.id}::uuid`)
    await resolveAlias(
      tx,
      model.id,
      draft.id,
      {
        version_id: closest.version_id,
        asset_id: closest.asset_id,
        item_id: closest.item_id,
        type: closest.type,
      },
      draft.source_object_id,
      undefined,
      { decidedBy: actor.id },
    )
    // The master of a copy is never taken: the compression queue does not spend hours on it.
    await tx.execute(sql`
      UPDATE work_operations SET state = 'cancelled', finished_at = now()
       WHERE model_id = ${model.id}::uuid AND draft_id = ${draft.id}::uuid
         AND kind = 'encode_master' AND state IN ('pending', 'retry_wait')`)
  }
  // Every other video the file was close to is answered by the same word.
  await tx.execute(sql`
    UPDATE inbox_draft_candidates SET dismissed_at = now()
     WHERE model_id = ${model.id}::uuid AND draft_id = ${draft.id}::uuid
       AND kind = 'similar_video' AND dismissed_at IS NULL AND NOT chosen`)
  await liftAnswered(tx, model.id, groupId)
}

/** «Похожесть роликов» for the report when the setting is not set: the measured value. */
export const VIDEO_REPORT_PERCENT = 85

export interface VideoCopyPair {
  a: string
  b: string
  similarity: number
  frames_close: number
  frames: number
  duration_s: [number, number]
  /** The paths the files came from, for the person who compares them. */
  paths: [string | null, string | null]
}

export interface VideoCopiesReport {
  model: string
  similarity_min: number
  videos: number
  printed: number
  pairs: VideoCopyPair[]
}

/**
 * `ops.js video-copies <model>` (PLAN, stage 7): pairs «похоже на ролик» among the accepted
 * videos of a model — the copies an earlier intake took as objects of their own. Only reads;
 * the person decides what to merge by the catalog's own commands.
 */
export async function videoCopiesReport(
  q: Queryable,
  model: { id: string; code: string },
  percent: number | null,
): Promise<VideoCopiesReport> {
  const similarityMin = percent ?? VIDEO_REPORT_PERCENT
  const threshold = phashMaxDistance(similarityMin)
  if (threshold === null) throw new ApiProblem('invalid_request', 'Похожесть — от 0 до 100 %')
  const { rows: versions } = await q.execute<{ algo_version: string }>(sql`
    SELECT algo_version FROM video_prints WHERE algorithm = ${VIDEO_PRINT_PROFILE.algorithm}
     GROUP BY algo_version ORDER BY max(computed_at) DESC LIMIT 1`)
  const version = versions[0]?.algo_version ?? ''
  const accepted = sql`
    SELECT DISTINCT ON (v.id) v.id AS version_id, public_item_id(i.type, i.number) AS item,
           ${handleSql('m')} AS handle,
           p.sha256, p.duration_ms, p.frames,
           (SELECT o.current_path FROM source_revisions r
              JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
             WHERE r.model_id = v.model_id AND r.id = v.source_revision_id) AS path
      FROM asset_versions v
      JOIN assets a ON a.model_id = v.model_id AND a.id = v.asset_id
                   AND a.current_version_id = v.id AND a.variant_kind = 'none'
      JOIN item_memberships m ON m.model_id = v.model_id AND m.asset_id = v.asset_id
                             AND m.kind = 'owned' AND m.removed_at IS NULL
      JOIN content_items i ON i.model_id = m.model_id AND i.id = m.item_id AND i.deleted_at IS NULL
      JOIN video_prints p ON p.sha256 IN (v.source_sha256, v.master_sha256)
                         AND p.algorithm = ${VIDEO_PRINT_PROFILE.algorithm}
                         AND p.algo_version = ${version}
     WHERE v.model_id = ${model.id}::uuid AND a.media_kind = 'video'
     ORDER BY v.id`
  const { rows: counts } = await q.execute<{ videos: number; printed: number }>(sql`
    SELECT count(DISTINCT v.id)::int AS videos,
           count(DISTINCT v.id) FILTER (WHERE EXISTS (
             SELECT 1 FROM video_prints p
              WHERE p.sha256 IN (v.source_sha256, v.master_sha256)
                AND p.algorithm = ${VIDEO_PRINT_PROFILE.algorithm}
                AND p.algo_version = ${version}))::int AS printed
      FROM asset_versions v
      JOIN assets a ON a.model_id = v.model_id AND a.id = v.asset_id
                   AND a.current_version_id = v.id AND a.variant_kind = 'none'
      JOIN item_memberships m ON m.model_id = v.model_id AND m.asset_id = v.asset_id
                             AND m.kind = 'owned' AND m.removed_at IS NULL
      JOIN content_items i ON i.model_id = m.model_id AND i.id = m.item_id AND i.deleted_at IS NULL
     WHERE v.model_id = ${model.id}::uuid AND a.media_kind = 'video'`)
  const x = sql`x.frames`
  const y = sql`y.frames`
  const { rows } = await q.execute<{
    a_item: string
    a_handle: string
    a_ms: number
    a_path: string | null
    b_item: string
    b_handle: string
    b_ms: number
    b_path: string | null
    distance: number
    close: number
  }>(sql`
    WITH accepted AS (${accepted})
    SELECT x.item AS a_item, x.handle AS a_handle, x.duration_ms AS a_ms, x.path AS a_path,
           y.item AS b_item, y.handle AS b_handle, y.duration_ms AS b_ms, y.path AS b_path,
           d.distance, d.close
      FROM accepted x
      JOIN accepted y ON x.version_id < y.version_id AND x.sha256 <> y.sha256
                     AND cardinality(x.frames) = cardinality(y.frames)
                     AND ${durationGate(sql`x.duration_ms`, sql`y.duration_ms`)}
     CROSS JOIN LATERAL (
       SELECT ${printDistance(x, y)} AS distance, ${closeFrames(x, y)} AS close
     ) d
     WHERE d.distance <= ${threshold}
     ORDER BY d.distance, x.item, y.item`)
  const pairs = rows
    .map((row) => {
      // The older object first: the one a copy would become an alias of.
      const [first, second] =
        row.a_item.localeCompare(row.b_item, 'en', { numeric: true }) <= 0
          ? [
              [row.a_item, row.a_handle, row.a_ms, row.a_path],
              [row.b_item, row.b_handle, row.b_ms, row.b_path],
            ]
          : [
              [row.b_item, row.b_handle, row.b_ms, row.b_path],
              [row.a_item, row.a_handle, row.a_ms, row.a_path],
            ]
      return {
        a: `${first[0]}/${first[1]}`,
        b: `${second[0]}/${second[1]}`,
        similarity: Math.round(100 * (1 - Number(row.distance) / FRAME_BITS)),
        frames_close: Number(row.close),
        frames: VIDEO_PRINT_PROFILE.permille.length,
        duration_s: [Number(first[2]) / 1000, Number(second[2]) / 1000] as [number, number],
        paths: [first[3] as string | null, second[3] as string | null] as [
          string | null,
          string | null,
        ],
      }
    })
    .sort((left, right) => right.similarity - left.similarity || left.a.localeCompare(right.a))
  return {
    model: model.code,
    similarity_min: similarityMin,
    videos: counts[0]?.videos ?? 0,
    printed: counts[0]?.printed ?? 0,
    pairs,
  }
}
