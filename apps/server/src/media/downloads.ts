import { randomUUID } from 'node:crypto'
import type { DownloadKind } from '@contentops/contracts/commands/objects'
import {
  exportName,
  fanFileName,
  type NameRole,
  type NameSlot,
} from '@contentops/contracts/download-name'
import { enqueueWork, type Queryable, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { PipelineDigests } from './pipeline'
import { readyGeneration } from './renditions'
import { exportKey, extOfName, mimeOfExt, shaHex } from './storage'
import { compatKey, renderKey } from './work/copies'

/**
 * The download path (SPEC §9.3, §10, §11.2; naming §4–6; schema §3.5): what each kind gives,
 * the names, and where the bytes come from. Bytes and names known at once — the receipt is
 * sealed in the command and the answer is `download_url`; otherwise an `export` work (the
 * operation of the 202) waits for the copies, builds what has new bytes in the exports
 * folder and seals the receipt then. «Стереть метаданные» is chosen per download.
 */

export type ItemType = 'PPV' | 'SET' | 'SXT' | 'CUS' | 'FYP' | 'LIFE' | 'RAW' | 'PRM'

/** The object of a download: what its names need. */
export interface DownloadItem {
  id: string
  type: ItemType
  public_id: string
  title: string | null
  title_en: string | null
}

/** A live file of the object at its current (or pinned) version, with its master blob. */
export interface FileRow extends Record<string, unknown> {
  membership_id: string
  kind: 'owned' | 'reference'
  role: NameRole
  ordinal: number | null
  variant_no: number
  display_position: number | null
  selected: boolean
  life_use: string | null
  media_kind: 'video' | 'image'
  asset_id: string
  version_id: string
  version_no: number
  master: Buffer
  ext: string
  byte_size: string
  duration_ms: string | null
  width: number | null
  height: number | null
  blob_state: string
}

export async function loadFiles(q: Queryable, modelId: string, itemId: string): Promise<FileRow[]> {
  const { rows } = await q.execute<FileRow>(sql`
    SELECT m.id AS membership_id, m.kind, m.role, m.ordinal, m.variant_no, m.display_position,
           m.selected, m.life_use, a.media_kind, a.id AS asset_id, v.id AS version_id, v.version_no,
           v.master_sha256 AS master, b.ext, b.byte_size, v.duration_ms, v.width, v.height,
           b.state AS blob_state
      FROM item_memberships m
      JOIN assets a ON a.model_id = m.model_id AND a.id = m.asset_id
      JOIN asset_versions v ON v.model_id = a.model_id
                           AND v.id = coalesce(m.pinned_version_id, a.current_version_id)
      JOIN blobs b ON b.sha256 = v.master_sha256
     WHERE m.model_id = ${modelId}::uuid AND m.item_id = ${itemId}::uuid AND m.removed_at IS NULL
     ORDER BY m.display_position NULLS LAST, m.role, m.ordinal NULLS FIRST, m.variant_no, m.added_at`)
  return rows
}

/** A file's handle (naming §3): `master`, `u2`, `pic03`, `ed07`, `teaser`. */
export function handleOf(file: Pick<FileRow, 'role' | 'ordinal' | 'variant_no'>): string {
  if (file.variant_no > 0) return `u${file.variant_no}`
  return file.ordinal ? `${file.role}${String(file.ordinal).padStart(2, '0')}` : file.role
}

/** Where the bytes of one issued file come from. */
export type Supply =
  /** The stored master as it is (`issued_master`). */
  | { kind: 'master' }
  /** A ready rendition artifact (platform copy). */
  | { kind: 'artifact'; artifactId: string; key: string; sha256: string; bytes: number }
  /** A platform copy still to build (`render`), then served from `derived/`. */
  | { kind: 'render'; workId: string; digest: string; stripped: boolean }
  /** The master stripped of metadata into the exports folder (`export` builds it). */
  | { kind: 'strip' }
  /** The compatible H.264 copy into the exports folder (`render_compat`). */
  | { kind: 'compat'; workId: string }

export interface PlannedFile {
  position: number
  name: string
  file: FileRow
  /** Handle in the manifest snapshot. */
  handle: string
  supply: Supply
}

export interface DownloadPlan {
  receiptId: string
  modelId: string
  modelCode: string
  itemId: string
  publicId: string
  principalId: string
  kind: DownloadKind
  receiptKind: 'master' | 'platform' | 'edit' | 'promo'
  metaStripped: boolean
  slot: NameSlot | null
  /** The plan row the files are for (schema §3.5): the receipt keeps it with the suffix. */
  planRowId?: string | null
  /** Several files go as one ZIP under this name. */
  zipName: string | null
  files: PlannedFile[]
  /** A promo handoff (SPEC §7.1): its own manifest, `manifest.csv` in the ZIP, the handoff row. */
  promo?: PromoIssue
}

/** What the export of a promo handoff needs beyond a download. */
export interface PromoIssue {
  deliveryId: string
  /** The sealed composition of the handoff: the receipt points at it. */
  manifestId: string
  format: 'upload' | 'master' | 'compat'
}

const RECEIPT_KIND: Record<DownloadKind, DownloadPlan['receiptKind']> = {
  platform: 'platform',
  teaser: 'platform',
  fan: 'platform',
  master: 'master',
  source: 'master',
  photos: 'master',
  compat: 'edit',
}

/** Length goes into the name only for PPV and customs (naming §5). */
function durationOf(type: ItemType, file: FileRow): number | null {
  if (
    (type !== 'PPV' && type !== 'CUS') ||
    file.media_kind !== 'video' ||
    file.duration_ms === null
  ) {
    return null
  }
  return Number(file.duration_ms) / 1000
}

const byPosition = (a: FileRow, b: FileRow) =>
  (a.display_position ?? Number.MAX_SAFE_INTEGER) - (b.display_position ?? Number.MAX_SAFE_INTEGER)
const byOrdinal = (a: FileRow, b: FileRow) => (a.ordinal ?? 0) - (b.ordinal ?? 0)

/** The main video: the base master (`u0`), else the first owned video. */
export function mainVideo(files: readonly FileRow[]): FileRow | undefined {
  return (
    files.find((f) => f.role === 'master' && f.variant_no === 0 && f.media_kind === 'video') ??
    files.find((f) => f.media_kind === 'video' && f.role !== 'teaser')
  )
}

export interface Choice {
  file: FileRow
  /** Name role and number; set frames for posting are renumbered `ed01…` (naming §11). */
  role: NameRole
  ordinal: number | null
}

const own = (file: FileRow): Choice => ({ file, role: file.role, ordinal: file.ordinal })

/** What each kind gives (SPEC §9.3, DESIGN §4.5), in posting order. */
export function pickFiles(type: ItemType, files: readonly FileRow[], kind: DownloadKind): Choice[] {
  const photos = files.filter((f) => f.media_kind === 'image')
  const video = mainVideo(files)
  switch (kind) {
    case 'platform': {
      if (type === 'SET') {
        const shot = [...photos].sort(byOrdinal)
        const selected = [...photos].filter((f) => f.selected).sort(byPosition)
        return (selected.length > 0 ? selected : shot).map((file, i) => ({
          file,
          role: 'ed',
          ordinal: i + 1,
        }))
      }
      if (type === 'SXT' || type === 'LIFE' || type === 'PRM') {
        return [...files]
          .filter(
            (f) =>
              f.role !== 'teaser' &&
              (type !== 'LIFE' || f.media_kind === 'video' || f.life_use !== null),
          )
          .sort(byPosition)
          .map(own)
      }
      return video ? [own(video)] : []
    }
    case 'photos':
      return (type === 'SET' ? [...photos].sort(byOrdinal) : [...photos].sort(byPosition)).map(own)
    case 'teaser': {
      const teaser = files.find((f) => f.role === 'teaser')
      return teaser ? [own(teaser)] : []
    }
    case 'fan':
      return type === 'CUS' && video ? [own(video)] : []
    case 'master':
    case 'source':
    case 'compat':
      return video ? [own(video)] : type === 'RAW' && kind !== 'compat' ? files.map(own) : []
  }
}

export interface PlanInput {
  modelId: string
  modelCode: string
  item: DownloadItem
  files: FileRow[]
  kind: DownloadKind
  stripMetadata: boolean
  slot: NameSlot | null
  principalId: string
  digests: PipelineDigests
  /** Files picked on the card (`files:download`): each under its own handle and format. */
  picks?: readonly FileRow[]
  planRowId?: string | null
}

/** What a name needs: the object, the kind and the slot of the plan row (naming §5–6). */
export type NameInput = Pick<PlanInput, 'modelCode' | 'item' | 'kind' | 'slot'>

function nameOf(input: NameInput, pick: Choice, ext: string): string {
  if (input.kind === 'fan') return fanFileName(input.modelCode)
  const main = pick.file.role === 'master'
  return exportName({
    id: input.item.public_id,
    title: input.item.title ?? '',
    title_en: input.item.title_en,
    role: pick.role,
    ordinal: pick.ordinal,
    uniq: pick.file.variant_no > 0 ? pick.file.variant_no : null,
    version: main && pick.file.variant_no === 0 ? pick.file.version_no : null,
    slot: input.slot,
    duration_s: durationOf(input.item.type, pick.file),
    ext,
  })
}

/** The extension the issued file will have: copies are mp4, a stripped HEIC becomes jpg. */
export function issuedExt(kind: DownloadKind, file: FileRow, strip: boolean): string {
  if (file.media_kind === 'video') {
    if (kind === 'platform' || kind === 'teaser' || kind === 'fan' || kind === 'compat')
      return 'mp4'
    return strip ? (file.ext === 'mov' ? 'mov' : 'mp4') : file.ext
  }
  if (strip && !['jpg', 'png'].includes(file.ext)) return 'jpg'
  return file.ext
}

/** The name of one issued file. */
export function issuedName(input: NameInput, pick: Choice, strip: boolean): string {
  return nameOf(input, pick, issuedExt(input.kind, pick.file, strip))
}

/** Several files go as one ZIP named after the first (naming §6). */
export function zipNameOf(input: NameInput, picks: readonly Choice[]): string | null {
  const first = picks[0]
  return picks.length > 1 && first
    ? exportName({
        id: input.item.public_id,
        title: input.item.title ?? '',
        title_en: input.item.title_en,
        role: first.role,
        slot: input.slot,
        ext: 'zip',
      })
    : null
}

/**
 * Where the bytes of one file of an issue come from, enqueuing the copy it needs: a ready
 * platform copy is reused, a missing one is built by `render` (cached for the next issue), a
 * compatible copy by `render_compat` into the exports folder (not kept); otherwise the master,
 * stripped into the exports folder when asked.
 */
export async function supplyOf(
  tx: Tx,
  input: {
    modelId: string
    kind: DownloadKind
    strip: boolean
    digests: PipelineDigests
    file: FileRow
    /** Unique per issued file: `<receipt>/<position>`. */
    compatKey: string
    /** The manager waits: ahead of everything planned in advance (SPEC §12.0). */
    priority: number
  },
): Promise<Supply> {
  const { file, strip } = input
  const copy = input.kind === 'platform' || input.kind === 'teaser' || input.kind === 'fan'
  if (copy && file.media_kind === 'video') {
    const digest = strip ? input.digests.platformStripped : input.digests.platform
    const ready = await readyGeneration(tx, {
      kind: 'platform',
      recipeDigest: digest,
      metaStripped: strip,
      masterSha256: file.master,
      inputSha256: file.master,
    })
    const artifact = ready ? await platformArtifact(tx, ready.id) : null
    if (artifact) return { kind: 'artifact', ...artifact }
    const { work } = await enqueueWork(tx, {
      modelId: input.modelId,
      kind: 'render',
      workKey: renderKey(shaHex(file.master), digest),
      inputSha256: file.master,
      assetVersionId: file.version_id,
      scope: strip ? 'stripped' : 'kept',
      recipeDigest: digest,
      priority: input.priority,
    })
    // A copy that failed before is tried again for a new issue.
    if (work.state === 'failed') {
      await tx.execute(sql`
        UPDATE work_operations SET state = 'retry_wait', attempt_no = 0, next_attempt_at = now(),
               finished_at = NULL, failure_kind = NULL, error_code = NULL, error_text = NULL
         WHERE id = ${work.id}::uuid`)
    }
    return { kind: 'render', workId: work.id, digest, stripped: strip }
  }
  if (input.kind === 'compat' && file.media_kind === 'video') {
    const { work } = await enqueueWork(tx, {
      modelId: input.modelId,
      kind: 'render_compat',
      workKey: compatKey(input.compatKey),
      inputSha256: file.master,
      assetVersionId: file.version_id,
      scope: strip ? 'stripped' : 'kept',
      priority: input.priority,
    })
    return { kind: 'compat', workId: work.id }
  }
  return strip ? { kind: 'strip' } : { kind: 'master' }
}

/**
 * The plan of a download in the command transaction: names, supplies, the works it needs
 * (platform copies and compat copies are enqueued here with the command, SPEC §9.3 «нажал
 * “Для заливки” без плана — собирается сейчас»).
 */
export async function planDownload(tx: Tx, input: PlanInput): Promise<DownloadPlan> {
  const picks = input.picks
    ? input.picks.map(own)
    : pickFiles(input.item.type, input.files, input.kind)
  const receiptId = randomUUID()
  const strip = input.stripMetadata
  const files: PlannedFile[] = []
  for (const [index, pick] of picks.entries()) {
    const file = pick.file
    const supply = await supplyOf(tx, {
      modelId: input.modelId,
      kind: input.kind,
      strip,
      digests: input.digests,
      file,
      compatKey: `${receiptId}/${index + 1}`,
      priority: 1_000_000,
    })
    files.push({
      position: index + 1,
      name: issuedName(input, pick, strip),
      file,
      handle: handleOf(file),
      supply,
    })
  }
  const zipName = files.length > 1 ? zipNameOf(input, picks) : null
  return {
    receiptId,
    modelId: input.modelId,
    modelCode: input.modelCode,
    itemId: input.item.id,
    publicId: input.item.public_id,
    principalId: input.principalId,
    kind: input.kind,
    receiptKind: RECEIPT_KIND[input.kind],
    metaStripped: strip,
    slot: input.slot,
    planRowId: input.planRowId ?? null,
    zipName,
    files,
  }
}

async function platformArtifact(
  q: Queryable,
  generationId: string,
): Promise<{ artifactId: string; key: string; sha256: string; bytes: number } | null> {
  const { rows } = await q.execute<{
    id: string
    storage_key: string
    output_sha256: Buffer
    byte_size: string
  }>(sql`
    SELECT id, storage_key, output_sha256, byte_size FROM rendition_artifacts
     WHERE generation_id = ${generationId}::uuid AND name = 'platform.mp4' AND state = 'ready'`)
  const row = rows[0]
  return row
    ? {
        artifactId: row.id,
        key: row.storage_key,
        sha256: shaHex(row.output_sha256),
        bytes: Number(row.byte_size),
      }
    : null
}

/** Ready at once: one file whose bytes exist (master as is or a built copy). */
export function readyNow(plan: DownloadPlan): boolean {
  return (
    plan.files.length === 1 &&
    plan.files.every((f) => f.supply.kind === 'master' || f.supply.kind === 'artifact')
  )
}

/** One issued file as the receipt records it. */
export interface IssuedFile {
  position: number
  file: FileRow
  handle: string
  name: string
  sha256: string
  bytes: number
  artifactId: string | null
  exportKey: string | null
  issuedMaster: boolean
  width: number | null
  height: number | null
  durationMs: number | null
}

export function issuedFromPlan(planned: PlannedFile): IssuedFile {
  const f = planned.file
  const base = {
    position: planned.position,
    file: f,
    handle: planned.handle,
    name: planned.name,
    width: f.width,
    height: f.height,
    durationMs: f.duration_ms === null ? null : Number(f.duration_ms),
  }
  if (planned.supply.kind === 'artifact') {
    return {
      ...base,
      sha256: planned.supply.sha256,
      bytes: planned.supply.bytes,
      artifactId: planned.supply.artifactId,
      exportKey: null,
      issuedMaster: false,
    }
  }
  return {
    ...base,
    sha256: shaHex(f.master),
    bytes: Number(f.byte_size),
    artifactId: null,
    exportKey: null,
    issuedMaster: true,
  }
}

/**
 * The sealed manifest of one download and its receipt (schema §3.5, §9.2): inserted whole
 * when bytes and names are known; never changed.
 */
export async function sealReceipt(
  tx: Tx,
  plan: DownloadPlan,
  issued: IssuedFile[],
  zipKey: string | null,
): Promise<void> {
  // A promo handoff sealed its composition when it was prepared: the receipt points at it.
  const manifestId = plan.promo?.manifestId ?? randomUUID()
  if (!plan.promo) await sealDownloadManifest(tx, plan, issued, manifestId)
  await tx.execute(sql`
    INSERT INTO download_receipts (model_id, id, principal_id, kind, manifest_id,
                                   account_code_snapshot, slot_date_snapshot, meta_stripped, zip_key,
                                   entry_count, plan_row_id)
    VALUES (${plan.modelId}::uuid, ${plan.receiptId}::uuid, ${plan.principalId}::uuid,
            ${plan.receiptKind}, ${manifestId}::uuid, ${plan.slot?.account ?? null},
            ${plan.slot?.date ?? null}::date, ${plan.metaStripped}, ${zipKey}, ${issued.length},
            ${plan.planRowId ?? null}::uuid)`)
  for (const entry of issued) {
    await tx.execute(sql`
      INSERT INTO download_receipt_entries (model_id, receipt_id, position, asset_id, asset_version_id,
                                            rendition_artifact_id, issued_master, export_key,
                                            file_name, output_sha256, byte_size, duration_ms, width,
                                            height)
      VALUES (${plan.modelId}::uuid, ${plan.receiptId}::uuid, ${entry.position},
              ${entry.file.asset_id}::uuid, ${entry.file.version_id}::uuid,
              ${entry.artifactId}::uuid, ${entry.issuedMaster}, ${entry.exportKey}, ${entry.name},
              ${Buffer.from(entry.sha256, 'hex')}, ${entry.bytes}, ${entry.durationMs},
              ${entry.width}, ${entry.height})`)
  }
}

async function sealDownloadManifest(
  tx: Tx,
  plan: DownloadPlan,
  issued: IssuedFile[],
  manifestId: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO asset_manifests (model_id, id, purpose, origin_item_id, entry_count, created_by)
    VALUES (${plan.modelId}::uuid, ${manifestId}::uuid, 'download', ${plan.itemId}::uuid,
            ${issued.length}, ${plan.principalId}::uuid)`)
  for (const entry of issued) {
    await tx.execute(sql`
      INSERT INTO asset_manifest_entries (model_id, manifest_id, position, item_id, membership_id,
                                          asset_id, asset_version_id, handle_snapshot,
                                          selected_snapshot, life_use_snapshot)
      VALUES (${plan.modelId}::uuid, ${manifestId}::uuid, ${entry.position}, ${plan.itemId}::uuid,
              ${entry.file.membership_id}::uuid, ${entry.file.asset_id}::uuid,
              ${entry.file.version_id}::uuid, ${entry.handle}, ${entry.file.selected},
              ${entry.file.life_use})`)
  }
}

/** `download_url` of a sealed receipt (SPEC §11.2, step two). */
export function downloadUrl(modelCode: string, receiptId: string): string {
  return `/api/v1/${modelCode}/downloads/${receiptId}`
}

/** What `GET download_url` serves for a receipt: the ZIP or its single file. */
export interface ServedFile {
  key: string
  name: string
  mime: string
  bytes: number | null
  sha256: string | null
}

export async function servedFile(
  q: Queryable,
  modelId: string,
  receiptId: string,
): Promise<ServedFile | null> {
  const { rows } = await q.execute<{
    zip_key: string | null
    entry_count: number
    export_key: string | null
    issued_master: boolean
    artifact_key: string | null
    blob_key: string
    file_name: string
    output_sha256: Buffer
    byte_size: string
  }>(sql`
    SELECT r.zip_key, r.entry_count, e.export_key, e.issued_master, ra.storage_key AS artifact_key,
           b.storage_key AS blob_key, e.file_name, e.output_sha256, e.byte_size
      FROM download_receipts r
      JOIN download_receipt_entries e ON e.model_id = r.model_id AND e.receipt_id = r.id
      JOIN asset_versions v ON v.model_id = e.model_id AND v.id = e.asset_version_id
      JOIN blobs b ON b.sha256 = v.master_sha256
      LEFT JOIN rendition_artifacts ra ON ra.id = e.rendition_artifact_id
     WHERE r.model_id = ${modelId}::uuid AND r.id = ${receiptId}::uuid
     ORDER BY e.position LIMIT 1`)
  const row = rows[0]
  if (!row) return null
  if (row.zip_key) {
    const name = row.zip_key.split('/').pop() as string
    return { key: row.zip_key, name, mime: 'application/zip', bytes: null, sha256: null }
  }
  const key = row.export_key ?? row.artifact_key ?? row.blob_key
  return {
    key,
    name: row.file_name,
    mime: mimeOfExt(extOfName(row.file_name)),
    bytes: Number(row.byte_size),
    sha256: shaHex(row.output_sha256),
  }
}

export { exportKey }
