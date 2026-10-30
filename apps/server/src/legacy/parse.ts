import { createHash } from 'node:crypto'
import {
  type Db,
  enqueueWork,
  logAction,
  type Queryable,
  SYSTEM_ACTOR,
  type Tx,
  type WorkContext,
  WorkError,
  type WorkHandler,
  type WorkRow,
  withActorTx,
} from '@contentops/db'
import {
  ITEM_TYPE_CODES,
  type ItemTypeCode,
  type LegacyClaim,
  type LegacyImportPlan,
  type LegacyPlanReport,
  type NumberClaimPlan,
  PARSER_VERSION,
  planLegacyImport,
  summarizePlan,
} from '@contentops/legacy'
import { sql } from 'drizzle-orm'
import { localDay, looseGroupOf, mediaKindOf, UPLOAD_CLUSTER_MS } from '../intake/grouping'
import { BYTES_DATASET, importBytes } from './bytes'
import { type ImportInputs, readInputs } from './inputs'
import { RECONCILE_DATASET, reconcileWork } from './reconcile'
import { type SnapshotEntry, type SnapshotWork, snapshotListing, snapshotOf } from './snapshot'

/**
 * The work `import_parse` (SPEC §6.3–6.4, schema §3.4, §9.7), role `worker`: the metadata pass
 * over a frozen snapshot. It runs the parser `@contentops/legacy` over the snapshot rows and
 * writes what the names claim — `legacy_claims`, `legacy_number_claims` with the §6.4 decision,
 * review cases — and, last, reserves the numbers of every type upwards. No object, no byte:
 * acceptance comes after, folder by folder.
 *
 * - `dataset = 'parse'`, `work_key = import:parse:<snapshot>:<rules>`: one per snapshot and
 *   rules version; the same version writes nothing again, a new one closes the open claims of
 *   the old (`ignored` with a link to the successor).
 * - `dataset = 'plan'`: the dry run (`import plan`) — the same parse, nothing written but the
 *   report on the work row.
 *
 * The reserve is written in the transaction that finishes the work, after every readable input
 * is parsed; an unreadable archive or folder is incomplete input (its review case is opened by
 * the snapshot) and does not hold it.
 */

export const IMPORT_KIND = 'import_parse'
export type ImportMode = 'parse' | 'plan'

export const parseKey = (snapshotId: string, version = PARSER_VERSION) =>
  `import:parse:${snapshotId}:${version}`
export const planKey = (snapshotId: string, nonce: string) =>
  `import:plan:${snapshotId}:${PARSER_VERSION}:${nonce}`

/** The source of rows that are no files: the PPV registry and vault album titles (schema §9.7). */
export const METADATA_SOURCE = 'Легаси: реестр и альбомы'

/** Claims per insert transaction. */
const BATCH = 1000

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** What the import works do with a snapshot: the pass, the dry run, the bytes, the reconciliation. */
export type ImportRun = ImportMode | 'bytes' | 'reconcile'

/**
 * Puts an import work over a finished snapshot. The pass is one per snapshot and rules (a repeat
 * finds it); the dry run, the bytes and the reconciliation run anew for every request.
 */
export async function enqueueImport(
  tx: Tx,
  input: {
    modelId: string
    mode: ImportRun
    snapshot: SnapshotWork
    nonce: string
    input?: unknown
  },
): Promise<{ work: WorkRow; created: boolean }> {
  const workKey =
    input.mode === 'parse'
      ? parseKey(input.snapshot.id)
      : input.mode === 'plan'
        ? planKey(input.snapshot.id, input.nonce)
        : `import:${input.mode}:${input.snapshot.id}:${input.nonce}`
  return enqueueWork(tx, {
    modelId: input.modelId,
    kind: IMPORT_KIND,
    workKey,
    dataset: input.mode,
    scope: input.snapshot.id,
    priority: 20,
    ...(input.input === undefined ? {} : { checkpoint: { input: input.input } }),
  })
}

export interface WrittenCounts {
  claims_new: number
  claims_total: number
  superseded: number
  number_claims_new: number
  cases_new: Record<string, number>
  reserve: { type: ItemTypeCode; before: number; after: number; reserved_now: boolean }[]
}

export type ImportReport = LegacyPlanReport & { written?: WrittenCounts }

export function importParseHandler(): WorkHandler {
  return async (ctx) => {
    const { work, db } = ctx
    const modelId = work.modelId
    if (!modelId) throw new WorkError('permanent', 'no_model', 'разбор легаси без модели')
    // The byte half of the import and the reconciliation are works of the same kind.
    if (work.dataset === BYTES_DATASET) return importBytes(ctx)
    if (work.dataset === RECONCILE_DATASET) return reconcileWork(ctx)
    const mode: ImportMode = work.dataset === 'plan' ? 'plan' : 'parse'
    const snapshot = await snapshotOf(db, modelId, work.scope)
    if (!snapshot) {
      throw new WorkError('permanent', 'snapshot_missing', `нет готового снимка ${work.scope}`)
    }
    await ctx.checkpoint({ progress: { num: 0, note: 'разбор: чтение снимка' } })
    const listing = await snapshotListing(db, snapshot)
    const inputs = await readInputs(db, modelId)
    const model = await modelOf(db, modelId)
    const plan = planLegacyImport(listing, {
      registry: inputs.registry,
      currentCounters: await countersOf(db, modelId),
      vaultAlbums: inputs.vaultAlbums,
      foreignModelNames: model.foreign,
    })
    const report: ImportReport = summarizePlan(plan, {
      mode,
      model: model.code,
      snapshot: {
        work_id: snapshot.id,
        work_key: snapshot.workKey,
        source: snapshot.sourceLabel,
        finished_at: new Date(snapshot.finishedAt).toISOString(),
      },
      registry_rows: inputs.registry.length,
      vault_albums: inputs.vaultAlbums.length,
    })
    if (mode === 'plan') return { report }

    const written = await writePass(ctx, { modelId, model, snapshot, listing, plan, inputs })
    report.written = written
    return {
      report,
      // The reserve goes with the success of the work, only by the holder of its lease.
      commit: async (tx) => {
        written.reserve = await reserveNumbers(tx, modelId, work.id, plan)
        await logAction(tx, {
          modelId,
          action: 'legacy.reserve',
          subjectKind: 'work_operations',
          subjectId: work.id,
          subjectLabel: `Разбор снимка ${snapshot.workKey}`,
          after: {
            Правила: PARSER_VERSION,
            'Новых заявок': String(written.claims_new),
            'Заявок номеров': String(written.number_claims_new),
            Резерв: written.reserve
              .filter((r) => r.after !== r.before)
              .map((r) => `${r.type} ${r.before}→${r.after}`)
              .join(', '),
          },
        })
      },
    }
  }
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────

interface ModelInfo {
  code: string
  timezone: string
  /** Titles and codes of the other models: their root archives are parked. */
  foreign: string[]
}

async function modelOf(q: Queryable, modelId: string): Promise<ModelInfo> {
  const { rows } = await q.execute<{ id: string; code: string; title: string; timezone: string }>(
    sql`SELECT id, code, title, timezone FROM models`,
  )
  const own = rows.find((row) => row.id === modelId)
  if (!own) throw new WorkError('permanent', 'no_model', `нет модели ${modelId}`)
  const foreign = rows
    .filter((row) => row.id !== modelId)
    .flatMap((row) => [row.title, row.code])
    .filter((name) => /^[\p{L}\p{N}]+$/u.test(name))
  return { code: own.code, timezone: own.timezone, foreign: [...new Set(foreign)] }
}

async function countersOf(q: Queryable, modelId: string) {
  const { rows } = await q.execute<{ type: ItemTypeCode; next_number: number }>(sql`
    SELECT type, next_number FROM id_counters WHERE model_id = ${modelId}::uuid`)
  return Object.fromEntries(rows.map((row) => [row.type, row.next_number]))
}

// ── The pass ──────────────────────────────────────────────────────────────────────────

interface PassInput {
  modelId: string
  model: ModelInfo
  snapshot: SnapshotWork
  listing: SnapshotEntry[]
  plan: LegacyImportPlan
  inputs: ImportInputs
}

interface ClaimRow {
  object_id: string
  revision_id: string | null
  claim_key: string
  raw_fragment: string
  claim_kind: string
  payload: unknown
}

function claimRow(objectId: string, revisionId: string | null, claim: LegacyClaim): ClaimRow {
  return {
    object_id: objectId,
    revision_id: revisionId,
    claim_key: claim.claim_key,
    raw_fragment: claim.raw_fragment,
    claim_kind: claim.kind,
    payload: claim.payload,
  }
}

async function writePass(ctx: WorkContext, input: PassInput): Promise<WrittenCounts> {
  const { db, work } = ctx
  const { modelId, plan, listing, inputs } = input
  let step = 0
  const tx = <T>(fn: (tx: Tx) => Promise<T>) =>
    withActorTx(
      db,
      {
        actor: SYSTEM_ACTOR('import'),
        action: 'legacy.parse',
        requestId: `import:${work.id}:${step++}`,
        workId: work.id,
      },
      fn,
    )
  const byPath = anchors(listing, plan)

  // Rows of the registry and of vault albums: objects of the metadata source.
  const meta = await tx((t) => metadataObjects(t, modelId, inputs, plan))

  const rows: ClaimRow[] = []
  for (const parsed of plan.entries) {
    const entry = byPath.get(parsed.path)
    if (!entry) continue
    for (const claim of parsed.claims) rows.push(claimRow(entry.objectId, entry.revisionId, claim))
  }
  for (const claim of inputs.registry) {
    const objectId = meta.registry.get(claim.claim_key)
    if (objectId) rows.push(claimRow(objectId, null, claim))
  }
  for (const claim of plan.numberClaims) {
    if (claim.source.kind !== 'evidence') continue
    const objectId = meta.albums.get(albumKey(claim.source.source, claim.source.text))
    if (!objectId) continue
    rows.push({
      object_id: objectId,
      revision_id: null,
      claim_key: `vault:number:${claim.type}:${claim.claimedNumber}`,
      raw_fragment: claim.source.text,
      claim_kind: 'number',
      payload: {
        type: claim.type,
        number: claim.claimedNumber,
        form: 'evidence',
        reserves: true,
        source: claim.source.source,
      },
    })
  }

  let claimsNew = 0
  for (let at = 0; at < rows.length; at += BATCH) {
    const chunk = rows.slice(at, at + BATCH)
    claimsNew += await tx((t) => insertClaims(t, modelId, work.id, chunk))
    await ctx.checkpoint({
      progress: {
        num: Math.min(at + BATCH, rows.length),
        den: rows.length,
        note: 'разбор: заявки',
      },
    })
  }

  const objectIds = [...new Set(rows.map((row) => row.object_id))]
  const superseded = await tx((t) => supersede(t, modelId, objectIds))
  const numberClaimsNew = await tx((t) =>
    writeNumberClaims(t, modelId, plan.numberClaims, byPath, meta),
  )
  const casesNew = await tx((t) => openCases(t, input, byPath))
  return {
    claims_new: claimsNew,
    claims_total: rows.length,
    superseded,
    number_claims_new: numberClaimsNew,
    cases_new: casesNew,
    reserve: [],
  }
}

/**
 * Path → the entry whose object holds its claims. A folder the listing does not have by itself
 * — a folder inside a ZIP without its own entry — holds its claims on the nearest listed
 * ancestor, the archive (its claim keys carry its own name, so they never clash).
 */
function anchors(
  listing: readonly SnapshotEntry[],
  plan: LegacyImportPlan,
): Map<string, SnapshotEntry> {
  const byPath = new Map(listing.map((entry) => [entry.relative, entry]))
  for (const parsed of plan.entries) {
    if (byPath.has(parsed.path) || !parsed.context.archive) continue
    const parts = parsed.path.split('/')
    for (let n = parts.length - 1; n > 0; n--) {
      const holder = byPath.get(parts.slice(0, n).join('/'))
      if (holder) {
        byPath.set(parsed.path, holder)
        break
      }
    }
  }
  return byPath
}

const albumKey = (source: string, title: string) => `vault:${hash(`${source}\n${title}`)}`

interface MetadataObjects {
  /** Registry claim key → object. */
  registry: Map<string, string>
  /** `vault:<hash>` → object. */
  albums: Map<string, string>
}

async function metadataObjects(
  tx: Tx,
  modelId: string,
  inputs: ImportInputs,
  plan: LegacyImportPlan,
): Promise<MetadataObjects> {
  const albums = plan.numberClaims.flatMap((claim) =>
    claim.source.kind === 'evidence'
      ? [{ source: claim.source.source, title: claim.source.text }]
      : [],
  )
  const objects = [
    ...inputs.registry.map((claim) => ({
      resource_id: claim.claim_key,
      path: `реестр PPV/${claim.payload.folder}`,
      name: claim.payload.folder,
    })),
    ...albums.map((album) => ({
      resource_id: albumKey(album.source, album.title),
      path: `vault/${album.source}/${album.title}`,
      name: album.title,
    })),
  ]
  if (objects.length === 0) return { registry: new Map(), albums: new Map() }
  await tx.execute(sql`
    INSERT INTO sources (model_id, kind, label, read_only)
    VALUES (${modelId}::uuid, 'legacy_metadata', ${METADATA_SOURCE}, true)
    ON CONFLICT (model_id, label) DO NOTHING`)
  const { rows } = await tx.execute<{ id: string; resource_id: string }>(sql`
    WITH source AS (
      SELECT id FROM sources WHERE model_id = ${modelId}::uuid AND label = ${METADATA_SOURCE}
    ), inserted AS (
      INSERT INTO source_objects (model_id, source_id, resource_id, current_path, current_name)
      SELECT ${modelId}::uuid, (SELECT id FROM source), x.resource_id, x.path, x.name
        FROM jsonb_to_recordset(${JSON.stringify(objects)}::jsonb)
             AS x(resource_id text, path text, name text)
      ON CONFLICT (model_id, source_id, resource_id) DO NOTHING
      RETURNING id, resource_id
    )
    SELECT id, resource_id FROM inserted
    UNION ALL
    SELECT o.id, o.resource_id FROM source_objects o
     WHERE o.model_id = ${modelId}::uuid AND o.source_id = (SELECT id FROM source)`)
  const byKey = new Map(rows.map((row) => [row.resource_id, row.id]))
  return {
    registry: new Map(
      inputs.registry.flatMap((claim) => {
        const id = byKey.get(claim.claim_key)
        return id ? [[claim.claim_key, id] as const] : []
      }),
    ),
    albums: new Map(
      albums.flatMap((album) => {
        const key = albumKey(album.source, album.title)
        const id = byKey.get(key)
        return id ? [[key, id] as const] : []
      }),
    ),
  }
}

async function insertClaims(
  tx: Tx,
  modelId: string,
  workId: string,
  rows: ClaimRow[],
): Promise<number> {
  const { rows: inserted } = await tx.execute<{ id: string }>(sql`
    INSERT INTO legacy_claims (
      model_id, source_object_id, source_revision_id, parser_version, claim_key, raw_fragment,
      claim_kind, payload, parse_work_id
    )
    SELECT ${modelId}::uuid, x.object_id, x.revision_id, ${PARSER_VERSION}, x.claim_key,
           x.raw_fragment, x.claim_kind, x.payload, ${workId}::uuid
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
           AS x(object_id uuid, revision_id uuid, claim_key text, raw_fragment text,
                claim_kind text, payload jsonb)
    ON CONFLICT (model_id, source_object_id, parser_version, claim_key) DO NOTHING
    RETURNING id`)
  return inserted.length
}

/**
 * Open claims of earlier rules on the objects of this pass are closed: `ignored` with a link to
 * the claim of the same input and position in the current rules, or without one when the
 * current rules no longer see it (schema §3.4: claims never double).
 */
async function supersede(tx: Tx, modelId: string, objectIds: string[]): Promise<number> {
  if (objectIds.length === 0) return 0
  const linked = await tx.execute(sql`
    UPDATE legacy_claims old
       SET resolution = 'ignored', superseded_by_id = succ.id, row_version = old.row_version + 1
      FROM legacy_claims succ
     WHERE old.model_id = ${modelId}::uuid AND old.resolution = 'pending'
       AND old.parser_version <> ${PARSER_VERSION}
       AND old.source_object_id = ANY (${sql.param(objectIds)}::uuid[])
       AND succ.model_id = old.model_id AND succ.source_object_id = old.source_object_id
       AND succ.claim_key = old.claim_key AND succ.parser_version = ${PARSER_VERSION}`)
  const rest = await tx.execute(sql`
    UPDATE legacy_claims
       SET resolution = 'ignored', row_version = row_version + 1
     WHERE model_id = ${modelId}::uuid AND resolution = 'pending'
       AND parser_version <> ${PARSER_VERSION}
       AND source_object_id = ANY (${sql.param(objectIds)}::uuid[])`)
  return (linked.rowCount ?? 0) + (rest.rowCount ?? 0)
}

type StoredClaim = {
  id: string
  source_object_id: string
  claim_kind: string
  payload: { type?: string; number?: number; reserves?: boolean; row?: number }
  claim_key: string
} & Record<string, unknown>

/**
 * `legacy_number_claims` (schema §3.4): a row per claim of an old number with the §6.4 decision
 * of the rules; the parser decides now (`decided_by` empty), a person confirms or changes it
 * in «Разбор старого». A decision a person made on the claim of the earlier rules carries over.
 */
async function writeNumberClaims(
  tx: Tx,
  modelId: string,
  claims: readonly NumberClaimPlan[],
  byPath: Map<string, SnapshotEntry>,
  meta: MetadataObjects,
): Promise<number> {
  if (claims.length === 0) return 0
  const { rows: stored } = await tx.execute<StoredClaim>(sql`
    SELECT id, source_object_id, claim_kind, payload, claim_key FROM legacy_claims
     WHERE model_id = ${modelId}::uuid AND parser_version = ${PARSER_VERSION}
       AND claim_kind IN ('number', 'registry_row')`)
  const byObject = new Map<string, StoredClaim[]>()
  for (const claim of stored) {
    byObject.set(claim.source_object_id, [...(byObject.get(claim.source_object_id) ?? []), claim])
  }
  const registryByRow = new Map<number, string>()
  for (const claim of stored) {
    if (claim.claim_kind === 'registry_row' && claim.payload.row !== undefined) {
      registryByRow.set(claim.payload.row, claim.id)
    }
  }
  const numberOn = (objectId: string | undefined, type: string, number: number) =>
    (objectId ? (byObject.get(objectId) ?? []) : []).find(
      (claim) =>
        claim.claim_kind === 'number' &&
        claim.payload.type === type &&
        claim.payload.number === number &&
        claim.payload.reserves === true,
    )?.id

  const rows = claims.flatMap((claim) => {
    let claimId: string | undefined
    let objectId: string | undefined
    const source = claim.source
    if (source.kind === 'path') {
      objectId = byPath.get(source.path)?.objectId
      claimId = numberOn(objectId, claim.type, claim.claimedNumber)
    } else if (source.kind === 'registry') {
      objectId = meta.registry.get(source.claimKey)
      claimId = (objectId ? (byObject.get(objectId) ?? []) : []).find(
        (c) => c.claim_kind === 'registry_row',
      )?.id
    } else {
      objectId = meta.albums.get(albumKey(source.source, source.text))
      claimId = numberOn(objectId, claim.type, claim.claimedNumber)
    }
    if (!claimId || !objectId) return []
    const registryClaimId =
      source.kind !== 'registry' && claim.registryRow !== null
        ? (registryByRow.get(claim.registryRow) ?? null)
        : null
    return [
      {
        type: claim.type,
        claimed_number: claim.claimedNumber,
        object_id: objectId,
        claim_id: claimId,
        registry_claim_id: registryClaimId,
        decision: claim.decision,
        assigned_number: claim.assignedNumber,
      },
    ]
  })
  const { rows: inserted } = await tx.execute<{ id: string }>(sql`
    INSERT INTO legacy_number_claims (
      model_id, type, claimed_number, source_object_id, claim_id, registry_claim_id, decision,
      assigned_number, decided_at
    )
    SELECT ${modelId}::uuid, x.type, x.claimed_number, x.object_id, x.claim_id,
           x.registry_claim_id, x.decision, x.assigned_number, now()
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
           AS x(type text, claimed_number integer, object_id uuid, claim_id uuid,
                registry_claim_id uuid, decision text, assigned_number integer)
    ON CONFLICT (model_id, claim_id) DO NOTHING
    RETURNING id`)
  if (inserted.length > 0) {
    await tx.execute(sql`
      UPDATE legacy_number_claims n
         SET decision = o.decision, assigned_number = o.assigned_number,
             decided_at = o.decided_at, decided_by = o.decided_by, row_version = n.row_version + 1
        FROM legacy_number_claims o
        JOIN legacy_claims oc ON oc.model_id = o.model_id AND oc.id = o.claim_id
       WHERE n.model_id = ${modelId}::uuid AND o.model_id = n.model_id
         AND n.id = ANY (${sql.param(inserted.map((row) => row.id))}::uuid[])
         AND oc.superseded_by_id = n.claim_id AND o.decided_by IS NOT NULL`)
  }
  return inserted.length
}

// ── Review cases ──────────────────────────────────────────────────────────────────────

interface CaseRow {
  kind: 'legacy_unparsed' | 'smm_folder' | 'number_hole' | 'merge_split'
  key: string
  object_id: string | null
  details: Record<string, unknown>
}

const rootOf = (path: string) => path.split('/')[0] ?? ''
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** Files right in a root, grouped as intake groups them (SPEC §6.1): 1–2 files — a short shoot. */
export function shortShoots(
  listing: readonly SnapshotEntry[],
  timezone: string,
): { key: string; root: string; day: string; files: SnapshotEntry[] }[] {
  const loose = listing.filter(
    (entry) =>
      !entry.isDir &&
      !entry.archiveEntry &&
      entry.relative.split('/').length === 2 &&
      rootOf(entry.relative) !== 'Старый формат' &&
      mediaKindOf(nameOf(entry.relative), entry.mediaType ?? null) !== null,
  )
  const groups = new Map<string, { root: string; day: string; files: SnapshotEntry[] }>()
  const clusters = new Map<string, number>()
  const ordered = [...loose].sort((a, b) =>
    (a.createdAt ?? '') < (b.createdAt ?? '')
      ? -1
      : (a.createdAt ?? '') > (b.createdAt ?? '')
        ? 1
        : 0,
  )
  for (const file of ordered) {
    const root = rootOf(file.relative)
    const media = mediaKindOf(nameOf(file.relative), file.mediaType ?? null)
    const group = looseGroupOf(
      {
        fileId: file.objectId,
        isVideo: media === 'video',
        shotAt: file.shotAt ?? null,
        rootName: root,
      },
      root,
      timezone,
    )
    if (group.grouping === 'single') continue
    let key: string
    let day: string
    if (group.grouping === 'exif_day') {
      key = group.key
      day = group.day
    } else {
      const at = Date.parse(file.createdAt ?? '')
      const start = clusters.get(root)
      if (Number.isNaN(at)) continue
      const fits = start !== undefined && at >= start && at < start + UPLOAD_CLUSTER_MS
      if (!fits) clusters.set(root, at)
      key = `${group.prefix}${new Date(clusters.get(root) as number).toISOString()}`
      day = localDay(file.createdAt as string, timezone)
    }
    const into = groups.get(key) ?? { root, day, files: [] }
    into.files.push(file)
    groups.set(key, into)
  }
  return [...groups.entries()]
    .filter(([, group]) => group.files.length <= 2)
    .map(([key, group]) => ({ key, ...group }))
}

const dayText = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`

async function openCases(
  tx: Tx,
  input: PassInput,
  byPath: Map<string, SnapshotEntry>,
): Promise<Record<string, number>> {
  const { plan, modelId } = input
  const work = { parser_version: PARSER_VERSION }
  const cases: CaseRow[] = []
  for (const unparsed of plan.unparsed) {
    const entry = byPath.get(unparsed.path)
    if (!entry) continue
    cases.push({
      kind: 'legacy_unparsed',
      key: `unparsed:${entry.objectId}`,
      object_id: entry.objectId,
      details: {
        ...work,
        title: nameOf(unparsed.path),
        root: rootOf(unparsed.path),
        path: unparsed.path,
        fragment: unparsed.fragments.join(' · '),
        fragments: unparsed.fragments,
        is_dir: unparsed.isDir,
      },
    })
  }
  for (const folder of plan.smmFolders) {
    const entry = byPath.get(folder.path)
    if (!entry) continue
    cases.push({
      kind: 'smm_folder',
      key: `smm:${entry.objectId}`,
      object_id: entry.objectId,
      details: {
        ...work,
        title: folder.path.split('/').slice(1).join(' / '),
        root: rootOf(folder.path),
        path: folder.path,
        channel: folder.channel,
        files: folder.files,
        bytes: folder.bytes,
        first_upload: folder.firstUpload,
        last_upload: folder.lastUpload,
      },
    })
  }
  for (const hole of plan.sextings) {
    if (hole.status !== 'hole') continue
    const id = `SXT-${String(hole.number).padStart(3, '0')}`
    cases.push({
      kind: 'number_hole',
      key: `hole:${id}`,
      object_id: null,
      details: {
        ...work,
        title: `${id}: следов нет`,
        root: '5. Sextings',
        type: 'SXT',
        number: hole.number,
      },
    })
  }
  for (const shoot of shortShoots(input.listing, input.model.timezone)) {
    const [first] = shoot.files
    if (!first) continue
    const count = shoot.files.length
    cases.push({
      kind: 'merge_split',
      key: `short:${first.objectId}`,
      object_id: first.objectId,
      details: {
        ...work,
        title: `${count === 1 ? 'Сырьё из 1 файла' : `Сырьё из ${count} файлов`} · ${dayText(shoot.day)}`,
        root: shoot.root,
        fragment: shoot.files.map((file) => `${shoot.root} / ${nameOf(file.relative)}`).join(' · '),
        day: shoot.day,
        group_key: shoot.key,
        objects: shoot.files.map((file) => file.objectId),
      },
    })
  }
  const { rows } = await tx.execute<{ kind: string }>(sql`
    INSERT INTO review_cases (model_id, kind, dedup_key, source_object_id, details)
    SELECT ${modelId}::uuid, x.kind, x.key, x.object_id, x.details
      FROM jsonb_to_recordset(${JSON.stringify(cases)}::jsonb)
           AS x(kind text, key text, object_id uuid, details jsonb)
    ON CONFLICT (model_id, kind, dedup_key) DO NOTHING
    RETURNING kind`)
  // A number that now has a source is no hole any more (SPEC §6.4).
  const named = plan.sextings
    .filter((s) => s.status === 'reserve')
    .map((s) => `hole:SXT-${String(s.number).padStart(3, '0')}`)
  if (named.length > 0) {
    await tx.execute(sql`
      UPDATE review_cases
         SET state = 'dismissed', resolved_at = now(),
             resolution = ${JSON.stringify({ option: 'named_by_source', rules: PARSER_VERSION })}::jsonb,
             row_version = row_version + 1
       WHERE model_id = ${modelId}::uuid AND kind = 'number_hole' AND state = 'open'
         AND dedup_key = ANY (${sql.param(named)}::text[])`)
  }
  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1
  return counts
}

// ── The reserve ───────────────────────────────────────────────────────────────────────

/**
 * `next_number = GREATEST(current, max(claimed) + 1)` for every type, 1 only as the floor; the
 * mark `legacy_reserved_at` with this work (schema §3.1, §9.7). Issued numbers and tombstones are
 * never revisited, a counter above the max stays. A row that would not change is not touched.
 */
export async function reserveNumbers(
  tx: Tx,
  modelId: string,
  workId: string,
  plan: Pick<LegacyImportPlan, 'reserve'>,
): Promise<WrittenCounts['reserve']> {
  const wanted = ITEM_TYPE_CODES.map((type) => {
    const max = plan.reserve.find((r) => r.type === type)?.maxClaimed ?? null
    return { type, next: max === null ? 1 : max + 1 }
  })
  const { rows: before } = await tx.execute<{
    type: ItemTypeCode
    next_number: number
    reserved: boolean
  }>(sql`
    SELECT type, next_number, legacy_reserved_at IS NOT NULL AS reserved FROM id_counters
     WHERE model_id = ${modelId}::uuid ORDER BY type FOR UPDATE`)
  const { rows: after } = await tx.execute<{ type: ItemTypeCode; next_number: number }>(sql`
    UPDATE id_counters c
       SET next_number = greatest(c.next_number, x.next),
           legacy_reserved_at = coalesce(c.legacy_reserved_at, now()),
           legacy_reserved_work_id = CASE WHEN c.legacy_reserved_at IS NULL
                                          THEN ${workId}::uuid ELSE c.legacy_reserved_work_id END,
           updated_at = now()
      FROM jsonb_to_recordset(${JSON.stringify(wanted)}::jsonb) AS x(type text, next integer)
     WHERE c.model_id = ${modelId}::uuid AND c.type = x.type
       AND (c.next_number < x.next OR c.legacy_reserved_at IS NULL)
    RETURNING c.type, c.next_number`)
  return before.map((row) => {
    const changed = after.find((a) => a.type === row.type)
    return {
      type: row.type,
      before: row.next_number,
      after: changed?.next_number ?? row.next_number,
      reserved_now: changed !== undefined && !row.reserved,
    }
  })
}

/** The work of the last pass of the model, for «Разбор старого» and the export. */
export async function lastImportWork(
  db: Db | Tx,
  modelId: string,
  mode: ImportMode,
): Promise<{ id: string; report: ImportReport | null; state: string } | null> {
  const { rows } = await db.execute<{ id: string; report: ImportReport | null; state: string }>(sql`
    SELECT id, report, state FROM work_operations
     WHERE model_id = ${modelId}::uuid AND kind = ${IMPORT_KIND} AND dataset = ${mode}
     ORDER BY (state = 'succeeded') DESC, finished_at DESC NULLS LAST, created_at DESC
     LIMIT 1`)
  return rows[0] ?? null
}
