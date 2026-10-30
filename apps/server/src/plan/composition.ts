import { randomUUID } from 'node:crypto'
import type { DownloadKind } from '@contentops/contracts/commands/objects'
import type { CopyState } from '@contentops/contracts/domain/placement'
import type { PlanManifest } from '@contentops/contracts/domain/plan'
import type { NameSlot } from '@contentops/contracts/download-name'
import { formatDuration } from '@contentops/contracts/format'
import { enqueueWork, type Queryable, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import {
  type Choice,
  type DownloadItem,
  type FileRow,
  handleOf,
  issuedName,
  loadFiles,
  mainVideo,
  pickFiles,
  zipNameOf,
} from '../media/downloads'
import { currentDigests } from '../media/pipeline'
import { readyGeneration } from '../media/renditions'
import { shaHex } from '../media/storage'
import { renderKey } from '../media/work/copies'
import type { DbItemType, DbSurface } from './records'

/**
 * What a plan row ships (SPEC §4, §7; schema §1 p. 4): the sealed composition of the versions
 * chosen when the row was put, the files of the row on its page with their download names
 * (naming §6: page, date and time of the slot), the platform copy built ahead (SPEC §9.3).
 * A new version or file does not change the row: «состав обновился», «Заменить состав».
 */

export type RowFileKey = 'platform' | 'teaser' | 'photos'

/** Download kinds a row offers on its page (DESIGN §4.11): story — the teaser only. */
export function rowFileKeys(type: DbItemType, surface: DbSurface): RowFileKey[] {
  switch (type) {
    case 'PPV':
      return surface === 'story' ? ['teaser'] : ['platform', 'teaser', 'photos']
    case 'FYP':
    case 'SET':
    case 'SXT':
    case 'LIFE':
      return ['platform']
    default:
      return []
  }
}

/** The files a row of the type and surface ships, the unique version `uN` for a FYP. */
export function compositionOf(
  type: DbItemType,
  surface: DbSurface,
  files: readonly FileRow[],
  uniq: number | null,
): FileRow[] {
  if (type === 'FYP') {
    const master = files.find(
      (file) => file.role === 'master' && file.kind === 'owned' && file.variant_no === (uniq ?? 0),
    )
    return master ? [master] : []
  }
  const picked = new Map<string, FileRow>()
  for (const key of rowFileKeys(type, surface)) {
    for (const choice of pickFiles(type, files, key))
      picked.set(choice.file.version_id, choice.file)
  }
  return [...picked.values()]
}

/** Owned live files of the object at their current versions. */
export async function currentFiles(
  q: Queryable,
  modelId: string,
  itemId: string,
): Promise<FileRow[]> {
  return (await loadFiles(q, modelId, itemId)).filter((file) => file.kind === 'owned')
}

/** Inserts a sealed manifest of the files (schema §9.2): one transaction, never changed. */
export async function sealComposition(
  tx: Tx,
  modelId: string,
  itemId: string,
  files: readonly FileRow[],
  createdBy: string | null,
): Promise<string> {
  const id = randomUUID()
  await tx.execute(sql`
    INSERT INTO asset_manifests (model_id, id, purpose, origin_item_id, entry_count, created_by)
    VALUES (${modelId}::uuid, ${id}::uuid, 'plan', ${itemId}::uuid, ${files.length},
            ${createdBy}::uuid)`)
  for (const [index, file] of files.entries()) {
    await tx.execute(sql`
      INSERT INTO asset_manifest_entries (model_id, manifest_id, position, item_id, membership_id,
                                          asset_id, asset_version_id, handle_snapshot,
                                          selected_snapshot, life_use_snapshot)
      VALUES (${modelId}::uuid, ${id}::uuid, ${index + 1}, ${itemId}::uuid,
              ${file.membership_id}::uuid, ${file.asset_id}::uuid, ${file.version_id}::uuid,
              ${handleOf(file)}, ${file.selected}, ${file.life_use})`)
  }
  return id
}

/** The files of a sealed composition at the versions it holds, in its order. */
export async function manifestFiles(
  q: Queryable,
  modelId: string,
  manifestId: string,
): Promise<FileRow[]> {
  const { rows } = await q.execute<FileRow>(sql`
    SELECT e.membership_id, coalesce(m.kind, 'owned') AS kind, coalesce(m.role, 'pic') AS role,
           m.ordinal, coalesce(m.variant_no, 0) AS variant_no, m.display_position,
           coalesce(e.selected_snapshot, false) AS selected, e.life_use_snapshot AS life_use,
           a.media_kind, a.id AS asset_id, v.id AS version_id, v.version_no,
           v.master_sha256 AS master, b.ext, b.byte_size, v.duration_ms, v.width, v.height,
           b.state AS blob_state
      FROM asset_manifest_entries e
      JOIN assets a ON a.model_id = e.model_id AND a.id = e.asset_id
      JOIN asset_versions v ON v.model_id = e.model_id AND v.id = e.asset_version_id
      JOIN blobs b ON b.sha256 = v.master_sha256
      LEFT JOIN item_memberships m ON m.model_id = e.model_id AND m.id = e.membership_id
     WHERE e.model_id = ${modelId}::uuid AND e.manifest_id = ${manifestId}::uuid
     ORDER BY e.position`)
  return rows
}

/** «Фото 21 шт., по порядку» · «Фото 12 шт. и 2 видео, по порядку». */
function framesLabel(choices: readonly Choice[]): string {
  const photos = choices.filter((choice) => choice.file.media_kind === 'image').length
  const videos = choices.length - photos
  const parts = [photos > 0 ? `Фото ${photos} шт.` : '', videos > 0 ? `${videos} видео` : '']
  return `${parts.filter(Boolean).join(' и ')}, по порядку`
}

function labelOf(type: DbItemType, key: RowFileKey, choices: readonly Choice[]): string {
  if (key === 'teaser') return 'Тизер'
  if (key === 'photos' || type === 'SET' || type === 'SXT' || type === 'LIFE') {
    return framesLabel(choices)
  }
  const master = choices[0]?.file
  const seconds = master?.duration_ms ? Math.round(Number(master.duration_ms) / 1000) : null
  return seconds ? `Мастер ${formatDuration(seconds)}` : 'Мастер'
}

export interface RowFile {
  key: RowFileKey
  label: string
  download_name: string
  choices: Choice[]
}

/** The row's files on its page with the names the download will give (strip on, the default). */
export function rowFiles(
  modelCode: string,
  item: DownloadItem,
  surface: DbSurface,
  files: readonly FileRow[],
  slot: NameSlot,
): RowFile[] {
  return rowFileKeys(item.type, surface).flatMap((key) => {
    const choices = pickFiles(item.type, files, key as DownloadKind)
    if (choices.length === 0) return []
    const input = { modelCode, item, kind: key as DownloadKind, slot }
    const first = choices[0] as Choice
    return [
      {
        key,
        label: labelOf(item.type, key, choices),
        download_name: zipNameOf(input, choices) ?? issuedName(input, first, true),
        choices,
      },
    ]
  })
}

export function manifestView(
  base: Omit<PlanManifest, 'files' | 'fyp_version'>,
  files: readonly RowFile[],
  fyp: PlanManifest['fyp_version'],
): PlanManifest {
  return {
    ...base,
    fyp_version: fyp,
    files: files.map(({ key, label, download_name }) => ({ key, label, download_name })),
  }
}

/** Versions differ: a new version, a new file or a new pick — «состав обновился». */
export function sameComposition(sealed: readonly FileRow[], current: readonly FileRow[]): boolean {
  const ids = (files: readonly FileRow[]) =>
    files
      .map((file) => file.version_id)
      .sort()
      .join(',')
  return ids(sealed) === ids(current)
}

/**
 * A unique FYP version was built (`uniq_render`): rows that waited for it get their sealed
 * composition in the same transaction — «Версии для Fansly 2, 3 · соберётся».
 */
export async function sealWaitingVersionRows(
  tx: Tx,
  modelId: string,
  itemId: string,
  variantNo: number,
): Promise<number> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM posting_plan_rows
     WHERE model_id = ${modelId}::uuid AND item_id = ${itemId}::uuid
       AND uniq_variant_no = ${variantNo} AND manifest_id IS NULL AND cancelled_at IS NULL
     FOR UPDATE`)
  if (rows.length === 0) return 0
  const files = compositionOf('FYP', 'fyp', await currentFiles(tx, modelId, itemId), variantNo)
  if (files.length === 0) return 0
  for (const row of rows) {
    const manifestId = await sealComposition(tx, modelId, itemId, files, null)
    await tx.execute(sql`
      UPDATE posting_plan_rows SET manifest_id = ${manifestId}::uuid, row_version = row_version + 1
       WHERE model_id = ${modelId}::uuid AND id = ${row.id}::uuid`)
  }
  return rows.length
}

// ---------------------------------------------------------------------------
// Platform copies (SPEC §9.3)
// ---------------------------------------------------------------------------

/**
 * `platform.mp4` of every video of the row is built when the object enters the plan, ahead of
 * the task; a copy already built is reused. «Стереть метаданные» is on by default, so the
 * stripped copy is the one prepared. Nothing to do before the media pipeline ran once.
 */
export async function enqueueCopies(
  tx: Queryable,
  modelId: string,
  files: readonly FileRow[],
): Promise<void> {
  const digests = await currentDigests(tx)
  if (!digests) return
  for (const file of files) {
    if (file.media_kind !== 'video') continue
    const ready = await readyGeneration(tx, {
      kind: 'platform',
      recipeDigest: digests.platformStripped,
      metaStripped: true,
      masterSha256: file.master,
      inputSha256: file.master,
    })
    if (ready) continue
    await enqueueWork(tx, {
      modelId,
      kind: 'render',
      workKey: renderKey(shaHex(file.master), digests.platformStripped),
      inputSha256: file.master,
      assetVersionId: file.version_id,
      scope: 'stripped',
      recipeDigest: digests.platformStripped,
    })
  }
}

/**
 * Copies of the open plan rows under the current recipe: a new recipe (the size cap of
 * `platform.mp4`, say) builds them ahead of the task again, not only at the next placement or
 * download — else the row would wait on a copy nobody builds. `worker` runs it on start; a
 * ready copy or a work of the same key is left as is.
 */
export async function enqueueOpenRowCopies(q: Queryable): Promise<number> {
  const { rows } = await q.execute<{ model_id: string; manifest_id: string }>(sql`
    SELECT DISTINCT model_id, manifest_id FROM posting_plan_rows
     WHERE manifest_id IS NOT NULL AND marked_at IS NULL AND cancelled_at IS NULL`)
  for (const row of rows) {
    await enqueueCopies(q, row.model_id, await manifestFiles(q, row.model_id, row.manifest_id))
  }
  return rows.length
}

/** The copy line of a row: ready with its size, building with progress, or failed. */
export async function copyState(q: Queryable, files: readonly FileRow[]): Promise<CopyState> {
  const digests = await currentDigests(q)
  let bytes = 0
  const building: number[] = []
  for (const file of files) {
    if (file.media_kind !== 'video') {
      bytes += Number(file.byte_size)
      continue
    }
    if (!digests) {
      building.push(0)
      continue
    }
    const ready = await readyGeneration(q, {
      kind: 'platform',
      recipeDigest: digests.platformStripped,
      metaStripped: true,
      masterSha256: file.master,
      inputSha256: file.master,
    })
    if (ready) {
      const { rows } = await q.execute<{ byte_size: string }>(sql`
        SELECT byte_size FROM rendition_artifacts
         WHERE generation_id = ${ready.id}::uuid AND name = 'platform.mp4' AND state = 'ready'`)
      bytes += Number(rows[0]?.byte_size ?? 0)
      continue
    }
    const { rows } = await q.execute<{ state: string; num: string | null; den: string | null }>(sql`
      SELECT state, progress_num AS num, progress_den AS den FROM work_operations
       WHERE kind = 'render'
         AND work_key = ${renderKey(shaHex(file.master), digests.platformStripped)}
       ORDER BY created_at DESC LIMIT 1`)
    const work = rows[0]
    if (work?.state === 'failed' || work?.state === 'cancelled') return { state: 'failed' }
    building.push(work?.num && work.den ? Math.min(1, Number(work.num) / Number(work.den)) : 0)
  }
  if (building.length > 0) {
    return {
      state: 'building',
      progress: building.reduce((sum, value) => sum + value, 0) / building.length,
    }
  }
  return { state: 'ready', size_bytes: bytes }
}

export { mainVideo }
