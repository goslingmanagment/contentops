import { randomUUID } from 'node:crypto'
import type { DownloadKind } from '@contentops/contracts/commands/objects'
import type { ContractorFormat } from '@contentops/contracts/domain/promo'
import { type NameRole, promoMemberName } from '@contentops/contracts/download-name'
import type { Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import {
  type DownloadPlan,
  type FileRow,
  type IssuedFile,
  issuedExt,
  type PlannedFile,
  supplyOf,
} from '../media/downloads'
import type { PipelineDigests } from '../media/pipeline'
import { shaHex } from '../media/storage'

/**
 * The issue of a promo handoff (SPEC §7.1, §9.3; naming §6): the same path as a download —
 * ready copies reused, missing ones built by `render` / `render_compat`, masters stripped in
 * the exports folder — under the names `PRM-013_001_RAW-0213-raw03.mp4`, one ZIP with
 * `manifest.csv` last. The export work seals the receipt on the handoff's own manifest and
 * marks the handoff prepared in the same transaction.
 */

/** Which copy each format gives: «для заливки» is the platform copy and the frames as they are. */
export const FORMAT_KIND: Record<ContractorFormat, DownloadKind> = {
  upload: 'platform',
  master: 'master',
  compat: 'compat',
}

const HANDLE = /^(?:u(?<uniq>\d+)|(?<role>[a-z]+?)(?<ordinal>\d{2,3})?)$/

/** `SET-069/ed03` → the source ID and its role for the ZIP name. */
export function sourceOf(handle: string): {
  id: string
  role: NameRole
  ordinal: number | null
  uniq: number | null
  key: string
} {
  const [id = '', key = ''] = handle.split('/')
  const match = HANDLE.exec(key)?.groups ?? {}
  return {
    id,
    key,
    role: (match.role ?? 'master') as NameRole,
    ordinal: match.ordinal ? Number(match.ordinal) : null,
    uniq: match.uniq ? Number(match.uniq) : null,
  }
}

export interface HandoffPlanInput {
  modelId: string
  modelCode: string
  prm: { id: string; publicId: string }
  deliveryId: string
  manifestId: string
  format: ContractorFormat
  strip: boolean
  principalId: string
  digests: PipelineDigests
  zipName: string
  /** The sealed manifest's entries with their files at the pinned versions. */
  files: readonly { position: number; handle: string; file: FileRow }[]
}

export async function planHandoff(tx: Tx, input: HandoffPlanInput): Promise<DownloadPlan> {
  const receiptId = randomUUID()
  const kind = FORMAT_KIND[input.format]
  const files: PlannedFile[] = []
  for (const entry of input.files) {
    const supply = await supplyOf(tx, {
      modelId: input.modelId,
      kind,
      strip: input.strip,
      digests: input.digests,
      file: entry.file,
      compatKey: `${receiptId}/${entry.position}`,
      priority: 500_000,
    })
    const source = sourceOf(entry.handle)
    files.push({
      position: entry.position,
      name: promoMemberName(
        input.prm.publicId,
        entry.position,
        input.files.length,
        source,
        issuedExt(kind, entry.file, input.strip),
      ),
      file: entry.file,
      handle: entry.handle,
      supply,
    })
  }
  return {
    receiptId,
    modelId: input.modelId,
    modelCode: input.modelCode,
    itemId: input.prm.id,
    publicId: input.prm.publicId,
    principalId: input.principalId,
    kind,
    receiptKind: 'promo',
    metaStripped: input.strip,
    slot: null,
    // Always one archive: the files and the handoff's own list (naming §6).
    zipName: input.zipName,
    files,
    promo: { deliveryId: input.deliveryId, manifestId: input.manifestId, format: input.format },
  }
}

export const MANIFEST_HEADER = [
  'prm',
  'order',
  'file_name',
  'source_id',
  'role',
  'version',
  'master_sha256',
  'format',
  'size_bytes',
] as const

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * `manifest.csv` of the handoff (naming §6): the `PRM` number, the order, the source IDs and
 * roles, the asset versions, the masters' SHA-256, the format, the names and sizes as issued.
 */
export function promoManifestCsv(plan: DownloadPlan, issued: readonly IssuedFile[]): string {
  const format = plan.promo?.format ?? ''
  const lines = [...issued]
    .sort((a, b) => a.position - b.position)
    .map((entry) => {
      const source = sourceOf(entry.handle)
      return [
        plan.publicId,
        entry.position,
        entry.name,
        source.id,
        source.key,
        entry.file.version_no,
        shaHex(entry.file.master),
        format,
        entry.bytes,
      ]
        .map(csvCell)
        .join(',')
    })
  return `${[MANIFEST_HEADER.join(','), ...lines].join('\n')}\n`
}

/** The receipt is sealed: the handoff is «подготовлено» with the real total size. */
export async function markHandoffPrepared(
  tx: Tx,
  plan: DownloadPlan,
  issued: readonly IssuedFile[],
  zipBytes: number,
): Promise<void> {
  if (!plan.promo) return
  const summary = {
    size_bytes: issued.reduce((sum, entry) => sum + entry.bytes, 0),
    zip_bytes: zipBytes,
    zip_name: plan.zipName,
  }
  await tx.execute(sql`
    UPDATE promo_deliveries
       SET state = 'prepared', receipt_id = ${plan.receiptId}::uuid,
           summary = summary || ${JSON.stringify(summary)}::jsonb, updated_at = now(),
           row_version = row_version + 1
     WHERE model_id = ${plan.modelId}::uuid AND id = ${plan.promo.deliveryId}::uuid
       AND state = 'preparing'`)
}
