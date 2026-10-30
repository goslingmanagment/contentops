import { rm, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { CreateUploadCommand, UploadKind } from '@contentops/contracts/commands/uploads'
import type { UploadResult } from '@contentops/contracts/domain/inbox'
import { type Db, enqueueWork, logAction, type Tx, type values, withActorTx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { findItem, type ItemRow } from '../catalog/ids'
import { journalActor, requireActor } from '../commands'
import type { Actor, ModelScope, RequestContext } from '../context'
import { ApiProblem } from '../errors'
import { type BlobStore, extOfName, mimeOfExt, sha256OfFile, shaBytes } from '../media/storage'
import { registerBlob, StorageBusyError } from '../media/storage-ops'
import type { Services } from '../services'
import { type AcceptOptions, acceptGroup } from './accept'
import { afterFetch } from './fetch'
import { mediaKindOf } from './grouping'
import { ITEM_TO_DB_TYPE } from './inbox-view'
import { DECLARED_KIND, uploadDir } from './tus'

/**
 * The last step of a web upload (SPEC §6.1, §9.2, schema §3.4 `web_uploads`, DESIGN §3.7):
 * `POST /<model>/uploads` with an `Idempotency-Key`. Every named tus upload must be complete;
 * its bytes are hashed and registered as a blob by the storage protocol (a link inside
 * `DATA_ROOT`, the upload is `verified`), then one transaction makes them a group of the
 * usual intake with one draft per upload (`registered`). With a target the uploaded bytes
 * are the master (SPEC §9.2: no re-encoding) and the group is accepted into the target in
 * the same transaction — «принято при загрузке», the uploader is the author. «Другое» is a
 * group «Загружено вами» in «Приехало», compressed like a file from a source. A repeat with
 * the same key answers the same: the uploads are already blobs and the command replays.
 */

const UPLOADED = 'Загружено вами'
const OWNER = `web:${hostname()}:${process.pid}`
const EXT = /^[a-z0-9]{1,10}$/

interface UploadRow extends Record<string, unknown> {
  id: string
  upload_id: string
  principal_id: string
  state: values.UploadState
  size_expected: string
  client_filename: string
  tmp_key: string
  sha: string | null
}

interface Planned {
  row: UploadRow
  media: values.MediaKind
  sha: string
}

function blocked(reason: string, message: string, details: Record<string, unknown> = {}) {
  return new ApiProblem('accept_blocked', message, { reason, ...details })
}

function mediaOf(file: CreateUploadCommand['files'][number]): values.MediaKind {
  return mediaKindOf(file.file_name, null) ?? (file.media === 'video' ? 'video' : 'image')
}

/** What a target takes (DESIGN §3.7; the same rules as the mock of the screens). */
function checkTarget(kind: UploadKind, target: ItemRow, media: readonly values.MediaKind[]) {
  const oneVideo = media.length === 1 && media[0] === 'video'
  switch (kind) {
    case 'teaser':
      if (target.type !== 'PPV' && target.type !== 'CUS') {
        throw blocked('wrong_target', 'Тизер бывает у PPV и кастома')
      }
      if (!oneVideo) throw blocked('wrong_files', 'Тизер — один видеофайл')
      return
    case 'master_version':
      if (!['PPV', 'CUS', 'FYP'].includes(target.type)) {
        throw blocked('wrong_target', 'Мастер есть у PPV, кастома и фупа')
      }
      if (!oneVideo) throw blocked('wrong_files', 'Новая версия мастера — один видеофайл')
      return
    case 'fyp_montage':
      if (target.type !== 'FYP') throw blocked('wrong_target', 'Монтаж фупа — только у фупа')
      if (!oneVideo) throw blocked('wrong_files', 'Монтаж фупа — один видеофайл')
      return
    case 'frames':
      if (media.some((kind) => kind === 'video')) {
        throw blocked('wrong_files', 'Обработанные кадры — только фото')
      }
      if (target.type === 'FYP' || target.type === 'PRM') {
        throw blocked('wrong_target', 'Кадры не добавляются к фупу и промо')
      }
      return
    case 'other':
      throw new ApiProblem('invalid_request', '«Другое» загружается без цели')
  }
}

/** How the files join the target: a teaser, a new master version, more photos. */
function acceptOptionsOf(kind: UploadKind, target: ItemRow, itemId: string): AcceptOptions {
  switch (kind) {
    case 'teaser':
      return { as: 'default', extend: { item_id: itemId, role: 'teaser' }, how: 'upload' }
    case 'master_version':
    case 'fyp_montage':
      return { as: 'default', extend: { item_id: itemId, role: 'master_version' }, how: 'upload' }
    default:
      // Processed frames of a set are its `ed` files (naming §3); elsewhere they are photos.
      return {
        as: 'default',
        extend: { item_id: itemId, role: 'photos' },
        how: 'upload',
        ...(target.type === 'SET' ? { role: 'ed' as const } : {}),
      }
  }
}

async function loadUploads(q: Db | Tx, model: ModelScope, ids: readonly string[], lock = false) {
  const { rows } = await q.execute<UploadRow>(sql`
    SELECT id, upload_id, principal_id, state, size_expected, client_filename, tmp_key,
           encode(sha256, 'hex') AS sha
      FROM web_uploads
     WHERE model_id = ${model.id}::uuid AND upload_id = ANY (${sql.param([...ids])}::text[])
     ORDER BY upload_id
     ${lock ? sql`FOR UPDATE` : sql``}`)
  return new Map(rows.map((row) => [row.upload_id, row]))
}

/**
 * A complete upload becomes a blob (schema §3.4 «Порядок»): the size is checked, SHA-256
 * computed, the file linked into `blobs/` by the storage protocol; the upload keeps its hash
 * as `verified` until the command makes it a draft. Bytes already registered come back as
 * they are, so a repeat or a retry after a refusal does not need them again.
 */
async function registerUpload(
  db: Db,
  store: BlobStore,
  actor: Actor,
  requestId: string,
  row: UploadRow,
  media: values.MediaKind,
): Promise<string> {
  if (row.sha) return row.sha
  if (row.state === 'failed' || row.state === 'abandoned') {
    throw blocked('upload_failed', 'Загрузка прервана — загрузите файл заново', {
      upload_id: row.upload_id,
    })
  }
  const path = join(store.roots.dataRoot, row.tmp_key)
  const size = (await stat(path).catch(() => null))?.size
  if (size !== Number(row.size_expected)) {
    throw blocked('upload_incomplete', 'Файл ещё не докачан', { upload_id: row.upload_id })
  }
  const journal = { actor: journalActor(actor), action: 'inbox.upload', requestId }
  const raw = extOfName(row.client_filename)
  const ext = EXT.test(raw) ? raw : 'bin'
  let sha: string
  try {
    sha = await sha256OfFile(path)
    await registerBlob(db, store, {
      file: path,
      sha256: sha,
      ext,
      mediaKind: media,
      mime: mimeOfExt(ext),
      move: true,
      owner: OWNER,
    })
  } catch (error) {
    if (error instanceof StorageBusyError) {
      throw new ApiProblem('unavailable', 'Файл уже сохраняется — повторите через минуту')
    }
    const message = String((error as Error).message ?? error)
    await withActorTx(db, journal, (tx) =>
      tx.execute(sql`
        UPDATE web_uploads SET state = 'failed', error = ${message}
         WHERE id = ${row.id}::uuid AND sha256 IS NULL`),
    )
    throw blocked('upload_failed', 'Файл не сохранился — загрузите его заново', {
      upload_id: row.upload_id,
    })
  }
  await withActorTx(db, journal, (tx) =>
    tx.execute(sql`
      UPDATE web_uploads
         SET sha256 = ${shaBytes(sha)}, state = 'verified', bytes_received = size_expected,
             completed_at = coalesce(completed_at, now()), error = NULL
       WHERE id = ${row.id}::uuid AND sha256 IS NULL`),
  )
  return sha
}

/** The model's source «веб-загрузка» (schema §3.4 `sources.kind`), made on the first upload. */
async function webSource(tx: Tx, modelId: string): Promise<string> {
  const find = async () => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM sources WHERE model_id = ${modelId}::uuid AND kind = 'web_upload'
       ORDER BY created_at LIMIT 1`)
    return rows[0]?.id
  }
  const found = await find()
  if (found) return found
  await tx.execute(sql`
    INSERT INTO sources (model_id, kind, label, read_only, enabled)
    VALUES (${modelId}::uuid, 'web_upload', 'Веб-загрузка', false, true)
    ON CONFLICT (model_id, label) DO NOTHING`)
  const made = await find()
  if (!made) throw new Error('no web upload source')
  return made
}

async function makeGroup(
  tx: Tx,
  modelId: string,
  key: string,
  type: values.ContentType | null,
  files: number,
): Promise<string> {
  const sourceId = await webSource(tx, modelId)
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO inbox_groups (model_id, source_id, group_key, grouping, evidence, proposed_type)
    VALUES (${modelId}::uuid, ${sourceId}::uuid, ${`upload:${key}`}, 'manual',
            ${JSON.stringify({ root: UPLOADED, path: UPLOADED, files })}::jsonb, ${type})
    RETURNING id`)
  return (rows[0] as { id: string }).id
}

async function makeDraft(
  tx: Tx,
  modelId: string,
  groupId: string,
  planned: Planned,
  targetId: string | null,
): Promise<string> {
  const bytes = shaBytes(planned.sha)
  // With a target the uploaded bytes are the master, checked by their hash (SPEC §9.2).
  const master = targetId !== null
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO inbox_drafts (
      model_id, group_id, web_upload_id, origin, state, byte_size, path, source_sha256,
      source_blob_sha256, master_sha256, master_is_source, master_verified_at, ready_at,
      target_item_id
    ) VALUES (
      ${modelId}::uuid, ${groupId}::uuid, ${planned.row.id}::uuid, 'web_upload',
      ${master ? 'ready' : 'processing'}, ${Number(planned.row.size_expected)},
      ${planned.row.client_filename}, ${bytes}, ${bytes}, ${master ? bytes : null}, ${master},
      ${master ? sql`now()` : null}, ${master ? sql`now()` : null}, ${targetId}::uuid
    )
    RETURNING id`)
  return (rows[0] as { id: string }).id
}

export async function createUpload(
  services: Services,
  ctx: RequestContext,
  body: CreateUploadCommand,
): Promise<UploadResult> {
  const actor = requireActor(ctx)
  const model = ctx.model
  if (!model) throw new ApiProblem('not_found', 'Такой модели нет')
  if (body.target?.kind === 'plan_row') {
    throw new ApiProblem('not_implemented', 'Монтаж для строки плана — вместе с планом (этап 4а)')
  }
  const ids = body.files.map((file) => file.upload_id)
  if (new Set(ids).size !== ids.length) {
    throw new ApiProblem('invalid_request', 'Одна загрузка названа дважды')
  }
  const media = body.files.map(mediaOf)
  const itemId = body.target?.kind === 'item' ? body.target.item_id : null
  if (itemId) checkTarget(body.kind, await findItem(services.db, model, itemId), media)

  // Bytes first, each upload on its own: a blob, then `verified` with its hash.
  const rows = await loadUploads(services.db, model, ids)
  const planned: Planned[] = []
  for (const [index, file] of body.files.entries()) {
    const row = rows.get(file.upload_id)
    if (!row || row.principal_id !== actor.id) {
      throw new ApiProblem('not_found', 'Такой загрузки нет', { upload_id: file.upload_id })
    }
    const kind = media[index] as values.MediaKind
    const sha = await registerUpload(services.db, services.store, actor, ctx.requestId, row, kind)
    planned.push({ row, media: kind, sha })
  }

  const result = await services.command({ ctx, body }, async (tx, actor) => {
    const locked = await loadUploads(tx, model, ids, true)
    for (const item of planned) {
      const row = locked.get(item.row.upload_id)
      if (row?.state === 'registered') {
        throw blocked('upload_used', 'Эти файлы уже загружены', { upload_id: row.upload_id })
      }
      if (row?.state !== 'verified' || row.sha !== item.sha) {
        throw blocked('upload_incomplete', 'Файл ещё не докачан', {
          upload_id: item.row.upload_id,
        })
      }
    }
    const target = itemId ? await findItem(tx, model, itemId) : null
    await tx.execute(sql`
      UPDATE web_uploads
         SET state = 'registered', declared_kind = ${DECLARED_KIND[body.kind]},
             target_item_id = ${target?.id ?? null}::uuid
       WHERE model_id = ${model.id}::uuid
         AND id = ANY (${sql.param(planned.map((item) => item.row.id))}::uuid[])`)
    const type = !target && body.type ? ITEM_TO_DB_TYPE[body.type] : null
    const groupId = await makeGroup(tx, model.id, ids[0] as string, type, planned.length)
    const drafts: string[] = []
    for (const item of planned) {
      drafts.push(await makeDraft(tx, model.id, groupId, item, target?.id ?? null))
    }

    if (!target || !itemId) {
      // «Другое»: duplicates, derivatives and the master like a file fetched from a source.
      for (const [index, item] of planned.entries()) {
        await afterFetch(tx, model.id, drafts[index] as string, item.sha, null)
      }
      await logAction(tx, {
        modelId: model.id,
        action: 'upload.inbox',
        subjectKind: 'inbox_groups',
        subjectId: groupId,
        subjectLabel: UPLOADED,
        after: { Файлов: String(planned.length), Куда: 'Приехало' },
      })
      return {
        group_id: groupId,
        placed: 'inbox' as const,
        item_id: null,
        decision: type ? null : ('what_is_it' as const),
      }
    }

    // A target: the previews of the new master (no `encode_master`: these bytes are the
    // master), then the group is accepted into the target.
    for (const [index, item] of planned.entries()) {
      const draftId = drafts[index] as string
      await enqueueWork(tx, {
        modelId: model.id,
        kind: item.media === 'video' ? 'derive_video' : 'derive_image',
        workKey: `derive:${item.sha}:${draftId}`,
        inputSha256: shaBytes(item.sha),
        draftId,
        priority: 10,
      })
    }
    const accepted = await acceptGroup(
      tx,
      model,
      actor,
      groupId,
      acceptOptionsOf(body.kind, target, itemId),
    )
    return {
      group_id: groupId,
      placed: 'attached' as const,
      item_id: accepted.item_id,
      decision: null,
    }
  })

  // What tus left of the uploads (its info file): the bytes are a blob now.
  for (const id of ids) {
    await rm(uploadDir(services.store.roots.dataRoot, model.code, id), {
      recursive: true,
      force: true,
    }).catch(() => undefined)
  }
  return result
}
