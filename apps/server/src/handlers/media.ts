import { randomUUID } from 'node:crypto'
import type { DownloadKind } from '@contentops/contracts/commands/objects'
import {
  OPERATION_LABEL,
  type Operation,
  type OperationAccepted,
  type OperationKind,
} from '@contentops/contracts/domain/operations'
import type { NameSlot } from '@contentops/contracts/download-name'
import { enqueueWork, logAction, type Queryable, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { findItem, modelOf, publicIdOf, publicIdOfRow } from '../catalog/ids'
import { instant, instantOrNull, isUuid } from '../commands'
import type { Actor, ModelScope, RequestContext } from '../context'
import { ApiProblem } from '../errors'
import { FileAnswer } from '../file-answer'
import type { HandlerRegistry } from '../handlers'
import {
  type DownloadItem,
  type DownloadPlan,
  downloadUrl,
  type FileRow,
  handleOf,
  issuedFromPlan,
  loadFiles,
  mainVideo,
  planDownload,
  readyNow,
  sealReceipt,
  servedFile,
} from '../media/downloads'
import { currentDigests } from '../media/pipeline'
import { mimeOfExt, shaBytes, shaHex } from '../media/storage'
import { uniqKey } from '../media/work/copies'
import { exportKeyOf, storedPlan } from '../media/work/export'
import { frameKey } from '../media/work/frame'
import { enqueueVerifyBlobs } from '../media/work/verify-blobs'
import { manifestFiles } from '../plan/composition'
import { type RowRecord, rowById } from '../plan/records'
import type { Services } from '../services'

/**
 * Bytes and long operations of the media pipeline (SPEC §9.3, §11.2): previews by
 * generation, the two-step download with its receipt, operations of a model and the
 * system's `verify-blobs`, frames of a master, cover, unique FYP versions.
 */

const notFound = (what = 'Файла нет') => new ApiProblem('not_found', what)

interface ArtifactRow extends Record<string, unknown> {
  storage_key: string
  mime: string
  output_sha256: Buffer
  byte_size: string
}

/**
 * A rendition file of the model: the generation belongs to a version or a draft of this
 * model (schema §3.3 «проверяет права по версии или черновику»); else 404 inside the model.
 */
async function generationFile(
  q: Queryable,
  model: ModelScope,
  generation: string,
  name: string,
): Promise<ArtifactRow | undefined> {
  if (!isUuid(generation)) return undefined
  const { rows } = await q.execute<ArtifactRow>(sql`
    SELECT a.storage_key, a.mime, a.output_sha256, a.byte_size
      FROM rendition_generations g
      JOIN rendition_artifacts a ON a.generation_id = g.id AND a.name = ${name} AND a.state = 'ready'
     WHERE g.id = ${generation}::uuid AND g.state = 'ready'
       AND (EXISTS (SELECT 1 FROM asset_versions v
                     WHERE v.model_id = ${model.id}::uuid
                       AND (v.master_sha256 IN (g.master_sha256, g.input_sha256)
                            OR v.source_sha256 = g.input_sha256))
            OR EXISTS (SELECT 1 FROM inbox_drafts d
                        WHERE d.model_id = ${model.id}::uuid
                          AND (d.source_sha256 = g.input_sha256
                               OR d.master_sha256 IN (g.master_sha256, g.input_sha256))))`)
  return rows[0]
}

/** The page in the name (naming §6): «Залить сейчас» names today in Europe/Moscow. */
async function slotOf(q: Queryable, model: ModelScope, account: string): Promise<NameSlot> {
  const { rows } = await q.execute<{ today: string }>(sql`
    SELECT (now() AT TIME ZONE 'Europe/Moscow')::date::text AS today FROM accounts
     WHERE model_id = ${model.id}::uuid AND code = ${account} AND archived_at IS NULL`)
  const row = rows[0]
  if (!row) {
    throw new ApiProblem('invalid_request', 'Такой страницы у модели нет', { field: 'account' })
  }
  return { account, date: row.today, time: null }
}

function itemOf(row: Awaited<ReturnType<typeof findItem>>): DownloadItem {
  return {
    id: row.id,
    type: row.type,
    public_id: publicIdOfRow(row),
    title: row.title,
    title_en: row.title_en,
  }
}

function statusUrl(model: ModelScope, id: string): string {
  return `/api/v1/${model.code}/operations/${id}`
}

function accepted(model: ModelScope | null, id: string): OperationAccepted {
  return {
    kind: 'operation',
    operation_id: id,
    status_url: model ? statusUrl(model, id) : `/api/v1/admin/operations/${id}`,
  }
}

/**
 * Issues a download: sealed now when the bytes exist, else an `export` work as the operation
 * (SPEC §11.2: `download_url` or 202 with `operation_id`).
 */
async function issue(
  tx: Tx,
  actor: Actor,
  model: ModelScope,
  item: DownloadItem,
  files: FileRow[],
  kind: DownloadKind,
  strip: boolean,
  slot: NameSlot | null,
  picks?: FileRow[],
  planRowId: string | null = null,
) {
  for (const f of picks ?? files) {
    if (f.blob_state !== 'present') {
      throw new ApiProblem(
        'unavailable',
        `${item.public_id}/${handleOf(f)}: байты файла недоступны`,
      )
    }
  }
  const digests = (await currentDigests(tx)) ?? { version: '', platform: '', platformStripped: '' }
  const plan = await planDownload(tx, {
    modelId: model.id,
    modelCode: model.code,
    item,
    files,
    kind,
    stripMetadata: strip,
    slot,
    principalId: actor.id,
    digests,
    planRowId,
    ...(picks ? { picks } : {}),
  })
  if (plan.files.length === 0) {
    throw new ApiProblem('invalid_request', 'Нечего скачать: у объекта нет таких файлов', { kind })
  }
  const needsCopies = plan.files.some((f) => f.supply.kind === 'render')
  if (needsCopies && digests.version === '') {
    throw new ApiProblem('unavailable', 'Медиаконвейер ещё не запускался: копии собирать некому')
  }
  await logAction(tx, {
    modelId: model.id,
    subjectKind: 'content_items',
    subjectId: item.id,
    itemId: item.id,
    subjectLabel: item.public_id,
    after: {
      kind,
      strip_metadata: strip,
      files: plan.files.map((f) => f.name),
      ...(plan.zipName ? { zip: plan.zipName } : {}),
      ...(planRowId ? { plan_row: planRowId } : {}),
    },
  })
  if (readyNow(plan)) {
    const issued = plan.files.map(issuedFromPlan)
    await sealReceipt(tx, plan, issued, null)
    const [file] = issued
    return {
      kind: 'ready' as const,
      download_url: downloadUrl(model.code, plan.receiptId),
      file_name: file?.name ?? '',
      size_bytes: file?.bytes ?? 0,
    }
  }
  const { work } = await enqueueWork(tx, {
    modelId: model.id,
    kind: 'export',
    workKey: exportKeyOf(plan.receiptId),
    checkpoint: { plan: storedPlan(plan) },
    priority: 1_000_000,
  })
  return accepted(model, work.id)
}

interface WorkRowView extends Record<string, unknown> {
  id: string
  kind: string
  work_key: string
  state: string
  scope: string | null
  progress_num: string | null
  progress_den: string | null
  progress_note: string | null
  report: Record<string, unknown> | null
  checkpoint: {
    plan?: DownloadPlan
    batch?: { scope: 'day' | 'release' | 'week'; archive: string }
  } | null
  error_text: string | null
  created_at: string
  finished_at: string | null
}

function operationKind(row: WorkRowView): OperationKind {
  switch (row.kind) {
    case 'export': {
      if (row.checkpoint?.plan?.promo) return 'handoff'
      const batch = row.checkpoint?.batch
      if (batch) return `zip_${batch.scope}`
      const kind = row.checkpoint?.plan?.kind
      if (kind === 'compat') return 'compat_copy'
      if (kind === 'platform' || kind === 'teaser' || kind === 'fan') return 'platform_copy'
      return 'source_zip'
    }
    case 'render':
      return 'platform_copy'
    case 'render_compat':
      return 'compat_copy'
    case 'uniq_render':
      return 'fyp_versions'
    case 'extract_frame':
      return row.work_key.endsWith(':cover') ? 'make_cover' : 'make_photo'
    case 'derive_image':
      return 'make_cover'
    case 'verify_blobs':
      return 'verify_blobs'
    default:
      return 'platform_copy'
  }
}

const OPEN = new Set(['pending', 'running', 'retry_wait'])

/** An operation is a work row, or the works of one command sharing `scope = op:<request>`. */
async function operationView(
  q: Queryable,
  model: ModelScope | null,
  id: string,
  requestId: string,
): Promise<Operation> {
  if (!isUuid(id)) throw notFound('Такой операции нет')
  const { rows } = await q.execute<WorkRowView>(sql`
    SELECT id, kind, work_key, state, scope, progress_num, progress_den, progress_note, report,
           checkpoint, error_text, created_at::text AS created_at, finished_at::text AS finished_at
      FROM work_operations
     WHERE id = ${id}::uuid AND model_id IS NOT DISTINCT FROM ${model?.id ?? null}::uuid`)
  const row = rows[0]
  if (!row) throw notFound('Такой операции нет')
  let group = [row]
  if (row.scope?.startsWith('op:') && model) {
    const all = await q.execute<WorkRowView>(sql`
      SELECT id, kind, work_key, state, scope, progress_num, progress_den, progress_note, report,
             checkpoint, error_text, created_at::text AS created_at, finished_at::text AS finished_at
        FROM work_operations WHERE model_id = ${model.id}::uuid AND scope = ${row.scope}`)
    group = all.rows
  }
  const failed = group.find((w) => w.state === 'failed' || w.state === 'cancelled')
  const open = group.filter((w) => OPEN.has(w.state))
  const state: Operation['state'] = failed ? 'failed' : open.length > 0 ? 'running' : 'done'
  const done = group.length - open.length
  const own =
    row.progress_num !== null && row.progress_den
      ? Number(row.progress_num) / Number(row.progress_den)
      : null
  const progress = group.length > 1 ? done / group.length : state === 'done' ? 1 : (own ?? 0)
  const kind = operationKind(row)
  const subject = row.checkpoint?.plan?.publicId ?? row.checkpoint?.batch?.archive
  const report = row.report ?? {}
  const finished = group
    .map((w) => w.finished_at)
    .filter((t): t is string => t !== null)
    .sort()
  return {
    id: row.id,
    kind,
    label: subject ? `${OPERATION_LABEL[kind]} · ${subject}` : OPERATION_LABEL[kind],
    state,
    progress: Math.min(1, Math.max(0, progress)),
    created_at: instant(row.created_at),
    finished_at: state === 'running' ? null : instantOrNull(finished.at(-1) ?? null),
    result:
      state === 'done' && row.kind === 'export'
        ? {
            download_url: (report.download_url as string | undefined) ?? null,
            file_name: (report.file_name as string | undefined) ?? null,
            size_bytes: (report.size_bytes as number | undefined) ?? null,
          }
        : null,
    error: failed
      ? {
          code: 'unavailable',
          message: `Не получилось: ${failed.error_text ?? 'ошибка фоновой работы'}`,
          request_id: requestId,
        }
      : null,
    ...(row.kind === 'verify_blobs' ? { report: row.report } : {}),
  }
}

/** The files of an object by their handles (`master`, `pic03`, `u2`), as the card names them. */
function byHandles(files: FileRow[], keys: readonly string[], id: string): FileRow[] {
  return keys.map((key) => {
    const file = files.find((f) => handleOf(f) === key || f.membership_id === key)
    if (!file) throw new ApiProblem('not_found', `${id}/${key}: такого файла нет`, { key })
    return file
  })
}

/**
 * A download from a plan row (SPEC §10, naming §6): the files of the row's sealed composition
 * at the versions it holds, named with the page, the planned date and the slot time; the
 * receipt keeps the row (schema §3.5).
 */
export async function issuePlanRow(
  tx: Tx,
  actor: Actor,
  model: ModelScope,
  row: RowRecord,
  kind: DownloadKind,
  strip: boolean,
) {
  if (!row.item_id || !row.item_type || row.item_number === null) {
    throw new ApiProblem('invalid_request', 'Строка ждёт монтаж: скачивать нечего', { row: row.id })
  }
  if (!row.manifest_id) {
    throw new ApiProblem('invalid_request', 'Файл строки ещё собирается — скачать можно позже', {
      row: row.id,
    })
  }
  const item = itemOf(await findItem(tx, model, publicIdOf(row.item_type, row.item_number)))
  const files = await manifestFiles(tx, model.id, row.manifest_id)
  const slot: NameSlot = { account: row.account, date: row.slot_date, time: row.slot_time }
  return issue(tx, actor, model, item, files, kind, strip, slot, undefined, row.id)
}

export function mediaRouteHandlers({ db, command, store }: Services): HandlerRegistry {
  const fileOf = async (ctx: RequestContext, generation: string, name: string) => {
    const model = modelOf(ctx.model)
    const row = await generationFile(db, model, generation, name)
    if (!row) throw notFound()
    const key = row.storage_key
    return new FileAnswer({
      accel: store.url(key),
      path: store.path(key),
      mime: row.mime,
      bytes: Number(row.byte_size),
      etag: shaHex(row.output_sha256),
      immutable: true,
    })
  }

  return {
    media: {
      file: ({ params, ctx }) => fileOf(ctx, params.generation, params.name),
      frame: ({ params, ctx }) => fileOf(ctx, params.generation, `frames/${params.frame}`),

      download: async ({ params, ctx }) => {
        const model = modelOf(ctx.model)
        if (!isUuid(params.receipt)) throw notFound('Такой выдачи нет')
        const served = await servedFile(db, model.id, params.receipt)
        if (!served) throw notFound('Такой выдачи нет')
        const present = await store.stat(served.key)
        if (!present) {
          throw notFound(
            served.key.startsWith('exports/')
              ? 'Выдача удалена через сутки — скачайте заново'
              : served.key.startsWith('derived/')
                ? 'Копия пересобрана — скачайте заново'
                : 'Байты этой выдачи недоступны',
          )
        }
        return new FileAnswer({
          accel: store.url(served.key),
          path: store.path(served.key),
          mime: served.mime || mimeOfExt('bin'),
          bytes: present.bytes,
          ...(served.sha256 ? { etag: served.sha256 } : {}),
          downloadName: served.name,
        })
      },
    },

    objects: {
      download: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          if (body.plan_row) {
            const row = await rowById(tx, model, body.plan_row)
            const own =
              row.item_type && row.item_number !== null
                ? publicIdOf(row.item_type, row.item_number)
                : null
            if (own !== params.id) {
              throw new ApiProblem('invalid_request', 'Эта строка плана — про другой объект', {
                field: 'plan_row',
              })
            }
            return issuePlanRow(tx, actor, model, row, body.kind, body.strip_metadata)
          }
          const item = itemOf(await findItem(tx, model, params.id))
          const files = await loadFiles(tx, model.id, item.id)
          const slot = body.account ? await slotOf(tx, model, body.account) : null
          return issue(tx, actor, model, item, files, body.kind, body.strip_metadata, slot)
        }),
    },

    objectFiles: {
      download: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const item = itemOf(await findItem(tx, model, params.id))
          const files = await loadFiles(tx, model.id, item.id)
          const picks = byHandles(files, body.keys, item.public_id)
          return issue(tx, actor, model, item, files, 'master', body.strip_metadata, null, picks)
        }),

      makePhotos: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx) => {
          const model = modelOf(ctx.model)
          const item = itemOf(await findItem(tx, model, params.id))
          const video = mainVideo(await loadFiles(tx, model.id, item.id))
          if (!video)
            throw new ApiProblem('invalid_request', 'У объекта нет видео', { id: item.public_id })
          const scope = `op:${randomUUID()}`
          const ids: string[] = []
          for (const t of body.frames) {
            const { work } = await enqueueWork(tx, {
              modelId: model.id,
              kind: 'extract_frame',
              workKey: frameKey(video.version_id, Math.round(t * 1000), 'photo'),
              assetVersionId: video.version_id,
              scope,
              priority: 1_000_000,
            })
            ids.push(work.id)
          }
          await logAction(tx, {
            modelId: model.id,
            subjectKind: 'content_items',
            subjectId: item.id,
            itemId: item.id,
            subjectLabel: item.public_id,
            after: { frames_s: body.frames },
          })
          return accepted(model, ids[0] as string)
        }),

      makeCover: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx) => {
          const model = modelOf(ctx.model)
          const item = itemOf(await findItem(tx, model, params.id, { lock: true }))
          const files = await loadFiles(tx, model.id, item.id)
          await logAction(tx, {
            modelId: model.id,
            subjectKind: 'content_items',
            subjectId: item.id,
            itemId: item.id,
            subjectLabel: item.public_id,
            after: body.from === 'frame' ? { frame_s: body.t_s } : { file: body.key },
          })
          if (body.from === 'frame') {
            const video = mainVideo(files)
            if (!video)
              throw new ApiProblem('invalid_request', 'У объекта нет видео', { id: item.public_id })
            const { work } = await enqueueWork(tx, {
              modelId: model.id,
              kind: 'extract_frame',
              workKey: frameKey(video.version_id, Math.round(body.t_s * 1000), 'cover'),
              assetVersionId: video.version_id,
              priority: 1_000_000,
            })
            return accepted(model, work.id)
          }
          const [photo] = byHandles(files, [body.key], item.public_id)
          if (photo?.media_kind !== 'image') {
            throw new ApiProblem('invalid_request', 'Обложкой становится фото объекта', {
              key: body.key,
            })
          }
          await tx.execute(sql`
            UPDATE content_items SET cover_membership_id = ${photo.membership_id}::uuid,
                   updated_at = now(), row_version = row_version + 1
             WHERE model_id = ${model.id}::uuid AND id = ${item.id}::uuid`)
          // Its thumbnails are the cover's: the operation is their build (cached → done).
          const { work } = await enqueueWork(tx, {
            modelId: model.id,
            kind: 'derive_image',
            workKey: `derive:${shaHex(photo.master)}`,
            inputSha256: shaBytes(photo.master),
            assetVersionId: photo.version_id,
            priority: 1_000_000,
          })
          return accepted(model, work.id)
        }),

      buildFypVersions: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx) => {
          const model = modelOf(ctx.model)
          const item = itemOf(await findItem(tx, model, params.id, { lock: true }))
          if (item.type !== 'FYP') {
            throw new ApiProblem('invalid_request', 'Версии собираются только у фупа', {
              id: item.public_id,
            })
          }
          const files = await loadFiles(tx, model.id, item.id)
          const base = files.find((f) => f.role === 'master' && f.variant_no === 0)
          if (!base)
            throw new ApiProblem('invalid_request', 'У фупа нет монтажа', { id: item.public_id })
          const { rows } = await tx.execute<{ top: number }>(sql`
            SELECT coalesce(max(variant_no), 0)::int AS top FROM assets
             WHERE model_id = ${model.id}::uuid AND created_in_item_id = ${item.id}::uuid`)
          const top = rows[0]?.top ?? 0
          if (top + body.count > 10) {
            throw new ApiProblem(
              'invalid_request',
              'Больше десяти версий у одного фупа не собрать',
              {
                count: body.count,
              },
            )
          }
          const scope = `op:${randomUUID()}`
          const ids: string[] = []
          for (let n = top + 1; n <= top + body.count; n++) {
            const { work } = await enqueueWork(tx, {
              modelId: model.id,
              kind: 'uniq_render',
              workKey: uniqKey(base.version_id, body.level, n),
              assetVersionId: base.version_id,
              scope,
              priority: 500_000,
            })
            ids.push(work.id)
          }
          await logAction(tx, {
            modelId: model.id,
            subjectKind: 'content_items',
            subjectId: item.id,
            itemId: item.id,
            subjectLabel: item.public_id,
            after: { count: body.count, level: body.level, from: top + 1 },
          })
          return accepted(model, ids[0] as string)
        }),
    },

    operations: {
      get: ({ params, ctx }) =>
        operationView(db, modelOf(ctx.model), params.operation, ctx.requestId),
    },

    admin: {
      operation: ({ params, ctx }) => operationView(db, null, params.operation, ctx.requestId),
      verifyBlobs: ({ ctx, body }) =>
        command({ ctx, body }, async (tx) => {
          const { work } = await enqueueVerifyBlobs(tx)
          await logAction(tx, {
            modelId: null,
            subjectKind: 'work_operations',
            subjectId: work.id,
            subjectLabel: 'verify-blobs',
          })
          return accepted(null, work.id)
        }),
    },
  }
}
