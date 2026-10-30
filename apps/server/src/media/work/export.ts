import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PROMO_MANIFEST_NAME } from '@contentops/contracts/download-name'
import {
  type Tx,
  type WorkContext,
  WorkDeferred,
  WorkError,
  type WorkHandler,
} from '@contentops/db'
import { stripPhotoMetadata, stripVideoMetadata } from '@contentops/media'
import { sql } from 'drizzle-orm'
import { markHandoffPrepared, promoManifestCsv } from '../../promo/issue'
import {
  type DownloadPlan,
  downloadUrl,
  type FileRow,
  type IssuedFile,
  issuedFromPlan,
  type PlannedFile,
  sealReceipt,
} from '../downloads'
import { locateInput } from '../inputs'
import type { MediaEnv } from '../pipeline'
import { readyGeneration } from '../renditions'
import { exportKey, fsyncDir, sha256OfFile, shaHex } from '../storage'
import { writeZip } from '../zip'
import { asWorkError, modelOf } from './common'
import type { ExportFile } from './copies'

/**
 * `export` (schema §3.4, `export:<receipt>`): the operation of a download that is not ready
 * at once (SPEC §11.2 «202, пока копия собирается»). It waits for the platform and compatible
 * copies the command asked for, builds what has new bytes — stripped masters, the ZIP — in
 * `TMP_ROOT/exports/<receipt>/`, and seals the receipt when bytes and names are known.
 */

export function exportKeyOf(receiptId: string): string {
  return `export:${receiptId}`
}

/** The plan as the work row keeps it (`checkpoint.plan`): hashes as hex. */
export function storedPlan(plan: DownloadPlan): unknown {
  return JSON.parse(
    JSON.stringify(plan, (key, value) =>
      key === 'master' && value && typeof value === 'object' && value.type === 'Buffer'
        ? { hex: Buffer.from(value.data).toString('hex') }
        : value,
    ),
  )
}

function revived(plan: DownloadPlan): DownloadPlan {
  for (const f of plan.files) {
    const master = f.file.master as unknown as { hex?: string } | Buffer
    if (!Buffer.isBuffer(master) && master?.hex) f.file.master = Buffer.from(master.hex, 'hex')
  }
  return plan
}

export function planOf(stored: unknown): DownloadPlan {
  return revived((stored as { plan: DownloadPlan }).plan)
}

/**
 * A plan archive (DESIGN §4.11–4.12: «Скачать всё за день», «Скачать выпуск», «Скачать
 * неделю»): one ZIP over several downloads, each a plan of its own row with its own receipt;
 * members lie by page (and by day for a week). The receipts share the ZIP.
 */
export interface StoredBatch {
  scope: 'day' | 'release' | 'week'
  archive: string
  parts: { folder: string; plan: DownloadPlan }[]
}

export function batchOf(stored: unknown): StoredBatch | null {
  const batch = (stored as { batch?: StoredBatch } | null)?.batch
  if (!batch) return null
  return { ...batch, parts: batch.parts.map((part) => ({ ...part, plan: revived(part.plan) })) }
}

export function storedBatch(batch: StoredBatch): unknown {
  return {
    ...batch,
    parts: batch.parts.map((part) => ({ folder: part.folder, plan: storedPlan(part.plan) })),
  }
}

interface WorkState extends Record<string, unknown> {
  state: string
  report: { file?: ExportFile } | null
  error_text: string | null
}

async function workState(env: MediaEnv, id: string): Promise<WorkState | undefined> {
  const { rows } = await env.db.execute<WorkState>(sql`
    SELECT state, report, error_text FROM work_operations WHERE id = ${id}::uuid`)
  return rows[0]
}

const WAIT_MS = 2_000

async function awaitCopy(env: MediaEnv, planned: PlannedFile): Promise<IssuedFile> {
  const supply = planned.supply
  if (supply.kind === 'render') {
    const ready = await readyGeneration(env.db, {
      kind: 'platform',
      recipeDigest: supply.digest,
      metaStripped: supply.stripped,
      masterSha256: planned.file.master,
      inputSha256: planned.file.master,
    })
    if (ready) {
      const { rows } = await env.db.execute<{
        id: string
        storage_key: string
        output_sha256: Buffer
        byte_size: string
      }>(sql`
        SELECT id, storage_key, output_sha256, byte_size FROM rendition_artifacts
         WHERE generation_id = ${ready.id}::uuid AND name = 'platform.mp4' AND state = 'ready'`)
      const a = rows[0]
      if (a) {
        return issuedFromPlan({
          ...planned,
          supply: {
            kind: 'artifact',
            artifactId: a.id,
            key: a.storage_key,
            sha256: shaHex(a.output_sha256),
            bytes: Number(a.byte_size),
          },
        })
      }
    }
    const work = await workState(env, supply.workId)
    if (work?.state === 'failed' || work?.state === 'cancelled') {
      throw new WorkError(
        'permanent',
        'copy_failed',
        `копия для платформы не собралась: ${work.error_text ?? ''}`,
      )
    }
    throw new WorkDeferred(WAIT_MS, 'ждёт копию для платформы')
  }
  if (supply.kind === 'compat') {
    const work = await workState(env, supply.workId)
    if (work?.state === 'succeeded' && work.report?.file) {
      const file = work.report.file
      return {
        ...issuedFromPlan(planned),
        sha256: file.sha256,
        bytes: file.bytes,
        width: file.width,
        height: file.height,
        durationMs: file.duration_ms,
        exportKey: file.key,
        issuedMaster: false,
        artifactId: null,
      }
    }
    if (work?.state === 'failed' || work?.state === 'cancelled') {
      throw new WorkError(
        'permanent',
        'copy_failed',
        `совместимая копия не собралась: ${work.error_text ?? ''}`,
      )
    }
    throw new WorkDeferred(WAIT_MS, 'ждёт копию, которая откроется везде')
  }
  return issuedFromPlan(planned)
}

/** The master without metadata, under its download name in the exports folder. */
async function strip(
  env: MediaEnv,
  ctx: WorkContext,
  plan: DownloadPlan,
  planned: PlannedFile,
): Promise<IssuedFile> {
  const file: FileRow = planned.file
  const input = await locateInput(env, file.master)
  const dir = join(env.store.path(exportKey(plan.receiptId, 'files')), String(planned.position))
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const built =
    file.media_kind === 'video'
      ? await stripVideoMetadata({
          input: input.path,
          outDir: dir,
          signal: ctx.signal,
          versions: env.versions,
        })
      : await stripPhotoMetadata({ input: input.path, outDir: dir, versions: env.versions })
  const key = exportKey(plan.receiptId, `files/${planned.position}/${planned.name}`)
  await rename(built.file.path, env.store.path(key))
  await fsyncDir(dir)
  return {
    ...issuedFromPlan(planned),
    sha256: built.file.sha256,
    bytes: built.file.bytes,
    width: built.file.width || file.width,
    height: built.file.height || file.height,
    exportKey: key,
    issuedMaster: false,
    artifactId: null,
  }
}

/** Where the bytes of an issued file lie now. */
async function pathOf(env: MediaEnv, issued: IssuedFile): Promise<string> {
  if (issued.exportKey) return env.store.path(issued.exportKey)
  if (issued.artifactId) {
    const { rows } = await env.db.execute<{ storage_key: string }>(sql`
      SELECT storage_key FROM rendition_artifacts WHERE id = ${issued.artifactId}::uuid`)
    return env.store.path(rows[0]?.storage_key as string)
  }
  return (await locateInput(env, issued.file.master)).path
}

async function exportBatch(env: MediaEnv, ctx: WorkContext, batch: StoredBatch) {
  const first = batch.parts[0]?.plan
  if (!first) throw new WorkError('permanent', 'empty_batch', 'nothing to put into the archive')
  try {
    const issuedByPart: IssuedFile[][] = []
    for (const part of batch.parts) {
      const issued: IssuedFile[] = []
      for (const planned of part.plan.files) {
        if (planned.supply.kind !== 'strip') issued.push(await awaitCopy(env, planned))
      }
      issuedByPart.push(issued)
    }
    await ctx.checkpoint({ progress: { num: 1, den: 3, note: 'копии готовы' } })
    for (const [index, part] of batch.parts.entries()) {
      for (const planned of part.plan.files) {
        if (planned.supply.kind === 'strip') {
          issuedByPart[index]?.push(await strip(env, ctx, part.plan, planned))
        }
      }
      issuedByPart[index]?.sort((a, b) => a.position - b.position)
    }
    await ctx.checkpoint({ progress: { num: 2, den: 3, note: 'архив' } })
    const zipKey = exportKey(first.receiptId, batch.archive)
    const members = []
    for (const [index, part] of batch.parts.entries()) {
      for (const entry of issuedByPart[index] ?? []) {
        members.push({ name: `${part.folder}/${entry.name}`, path: await pathOf(env, entry) })
      }
    }
    await mkdir(dirname(env.store.path(zipKey)), { recursive: true })
    const zip = await writeZip(env.store.path(zipKey), members, ctx.signal)
    for (const part of batch.parts) {
      await rm(env.store.path(exportKey(part.plan.receiptId, 'files')), {
        recursive: true,
        force: true,
      })
    }
    const url = downloadUrl(first.modelCode, first.receiptId)
    return {
      outputRef: url,
      report: {
        receipt_id: first.receiptId,
        download_url: url,
        file_name: batch.archive,
        size_bytes: zip.bytes,
        files: members.length,
      },
      commit: async (tx: Tx) => {
        for (const [index, part] of batch.parts.entries()) {
          await sealReceipt(tx, part.plan, issuedByPart[index] ?? [], zipKey)
        }
      },
    }
  } catch (error) {
    throw asWorkError(error)
  }
}

export function exportHandler(env: MediaEnv): WorkHandler {
  return async (ctx) => {
    modelOf(ctx)
    const batch = batchOf(ctx.work.checkpoint)
    if (batch) return exportBatch(env, ctx, batch)
    const plan = planOf(ctx.work.checkpoint)
    try {
      // Copies first: while one is missing the issue waits, without building anything.
      const issued: IssuedFile[] = []
      for (const planned of plan.files) {
        if (planned.supply.kind !== 'strip') issued.push(await awaitCopy(env, planned))
      }
      await ctx.checkpoint({ progress: { num: 1, den: 3, note: 'копии готовы' } })
      for (const planned of plan.files) {
        if (planned.supply.kind === 'strip') issued.push(await strip(env, ctx, plan, planned))
      }
      issued.sort((a, b) => a.position - b.position)
      let zipKey: string | null = null
      let served = issued[0]
      let bytes = served?.bytes ?? 0
      if (plan.zipName) {
        await ctx.checkpoint({ progress: { num: 2, den: 3, note: 'архив' } })
        zipKey = exportKey(plan.receiptId, plan.zipName)
        const members = []
        for (const entry of issued)
          members.push({ name: entry.name, path: await pathOf(env, entry) })
        if (plan.promo) {
          // The handoff's own list goes last in its ZIP (naming §6).
          const dir = env.store.path(exportKey(plan.receiptId, 'files'))
          await mkdir(dir, { recursive: true })
          const csv = join(dir, PROMO_MANIFEST_NAME)
          await writeFile(csv, promoManifestCsv(plan, issued))
          members.push({ name: PROMO_MANIFEST_NAME, path: csv })
        }
        const zip = await writeZip(env.store.path(zipKey), members, ctx.signal)
        // Stripped members live inside the ZIP; the receipt keeps their hash and size.
        await rm(env.store.path(exportKey(plan.receiptId, 'files')), {
          recursive: true,
          force: true,
        })
        bytes = zip.bytes
        served = undefined
      } else if (served?.exportKey) {
        // A single new file: check it once more before it is issued.
        const actual = await sha256OfFile(env.store.path(served.exportKey))
        if (actual !== served.sha256)
          throw new WorkError('transient', 'export_changed', 'export bytes changed')
        bytes = (await stat(env.store.path(served.exportKey))).size
      }
      const url = downloadUrl(plan.modelCode, plan.receiptId)
      return {
        outputRef: url,
        report: {
          receipt_id: plan.receiptId,
          download_url: url,
          file_name: plan.zipName ?? served?.name ?? null,
          size_bytes: bytes,
          files: issued.length,
        },
        commit: async (tx) => {
          await sealReceipt(tx, plan, issued, zipKey)
          if (plan.promo) await markHandoffPrepared(tx, plan, issued, bytes)
        },
      }
    } catch (error) {
      if (!(error instanceof WorkDeferred)) {
        if (!(error instanceof WorkError && error.kind === 'transient')) {
          await rm(env.store.path(exportKey(plan.receiptId, 'files')), {
            recursive: true,
            force: true,
          })
        }
      }
      throw asWorkError(error)
    }
  }
}
