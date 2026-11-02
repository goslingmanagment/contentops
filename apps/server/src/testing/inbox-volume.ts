import { type Db, SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { sql } from 'drizzle-orm'

/**
 * «Приехало» of the volume stage 7 brings (infrastructure §5, SPEC §12.0): `seed lora --inbox
 * 5000` writes open drafts in groups shaped like the live ones and about four works per draft,
 * for the measurement of the screen in its own database. Two thirds are drafts of the old disk
 * waiting for their bytes — they never show in «Новое» — the rest are new packs from Dropbox in
 * every stage: still downloading, compressing, ready. No bytes: blobs and thumbnails are rows,
 * and the queued works are paused (`switch_off:volume`) so a running worker leaves them alone.
 * Never for a database with real content.
 */

interface Shape {
  key: string
  root: string
  title: string
  files: number
  video: number
  legacy: boolean
}

/** New packs from Dropbox: one large SMM folder, sextings, singles of FYP and customs, sets. */
function newPacks(budget: number): Shape[] {
  const shapes: Shape[] = [
    { key: 'smm', root: '9. SMM', title: 'Gif сайты', files: 1000, video: 0.3, legacy: false },
  ]
  for (let n = 1; n <= 3; n++) {
    shapes.push({
      key: `sxt-${n}`,
      root: '5. Sextings',
      title: `2${n}.10.26`,
      files: 110,
      video: 0.2,
      legacy: false,
    })
  }
  for (let n = 1; n <= 60; n++) {
    shapes.push({
      key: `fyp-${n}`,
      root: '2. FYP',
      title: `Видео ${n}`,
      files: 1,
      video: 1,
      legacy: false,
    })
  }
  for (let n = 1; n <= 20; n++) {
    shapes.push({
      key: `cus-${n}`,
      root: '3. Customs',
      title: `1${n}-0${n % 9} кастом`,
      files: 1,
      video: 1,
      legacy: false,
    })
  }
  let left = budget - shapes.reduce((sum, shape) => sum + shape.files, 0)
  for (let n = 1; left > 0; n++) {
    const files = Math.min(left, 8 + ((n * 7) % 25))
    const root = ['4. Sets', '6. Life', '1. PPV'][n % 3] as string
    shapes.push({ key: `pack-${n}`, root, title: `${n}.10.26`, files, video: 0.1, legacy: false })
    left -= files
  }
  return shapes
}

/** Folders of the old disk waiting for the import of their bytes: four files each. */
function legacyFolders(drafts: number): Shape[] {
  return Array.from({ length: Math.ceil(drafts / 4) }, (_, n) => ({
    key: `legacy-${n}`,
    root: '7. Pictures',
    title: `old_${n}`,
    files: 4,
    video: 0.25,
    legacy: true,
  }))
}

export async function seedInboxVolume(
  db: Db,
  modelCode: string,
  drafts = 5000,
): Promise<{ skipped: boolean; groups: number; drafts: number; works: number }> {
  const context = {
    actor: SYSTEM_ACTOR('seed'),
    action: 'seed.inbox_volume',
    requestId: `seed-inbox-${modelCode}-${drafts}`,
  }
  return withActorTx(db, context, async (tx) => {
    const { rows: models } = await tx.execute<{ model_id: string; source_id: string | null }>(sql`
      SELECT m.id AS model_id,
             (SELECT s.id FROM sources s WHERE s.model_id = m.id AND s.kind = 'dropbox' LIMIT 1) AS source_id
        FROM models m WHERE m.code = ${modelCode}`)
    const model = models[0]
    if (!model?.source_id) throw new Error(`seed --inbox: no Dropbox source of ${modelCode}`)
    const { rows: seeded } = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM inbox_groups
       WHERE model_id = ${model.model_id}::uuid AND group_key LIKE 'volume:%'`)
    if ((seeded[0]?.n ?? 0) > 0) return { skipped: true, groups: 0, drafts: 0, works: 0 }

    const fresh = Math.round(drafts / 3)
    const shapes = [...newPacks(fresh), ...legacyFolders(drafts - fresh)]
    // One row per file of every group: its place in the group, its stage and its kind.
    const files = shapes.flatMap((shape, g) =>
      Array.from({ length: shape.files }, (_, n) => ({
        g,
        n,
        video: shape.video >= 1 || (n * 37) % 100 < shape.video * 100,
        // New packs: a third still downloading, a third compressing, a third ready; the old
        // disk waits for its bytes, one folder in fifty with a failed fetch.
        stage: shape.legacy
          ? g % 50 === 0
            ? 'failed'
            : 'waiting'
          : (['fetch', 'encode', 'ready'][(g + n) % 3] as string),
      })),
    )
    const payload = JSON.stringify({
      groups: shapes.map((shape, g) => ({
        g,
        key: `volume:${shape.key}`,
        root: shape.root,
        title: shape.title,
        legacy: shape.legacy,
        type: shape.legacy ? 'SET' : typeOfRoot(shape.root),
      })),
      files,
    })
    await tx.execute(sql`
      CREATE TEMP TABLE volume_input ON COMMIT DROP AS
      SELECT ${payload}::jsonb AS doc`)
    await tx.execute(sql`
      CREATE TEMP TABLE volume_groups ON COMMIT DROP AS
      SELECT (x ->> 'g')::int AS g, uuidv7() AS id, x ->> 'key' AS key, x ->> 'root' AS root,
             x ->> 'title' AS title, (x ->> 'legacy')::boolean AS legacy, x ->> 'type' AS type
        FROM volume_input, jsonb_array_elements(doc -> 'groups') AS x`)
    await tx.execute(sql`
      CREATE TEMP TABLE volume_files ON COMMIT DROP AS
      SELECT f.g, f.n, f.video, f.stage, gr.id AS group_id, gr.root, gr.title, gr.legacy,
             uuidv7() AS object_id, uuidv7() AS revision_id, uuidv7() AS draft_id,
             sha256(convert_to(gr.key || '/' || f.n, 'UTF8')) AS source_sha,
             sha256(convert_to('master/' || gr.key || '/' || f.n, 'UTF8')) AS master_sha,
             now() - make_interval(mins => f.g * 3 + f.n) AS arrived
        FROM volume_input,
             jsonb_to_recordset(doc -> 'files') AS f(g int, n int, video boolean, stage text)
        JOIN volume_groups gr ON gr.g = f.g`)
    await tx.execute(sql`
      INSERT INTO inbox_groups (model_id, id, source_id, group_key, grouping, evidence,
                                proposed_type, proposed_title)
      SELECT ${model.model_id}::uuid, id, ${model.source_id}::uuid, key, 'folder',
             CASE WHEN legacy THEN jsonb_build_object('root', root, 'path', '/' || root || '/' || title,
                                                      'legacy', jsonb_build_object('unit', root || '/' || title))
                  ELSE jsonb_build_object('root', root, 'path', '/' || root || '/' || title) END,
             type, title
        FROM volume_groups`)
    await tx.execute(sql`
      INSERT INTO source_objects (model_id, id, source_id, resource_id, current_path, current_name)
      SELECT ${model.model_id}::uuid, object_id, ${model.source_id}::uuid, NULL,
             '/' || root || '/' || title || '/' || CASE WHEN video THEN 'IMG_' || n || '.mov' ELSE 'IMG_' || n || '.jpg' END,
             CASE WHEN video THEN 'IMG_' || n || '.mov' ELSE 'IMG_' || n || '.jpg' END
        FROM volume_files`)
    await tx.execute(sql`
      INSERT INTO source_revisions (model_id, id, source_object_id, sequence_no, byte_size,
                                    remote_created_at, media_type)
      SELECT ${model.model_id}::uuid, revision_id, object_id, 1,
             CASE WHEN video THEN 400000000 ELSE 3000000 END, arrived,
             CASE WHEN video THEN 'video' ELSE 'image' END
        FROM volume_files`)
    await tx.execute(sql`
      INSERT INTO blobs (sha256, byte_size, mime, ext, media_kind, storage_key)
      SELECT sha, size, mime, ext, kind, 'volume/' || encode(sha, 'hex')
        FROM (SELECT source_sha AS sha, CASE WHEN video THEN 400000000 ELSE 3000000 END AS size,
                     CASE WHEN video THEN 'video/quicktime' ELSE 'image/jpeg' END AS mime,
                     CASE WHEN video THEN 'mov' ELSE 'jpg' END AS ext,
                     CASE WHEN video THEN 'video' ELSE 'image' END AS kind
                FROM volume_files WHERE stage IN ('encode', 'ready')
              UNION ALL
              SELECT master_sha, CASE WHEN video THEN 120000000 ELSE 3000000 END,
                     CASE WHEN video THEN 'video/mp4' ELSE 'image/jpeg' END,
                     CASE WHEN video THEN 'mp4' ELSE 'jpg' END,
                     CASE WHEN video THEN 'video' ELSE 'image' END
                FROM volume_files WHERE stage = 'ready' AND video) AS b
      ON CONFLICT DO NOTHING`)
    await tx.execute(sql`
      INSERT INTO inbox_drafts (model_id, id, group_id, source_revision_id, origin, state,
                                byte_size, path, discovered_at, source_sha256, source_blob_sha256,
                                master_sha256, master_verified_at, master_is_source)
      SELECT ${model.model_id}::uuid, draft_id, group_id, revision_id,
             CASE WHEN legacy THEN 'legacy_import' ELSE 'disk_scan' END,
             CASE stage WHEN 'ready' THEN 'ready' WHEN 'encode' THEN 'processing' ELSE 'discovered' END,
             CASE WHEN video THEN 400000000 ELSE 3000000 END,
             '/' || root || '/' || title || '/' || CASE WHEN video THEN 'IMG_' || n || '.mov' ELSE 'IMG_' || n || '.jpg' END,
             arrived,
             CASE WHEN stage IN ('encode', 'ready') THEN source_sha END,
             CASE WHEN stage IN ('encode', 'ready') THEN source_sha END,
             CASE WHEN stage = 'ready' THEN CASE WHEN video THEN master_sha ELSE source_sha END END,
             CASE WHEN stage = 'ready' THEN now() END,
             stage = 'ready' AND NOT video
        FROM volume_files`)
    // Works: the fetch of every file (a failed attempt before the good one for every fifth),
    // the media works of what has its bytes, a thumbnail of every ready file.
    const { rows: counted } = await tx.execute<{ n: number }>(sql`
      WITH fetches AS (
        INSERT INTO work_operations (model_id, kind, work_key, state, priority, source_revision_id,
                                     draft_id, progress_num, progress_den, error_text,
                                     failure_kind, created_at, finished_at, lease_owner, lease_until,
                                     paused_reason)
        SELECT ${model.model_id}::uuid, 'fetch', 'fetch:' || revision_id || suffix, state, 50,
               revision_id, draft_id,
               CASE WHEN state = 'running' THEN 150000000 END,
               CASE WHEN state = 'running' THEN 400000000 END,
               CASE WHEN state = 'failed' THEN 'источник ответил 500' END,
               CASE WHEN state = 'failed' THEN 'permanent' END,
               arrived + make_interval(secs => attempt),
               CASE WHEN state IN ('succeeded', 'failed') THEN arrived + make_interval(secs => attempt + 1) END,
               CASE WHEN state = 'running' THEN 'volume' END,
               CASE WHEN state = 'running' THEN now() + interval '100 years' END,
               CASE WHEN state = 'pending' THEN 'switch_off:volume' END
          FROM (SELECT f.*, a.attempt, a.suffix,
                       CASE
                         WHEN f.stage = 'failed' THEN 'failed'
                         WHEN a.attempt = 0 AND f.n % 5 = 0 THEN 'failed'
                         WHEN f.stage = 'waiting' THEN 'pending'
                         WHEN f.stage = 'fetch' THEN CASE WHEN f.n % 2 = 0 THEN 'running' ELSE 'pending' END
                         ELSE 'succeeded' END AS state
                  FROM volume_files f
                  CROSS JOIN LATERAL (VALUES (0, ''), (1, ':retry-1')) AS a(attempt, suffix)
                 WHERE a.attempt = 0 OR (f.n % 5 = 0 AND f.stage <> 'failed')) AS x
        RETURNING 1
      ), media AS (
        INSERT INTO work_operations (model_id, kind, work_key, state, priority, draft_id,
                                     input_sha256, created_at, finished_at, paused_reason)
        SELECT ${model.model_id}::uuid, kind, kind || ':' || encode(source_sha, 'hex'), state, 40,
               draft_id, source_sha, arrived, CASE WHEN state = 'succeeded' THEN arrived END,
               CASE WHEN state = 'pending' THEN 'switch_off:volume' END
          FROM (SELECT f.*, k.kind,
                       CASE WHEN f.stage = 'ready' THEN 'succeeded' ELSE 'pending' END AS state
                  FROM volume_files f
                  CROSS JOIN LATERAL (VALUES ('derive_image'), ('derive_video'), ('encode_master'),
                                             ('verify_master')) AS k(kind)
                 WHERE f.stage IN ('encode', 'ready')
                   AND (k.kind = 'derive_image') = NOT f.video) AS x
        RETURNING 1
      ), legacy_media AS (
        -- The old disk queued its media works when the import planned them.
        INSERT INTO work_operations (model_id, kind, work_key, state, priority, draft_id,
                                     paused_reason)
        SELECT ${model.model_id}::uuid, k.kind, k.kind || ':volume:' || f.draft_id, 'pending', 5,
               f.draft_id, 'switch_off:volume'
          FROM volume_files f
          CROSS JOIN LATERAL (VALUES ('derive_image'), ('derive_video')) AS k(kind)
         WHERE f.legacy AND (k.kind = 'derive_image') = NOT f.video
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM fetches)::int + (SELECT count(*) FROM media)::int
             + (SELECT count(*) FROM legacy_media)::int AS n`)
    // The history of the queue: scans every five minutes and the media of what was accepted
    // before, so the table has the size of a stage-7 queue (20 000 rows and more).
    const queued = counted[0]?.n ?? 0
    const history = Math.max(0, Math.max(20_000, drafts * 4) - queued)
    await tx.execute(sql`
      INSERT INTO work_operations (model_id, kind, work_key, state, priority, dataset, scope,
                                   created_at, finished_at)
      SELECT ${model.model_id}::uuid, CASE WHEN n % 4 = 0 THEN 'scan' ELSE 'derive_image' END,
             'volume-history:' || n, 'succeeded', 10,
             CASE WHEN n % 4 = 0 THEN 'recent' END,
             CASE WHEN n % 4 = 0 THEN ${model.source_id}::text END,
             now() - make_interval(mins => n), now() - make_interval(mins => n)
        FROM generate_series(1, ${history}) AS n`)
    await tx.execute(sql`
      INSERT INTO rendition_generations (kind, recipe_digest, input_kind, input_sha256, state,
                                         ready_at)
      SELECT 'thumb640', 'volume', 'source', source_sha, 'ready', arrived
        FROM volume_files WHERE stage = 'ready'`)
    return { skipped: false, groups: shapes.length, drafts: files.length, works: queued + history }
  })
}

function typeOfRoot(root: string): string {
  if (root.includes('SMM')) return 'RAW'
  if (root.includes('Sextings')) return 'SXT'
  if (root.includes('FYP')) return 'FYP'
  if (root.includes('Customs')) return 'CUS'
  if (root.includes('Sets')) return 'SET'
  if (root.includes('Life')) return 'LIFE'
  return 'PPV'
}
