import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  type Db,
  enqueueWork,
  type Queryable,
  type Tx,
  WorkError,
  type WorkHandler,
} from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { ModelScope } from '../context'
import { ApiProblem } from '../errors'
import { FileAnswer } from '../file-answer'
import type { BlobStore } from '../media/storage'
import { mimeOfExt, shaHex } from '../media/storage'
import { writeZip } from '../media/zip'

/**
 * «Скачать исходник» from a draft (SPEC §6.1: the source and its preview can be downloaded
 * from a draft before the master). No receipt — a draft has no ID and the download proves
 * nothing (schema §9.2); who downloaded what and when goes to the journal. The bytes are the
 * staged source, the registered source blob (a photo, a web upload) or, for a source that is
 * no longer staged, its master — always through `X-Accel-Redirect`. Several files are one
 * stored ZIP built by an `export` work in `TMP_ROOT/exports/<work>/` (a day, like every issue).
 */

interface DraftBytes extends Record<string, unknown> {
  id: string
  path: string | null
  client_filename: string | null
  source_hex: string | null
  source_blob_key: string | null
  master_key: string | null
  master_is_source: boolean
}

export interface DraftFile {
  draftId: string
  name: string
  key: string
}

function nameOf(row: DraftBytes): string {
  const raw = row.client_filename ?? row.path ?? row.id
  return raw.slice(raw.lastIndexOf('/') + 1) || row.id
}

/** Where the bytes of each file of the group are now; `null` key — not here yet. */
async function groupBytes(q: Queryable, store: BlobStore, modelId: string, groupId: string) {
  const { rows } = await q.execute<DraftBytes>(sql`
    SELECT d.id, d.path, u.client_filename, encode(d.source_sha256, 'hex') AS source_hex,
           sb.storage_key AS source_blob_key, mb.storage_key AS master_key, d.master_is_source
      FROM inbox_drafts d
      LEFT JOIN web_uploads u ON u.model_id = d.model_id AND u.id = d.web_upload_id
      LEFT JOIN blobs sb ON sb.sha256 = coalesce(d.source_blob_sha256, u.sha256)
                        AND sb.state = 'present'
      LEFT JOIN blobs mb ON mb.sha256 = d.master_sha256 AND mb.state = 'present'
     WHERE d.model_id = ${modelId}::uuid AND d.group_id = ${groupId}::uuid
     ORDER BY d.state = 'resolved', d.proposed_ordinal NULLS LAST, d.path, d.id`)
  const files: (DraftFile & { ready: boolean })[] = []
  for (const row of rows) {
    const staged = row.source_hex ? await store.staged(row.source_hex) : null
    const key = staged?.key ?? row.source_blob_key ?? row.master_key ?? null
    files.push({ draftId: row.id, name: nameOf(row), key: key ?? '', ready: key !== null })
  }
  return files
}

/** Names inside one ZIP never repeat: `a.jpg`, `a (2).jpg`. */
function uniqueNames(files: readonly DraftFile[]): DraftFile[] {
  const seen = new Map<string, number>()
  return files.map((file) => {
    const count = (seen.get(file.name) ?? 0) + 1
    seen.set(file.name, count)
    if (count === 1) return file
    const dot = file.name.lastIndexOf('.')
    const name =
      dot > 0
        ? `${file.name.slice(0, dot)} (${count})${file.name.slice(dot)}`
        : `${file.name} (${count})`
    return { ...file, name }
  })
}

export function sourceUrl(model: string, groupId: string, query: string): string {
  return `/api/v1/${model}/inbox/groups/${groupId}/source?${query}`
}

export interface DownloadPlanResult {
  files: DraftFile[]
  answer:
    | { kind: 'ready'; download_url: string; file_name: string; size_bytes: number }
    | { kind: 'zip'; workId: string; file_name: string }
}

/** Plans «Скачать исходник» of a group inside the command transaction. */
export async function planDraftDownload(
  tx: Tx,
  store: BlobStore,
  model: ModelScope,
  groupId: string,
  title: string,
): Promise<DownloadPlanResult> {
  const all = await groupBytes(tx, store, model.id, groupId)
  if (all.length === 0) throw new ApiProblem('not_found', 'Такой группы нет')
  const waiting = all.filter((file) => !file.ready)
  if (waiting.length > 0) {
    throw new ApiProblem('accept_blocked', 'Файлы группы ещё качаются из источника', {
      reason: 'not_fetched',
      files: waiting.length,
    })
  }
  const files = uniqueNames(all)
  if (files.length === 1) {
    const [file] = files as [DraftFile]
    const info = await store.stat(file.key)
    return {
      files,
      answer: {
        kind: 'ready',
        download_url: sourceUrl(model.code, groupId, `file=${file.draftId}`),
        file_name: file.name,
        size_bytes: info?.bytes ?? 0,
      },
    }
  }
  const fileName = `${title.replaceAll('/', '-').trim() || 'исходники'}.zip`
  const { work } = await enqueueWork(tx, {
    modelId: model.id,
    kind: 'export',
    workKey: `drafts-zip:${groupId}:${Date.now()}`,
    dataset: 'drafts',
    scope: groupId,
    checkpoint: { group: groupId, model: model.code, file_name: fileName, files },
    priority: 1_000_000,
  })
  return { files, answer: { kind: 'zip', workId: work.id, file_name: fileName } }
}

interface ZipPlan {
  group: string
  model: string
  file_name: string
  files: DraftFile[]
}

/**
 * The `export` work of a draft ZIP (`dataset = 'drafts'`); every other export is the media
 * pipeline's. The ZIP is stored (no compression) in `exports/<work id>/`.
 */
export function draftZipExport(store: BlobStore, other: WorkHandler | undefined): WorkHandler {
  return async (ctx) => {
    if (ctx.work.dataset !== 'drafts') {
      if (!other) throw new WorkError('permanent', 'no_handler', 'export без обработчика')
      return other(ctx)
    }
    const plan = ctx.work.checkpoint as ZipPlan | null
    if (!plan?.files?.length) throw new WorkError('permanent', 'no_plan', 'нечего собирать')
    const key = `exports/${ctx.work.id}/${plan.file_name}`
    const target = store.path(key)
    await mkdir(dirname(target), { recursive: true })
    const members = []
    for (const file of plan.files) {
      const path = store.path(file.key)
      if (!(await stat(path).catch(() => null))) {
        throw new WorkError('transient', 'input_missing', `нет байтов ${file.name}`)
      }
      members.push({ name: file.name, path })
    }
    const { bytes } = await writeZip(target, members, ctx.signal)
    return {
      outputRef: key,
      report: {
        download_url: sourceUrl(plan.model, plan.group, `zip=${ctx.work.id}`),
        file_name: plan.file_name,
        size_bytes: bytes,
        key,
      },
    }
  }
}

/** `GET …/inbox/groups/{group}/source?file=<draft>|zip=<work>`: the bytes, by X-Accel. */
export async function draftSource(
  db: Db,
  store: BlobStore,
  model: ModelScope,
  groupId: string,
  query: { file?: string | undefined; zip?: string | undefined },
): Promise<FileAnswer> {
  if (query.zip) {
    const { rows } = await db.execute<{ report: { key?: string; file_name?: string } | null }>(sql`
      SELECT report FROM work_operations
       WHERE id = ${query.zip}::uuid AND model_id = ${model.id}::uuid AND kind = 'export'
         AND dataset = 'drafts' AND scope = ${groupId} AND state = 'succeeded'`)
    const report = rows[0]?.report
    const info = report?.key ? await store.stat(report.key) : null
    if (!report?.key || !info) throw new ApiProblem('not_found', 'Архив удалён через сутки — скачайте заново')
    return new FileAnswer({
      accel: store.url(report.key),
      path: store.path(report.key),
      mime: 'application/zip',
      bytes: info.bytes,
      downloadName: report.file_name ?? 'исходники.zip',
    })
  }
  const files = await groupBytes(db, store, model.id, groupId)
  const file = files.find((candidate) => candidate.draftId === query.file)
  if (!file?.ready) throw new ApiProblem('not_found', 'Такого файла нет')
  const info = await store.stat(file.key)
  if (!info) throw new ApiProblem('not_found', 'Байтов файла нет на месте')
  const ext = file.name.includes('.') ? (file.name.split('.').pop() ?? 'bin') : 'bin'
  const sha = file.key.split('/').pop()?.split('.')[0] ?? ''
  return new FileAnswer({
    accel: store.url(file.key),
    path: store.path(file.key),
    mime: mimeOfExt(ext.toLowerCase()),
    bytes: info.bytes,
    ...(/^[0-9a-f]{64}$/.test(sha) ? { etag: shaHex(sha) } : {}),
    downloadName: file.name,
  })
}
