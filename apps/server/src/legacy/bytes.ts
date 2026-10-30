import {
  enqueueWork,
  type Queryable,
  SYSTEM_ACTOR,
  type Tx,
  type WorkContext,
  WorkError,
  type WorkSuccess,
  withActorTx,
} from '@contentops/db'
import { type ParsedLegacyPath, planLegacyImport } from '@contentops/legacy'
import { sql } from 'drizzle-orm'
import { mediaKindOf } from '../intake/grouping'
import { autoAcceptGroup } from './auto-accept'
import { readInputs } from './inputs'
import { displayRoot, ROOTS } from './review'
import { type SnapshotEntry, type SnapshotWork, snapshotListing, snapshotOf } from './snapshot'
import { type LegacyUnit, legacyUnits } from './units'

/**
 * The bytes of the old corpus, root by root and folder by folder (SPEC §6.3 «Байты, папка за
 * папкой, командами импорта через обычную приёмку»): for the snapshot's revisions of the chosen
 * roots the work makes the groups and drafts (origin `legacy_import`, members of archives
 * `archive`) and puts their bytes into the ordinary chain — `fetch` (the local copy first, then
 * the API) or `unpack_archive` for an archive; the media works follow, and a group without a
 * dispute is accepted by itself when its files are ready. Revisions outside the batch scope
 * (`import_batch_scope`, schema §9.7) get drafts «отложено до 9а» and no download. A repeat
 * changes nothing and accepts what became ready.
 */

export const BYTES_DATASET = 'bytes'

/** The order of the import (SPEC §6.3): PPV → секстинги → сеты → … → «Старый формат». */
const ORDER = [
  'PPV',
  'Секстинги',
  'Сеты',
  'Кастомы',
  'FYP',
  'Остальное',
  'Архивы',
  'SMM',
  '«Старый формат»',
]

export interface BytesInput {
  /** Top folders of the old disk: `1. PPV`, `5. Sextings`. */
  roots: string[]
  /** One folder inside them (`1. PPV/Bundles/[PPV-022]…`); the whole roots when `null`. */
  folder: string | null
  /** Out of the order of the norm (a test, a repeat of one folder). */
  force: boolean
}

export const bytesKey = (snapshotId: string, nonce: string) => `import:bytes:${snapshotId}:${nonce}`

export interface BytesReport {
  mode: 'bytes'
  snapshot: string
  roots: string[]
  folder: string | null
  units: number
  groups_new: number
  drafts_new: number
  drafts_moved: number
  deferred: number
  fetch_queued: number
  unpack_queued: number
  not_media: number
  accepted_now: number
  aliased_now: number
  queued: Record<string, number>
  waiting: number
}

const rootOf = (path: string) => path.split('/')[0] ?? ''

/** The roots before this one in the order must have every file taken into the import. */
async function checkOrder(
  q: Queryable,
  snapshot: SnapshotWork,
  listing: readonly SnapshotEntry[],
  roots: readonly string[],
): Promise<void> {
  const wanted = Math.min(...roots.map((root) => ORDER.indexOf(displayRoot(root))))
  const earlier = new Set(ORDER.slice(0, Math.max(0, wanted)))
  const pending = listing.filter(
    (e) =>
      !e.isDir &&
      !e.archiveEntry &&
      earlier.has(displayRoot(e.relative)) &&
      mediaKindOf(e.relative, e.mediaType ?? null) !== null,
  )
  if (pending.length === 0) return
  const { rows } = await q.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM inbox_drafts
     WHERE model_id = ${snapshot.modelId}::uuid
       AND source_revision_id = ANY (${sql.param(pending.flatMap((e) => (e.revisionId ? [e.revisionId] : [])))}::uuid[])`)
  if ((rows[0]?.n ?? 0) < pending.length) {
    const first = ORDER.find(
      (root) => earlier.has(root) && pending.some((e) => displayRoot(e.relative) === root),
    )
    throw new WorkError(
      'permanent',
      'import_order',
      `порядок импорта (SPEC §6.3): сначала «${first}» — его файлы ещё не взяты`,
    )
  }
}

/** `import_batch_scope` of the model: the `resource_id`s of this batch; `null` — everything. */
async function batchScope(q: Queryable, modelId: string): Promise<Set<string> | null> {
  const { rows } = await q.execute<{ value: unknown }>(sql`
    SELECT value FROM policy_settings
     WHERE model_id = ${modelId}::uuid AND key = 'import_batch_scope' AND account_id IS NULL
       AND item_type IS NULL AND value IS NOT NULL`)
  const value = rows[0]?.value as { resource_ids?: unknown } | unknown[] | undefined
  const list = Array.isArray(value) ? value : (value as { resource_ids?: unknown })?.resource_ids
  return Array.isArray(list) ? new Set(list.map(String)) : null
}

export async function importBytes(ctx: WorkContext): Promise<WorkSuccess> {
  const { db, work } = ctx
  const modelId = work.modelId as string
  const input = (work.checkpoint as { input?: BytesInput } | null)?.input
  if (!input || input.roots.length === 0) {
    throw new WorkError('permanent', 'no_roots', 'импорт байтов без корней')
  }
  const snapshot = await snapshotOf(db, modelId, work.scope)
  if (!snapshot) throw new WorkError('permanent', 'snapshot_missing', 'нет готового снимка')
  // Order of SPEC §6.4: the metadata pass reserves the numbers before any byte is accepted.
  const { rows: unreserved } = await db.execute<{ type: string }>(sql`
    SELECT type FROM id_counters
     WHERE model_id = ${modelId}::uuid AND legacy_reserved_at IS NULL`)
  if (unreserved.length > 0) {
    throw new WorkError(
      'permanent',
      'not_reserved',
      `сначала разбор старых имён: номера ${unreserved.map((r) => r.type).join(', ')} не зарезервированы`,
    )
  }
  const listing = await snapshotListing(db, snapshot)
  if (!input.force) await checkOrder(db, snapshot, listing, input.roots)
  const inputs = await readInputs(db, modelId)
  const { rows: model } = await db.execute<{ code: string; title: string; timezone: string }>(sql`
    SELECT code, title, timezone FROM models WHERE id = ${modelId}::uuid`)
  const { code, title, timezone } = model[0] as { code: string; title: string; timezone: string }
  const plan = planLegacyImport(listing, { registry: inputs.registry })
  const parsed = new Map<string, ParsedLegacyPath>(plan.entries.map((e) => [e.path, e]))
  const byPath = new Map(listing.map((e) => [e.relative, e]))

  const inScope = (path: string) =>
    input.roots.includes(rootOf(path)) &&
    (input.folder === null || path === input.folder || path.startsWith(`${input.folder}/`))
  const containers = new Set(
    listing.flatMap((e) => (e.archiveEntry ? [e.archiveEntry.archivePath] : [])),
  )
  const files = listing.filter(
    (e) =>
      !e.isDir &&
      e.revisionId &&
      !containers.has(e.relative) &&
      inScope(e.archiveEntry ? e.archiveEntry.archivePath : e.relative),
  )
  const media = files.filter((e) => mediaKindOf(e.relative, e.mediaType ?? null) !== null)
  const units = legacyUnits({
    files: media,
    byPath,
    parsed,
    registry: inputs.registry,
    timezone,
  })
  const scope = await batchScope(db, modelId)
  const report: BytesReport = {
    mode: 'bytes',
    snapshot: snapshot.workKey,
    roots: input.roots,
    folder: input.folder,
    units: units.length,
    groups_new: 0,
    drafts_new: 0,
    drafts_moved: 0,
    deferred: 0,
    fetch_queued: 0,
    unpack_queued: 0,
    not_media: files.length - media.length,
    accepted_now: 0,
    aliased_now: 0,
    queued: {},
    waiting: 0,
  }
  const groupIds: string[] = []
  let step = 0
  for (const unit of units) {
    const id = await withActorTx(
      db,
      {
        actor: SYSTEM_ACTOR('import'),
        action: 'legacy.bytes',
        requestId: `import:${work.id}:${step++}`,
        workId: work.id,
      },
      (tx) => writeUnit(tx, snapshot, unit, scope, report),
    )
    groupIds.push(id)
    await ctx.checkpoint({
      progress: { num: step, den: units.length, note: `импорт байтов: ${unit.path}` },
    })
  }
  // What became ready since the last run is accepted now (a repeat of the command).
  const scopeModel = { id: modelId, code, name: title }
  for (const groupId of groupIds) {
    const outcome = await withActorTx(
      db,
      {
        actor: SYSTEM_ACTOR('импорт'),
        action: 'legacy.accept',
        requestId: `import:${work.id}:accept:${groupId}`,
        workId: work.id,
      },
      (tx) => autoAcceptGroup(tx, scopeModel, groupId),
    )
    if (outcome.kind === 'accepted') report.accepted_now += 1
    else if (outcome.kind === 'alias') report.aliased_now += 1
    else if (outcome.kind === 'queue') {
      report.queued[outcome.reason] = (report.queued[outcome.reason] ?? 0) + 1
    } else if (outcome.reason !== 'nothing_open') report.waiting += 1
  }
  return { report }
}

/** One unit: its group (fields from the old name on creation), drafts and the work for bytes. */
async function writeUnit(
  tx: Tx,
  snapshot: SnapshotWork,
  unit: LegacyUnit,
  scope: Set<string> | null,
  report: BytesReport,
): Promise<string> {
  const modelId = snapshot.modelId
  const split = unit.archiveFolders.length > 1
  const evidence = {
    ...unit.evidence,
    root: unit.root,
    path: unit.folder?.raw ?? unit.path,
    number: unit.number,
    snapshot: snapshot.id,
  }
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO inbox_groups (
      model_id, source_id, group_key, grouping, folder_object_id, evidence, proposed_type,
      proposed_title, proposed_title_en, proposed_tags, proposed_ppv_kind, proposed_purpose
    ) VALUES (
      ${modelId}::uuid, ${snapshot.sourceId}::uuid, ${unit.key}, ${unit.grouping},
      ${unit.folder?.objectId ?? null}::uuid, ${JSON.stringify(evidence)}::jsonb, ${unit.type},
      ${unit.title}, ${unit.titleEn}, ${JSON.stringify(unit.tags)}::jsonb,
      ${unit.type === 'PPV' ? (unit.ppvKind ?? 'bundle') : null},
      ${unit.type === 'RAW' ? (unit.purpose ?? 'unknown') : null}
    )
    ON CONFLICT (model_id, source_id, group_key) DO NOTHING
    RETURNING id`)
  let groupId = inserted.rows[0]?.id
  if (groupId) report.groups_new += 1
  else {
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM inbox_groups
       WHERE model_id = ${modelId}::uuid AND source_id = ${snapshot.sourceId}::uuid
         AND group_key = ${unit.key}`)
    groupId = (rows[0] as { id: string }).id
  }
  const archives = new Set<string>()
  for (const file of unit.files) {
    const revisionId = file.revisionId as string
    const { rows: existing } = await tx.execute<{
      id: string
      group_id: string
      state: string
    }>(sql`
      SELECT id, group_id, state FROM inbox_drafts
       WHERE model_id = ${modelId}::uuid AND source_revision_id = ${revisionId}::uuid FOR UPDATE`)
    const found = existing[0]
    if (found) {
      // A draft the scan made for the same revision joins the unit while it is open.
      if (found.state !== 'resolved' && found.group_id !== groupId) {
        await tx.execute(sql`
          UPDATE inbox_drafts SET group_id = ${groupId}::uuid, updated_at = now(),
                 row_version = row_version + 1
           WHERE model_id = ${modelId}::uuid AND id = ${found.id}::uuid`)
        report.drafts_moved += 1
      }
      continue
    }
    const member = file.archiveEntry !== null && file.archiveEntry !== undefined
    const resource = member ? (unit.folder?.resourceId ?? null) : (file.resourceId ?? null)
    const deferred = scope !== null && (resource === null || !scope.has(resource))
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO inbox_drafts (
        model_id, group_id, source_revision_id, origin, priority, md5, byte_size, path,
        blocked_reason
      ) VALUES (
        ${modelId}::uuid, ${groupId}::uuid, ${revisionId}::uuid,
        ${member ? 'archive' : 'legacy_import'}, 1,
        ${file.md5 ? Buffer.from(file.md5, 'hex') : null}::bytea, ${file.size ?? 0},
        ${file.raw},
        ${deferred ? 'deferred' : split ? 'archive_split' : null}
      )
      RETURNING id`)
    const draftId = (rows[0] as { id: string }).id
    report.drafts_new += 1
    if (deferred) {
      report.deferred += 1
      continue
    }
    if (member && unit.folder?.revisionId) {
      archives.add(unit.folder.revisionId)
      continue
    }
    const { created } = await enqueueWork(tx, {
      modelId,
      kind: 'fetch',
      workKey: `fetch:${revisionId}`,
      sourceRevisionId: revisionId,
      draftId,
      // The old corpus goes after the new (SPEC §12.0): the lowest priority of intake.
      priority: 1,
    })
    if (created) report.fetch_queued += 1
  }
  for (const archive of archives) {
    const { created } = await enqueueWork(tx, {
      modelId,
      kind: 'unpack_archive',
      workKey: `unpack:${archive}`,
      sourceRevisionId: archive,
      priority: 1,
    })
    if (created) report.unpack_queued += 1
  }
  return groupId
}

export { ROOTS }
