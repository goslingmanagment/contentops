import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { apiRoutes } from '@contentops/contracts/api/routes/index'
import { tusUploadsPath, type UploadKind } from '@contentops/contracts/commands/uploads'
import { type Db, type values, withActorTx } from '@contentops/db'
import { FileStore } from '@tus/file-store'
import { EVENTS, Server, type Upload } from '@tus/server'
import { sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { journalActor } from '../commands'
import type { Actor, Authenticate, Authorize, ModelScope } from '../context'
import { ApiProblem } from '../errors'

/**
 * Web upload bytes over tus 1.0 (SPEC §6.1, schema §3.4 `web_uploads`): `@tus/server` in the
 * `web` role under `/api/v1/<model>/uploads/tus[/<upload-id>]`. The bytes land in
 * `DATA_ROOT/inbox/web/<model>/<upload-id>/data` (same filesystem as `blobs/`, so the
 * registration is a link, not a copy); chunks carry their offset and an interrupted upload
 * continues from the accepted byte, which `web_uploads.bytes_received` mirrors. Rights are
 * those of the final command `inbox.upload` and are checked before tus sees the request; an
 * upload is resumed or cancelled only by the one who started it. The final step — a blob, a
 * draft, «принято при загрузке» — is the command `POST /<model>/uploads` (`upload.ts`).
 */

export const WEB_INBOX = 'inbox/web'
const DATA = 'data'
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const UPLOAD_PATH = /\/api\/v1\/([^/]+)\/uploads\/tus\/([^/?#]+)\/?(?:[?#].*)?$/

/** The tus id of an upload is its key under `inbox/web`: `<model>/<upload-id>/data`. */
function storeId(model: string, uploadId: string): string {
  return `${model}/${uploadId}/${DATA}`
}

/** `inbox/web/<model>/<upload-id>/data` — `web_uploads.tmp_key`, relative to `DATA_ROOT`. */
export function uploadKey(model: string, uploadId: string): string {
  return `${WEB_INBOX}/${storeId(model, uploadId)}`
}

/** The folder of one upload: what is left of it after the bytes became a blob. */
export function uploadDir(dataRoot: string, model: string, uploadId: string): string {
  return join(dataRoot, WEB_INBOX, model, uploadId)
}

function partsOf(id: string): { model: string; uploadId: string } {
  const [model = '', uploadId = ''] = id.split('/')
  return { model, uploadId }
}

/** The button of the upload window as `web_uploads.declared_kind`. */
export const DECLARED_KIND: Record<UploadKind, values.UploadDeclaredKind> = {
  fyp_montage: 'fyp_edit',
  teaser: 'teaser',
  frames: 'processed_frames',
  master_version: 'master_version',
  other: 'other',
}

function declaredKind(value: string | null | undefined): values.UploadDeclaredKind {
  return (value && DECLARED_KIND[value as UploadKind]) || 'other'
}

interface Caller {
  actor: Actor
  model: ModelScope
  requestId: string
}

/** Who calls, for the hooks and the store: tus runs inside the request that checked it. */
const current = new AsyncLocalStorage<Caller>()

function callerOf(): Caller {
  const caller = current.getStore()
  if (!caller) throw { status_code: 500, body: 'Upload without a caller\n' }
  return caller
}

function journal(caller: Caller, action: string) {
  return { actor: journalActor(caller.actor), action, requestId: caller.requestId }
}

export interface TusOptions {
  db: Db
  authenticate: Authenticate
  authorize: Authorize
  dataRoot: string
}

/**
 * The tus file store that mirrors the accepted byte into `web_uploads.bytes_received` after
 * every chunk, a cut one too, before tus answers: the offset is the size of the file on disk.
 */
class UploadStore extends FileStore {
  constructor(
    directory: string,
    private readonly db: Db,
  ) {
    super({ directory })
  }

  override async write(readable: Readable, id: string, offset: number): Promise<number> {
    try {
      return await super.write(readable, id, offset)
    } finally {
      const upload = await this.getUpload(id).catch(() => null)
      const caller = current.getStore()
      if (upload && caller) {
        await syncOffset(this.db, caller, id, upload.offset).catch(() => undefined)
      }
    }
  }
}

export function createTusServer(options: TusOptions): Server {
  const { db } = options
  const store = new UploadStore(join(options.dataRoot, WEB_INBOX), db)
  const server = new Server({
    // Addresses are per model; `generateUrl` and `getFileIdFromRequest` map them to store ids.
    path: '/api/v1/uploads/tus',
    datastore: store,
    // Same origin only: no CORS answers.
    allowedOrigins: [],
    namingFunction: () => storeId(callerOf().model.code, randomUUID()),
    generateUrl: (_req, { id }) => {
      const { model, uploadId } = partsOf(id)
      return `${tusUploadsPath(model)}/${uploadId}`
    },
    getFileIdFromRequest: (req) => {
      const match = UPLOAD_PATH.exec(new URL(req.url).pathname)
      const [, model, uploadId] = match ?? []
      if (!model || !uploadId || !UPLOAD_ID.test(uploadId)) return undefined
      return storeId(decodeURIComponent(model), uploadId)
    },
    onUploadCreate: async (_req, upload) => {
      const caller = callerOf()
      const name = upload.metadata?.filename?.trim()
      if (upload.size === undefined) throw { status_code: 400, body: 'Upload-Length required\n' }
      if (!name) throw { status_code: 400, body: 'Upload-Metadata filename required\n' }
      const { uploadId } = partsOf(upload.id)
      await withActorTx(db, journal(caller, 'inbox.upload.create'), (tx) =>
        tx.execute(sql`
          INSERT INTO web_uploads (
            model_id, upload_id, principal_id, client_filename, declared_kind, size_expected,
            tmp_key
          ) VALUES (
            ${caller.model.id}::uuid, ${uploadId}, ${caller.actor.id}::uuid, ${name},
            ${declaredKind(upload.metadata?.kind)}, ${upload.size}, ${uploadKey(caller.model.code, uploadId)}
          )`),
      )
      return {}
    },
    onUploadFinish: async (_req, upload) => {
      const caller = callerOf()
      await setReceived(db, caller, upload)
      return {}
    },
  })
  server.on(EVENTS.POST_TERMINATE, (_req, _res, id) => {
    const caller = callerOf()
    const { uploadId } = partsOf(id)
    void withActorTx(db, journal(caller, 'inbox.upload.cancel'), (tx) =>
      tx.execute(sql`
        UPDATE web_uploads SET state = 'abandoned'
         WHERE model_id = ${caller.model.id}::uuid AND upload_id = ${uploadId}
           AND state IN ('receiving', 'received')`),
    ).catch(() => undefined)
  })
  return server
}

/** All bytes are here: `received`, waiting for the command that checks and registers them. */
async function setReceived(db: Db, caller: Caller, upload: Upload): Promise<void> {
  const { uploadId } = partsOf(upload.id)
  await withActorTx(db, journal(caller, 'inbox.upload.receive'), (tx) =>
    tx.execute(sql`
      UPDATE web_uploads
         SET state = 'received', bytes_received = size_expected,
             completed_at = coalesce(completed_at, now())
       WHERE model_id = ${caller.model.id}::uuid AND upload_id = ${uploadId}
         AND state = 'receiving'`),
  )
}

/** The accepted byte after a chunk (or after a cut). */
async function syncOffset(db: Db, caller: Caller, id: string, offset: number): Promise<void> {
  const { uploadId } = partsOf(id)
  await withActorTx(db, journal(caller, 'inbox.upload.receive'), (tx) =>
    tx.execute(sql`
      UPDATE web_uploads SET bytes_received = ${offset}
       WHERE model_id = ${caller.model.id}::uuid AND upload_id = ${uploadId}
         AND state IN ('receiving', 'received') AND bytes_received <> ${offset}`),
  )
}

/** Only who started an upload resumes, reads or cancels it; for anyone else it does not exist. */
async function checkOwner(db: Db, caller: Caller, uploadId: string): Promise<void> {
  const { rows } = await db.execute<{ principal_id: string }>(sql`
    SELECT principal_id FROM web_uploads
     WHERE model_id = ${caller.model.id}::uuid AND upload_id = ${uploadId}`)
  if (rows[0]?.principal_id !== caller.actor.id) {
    throw new ApiProblem('not_found', 'Такой загрузки нет')
  }
}

export function registerTus(app: FastifyInstance, options: TusOptions): void {
  const server = createTusServer(options)
  const route = apiRoutes.inbox.upload
  app.register(async (scope) => {
    // Chunks stream to tus as they come: Fastify does not read the body.
    scope.addContentTypeParser('application/offset+octet-stream', (_request, _payload, done) =>
      done(null),
    )
    const handle = async (
      request: FastifyRequest<{ Params: { model: string; upload?: string } }>,
      reply: FastifyReply,
    ) => {
      const actor = await options.authenticate(request)
      const model = await options.authorize({
        key: 'inbox.upload',
        route,
        actor,
        params: { model: request.params.model },
      })
      if (!actor || !model) throw new ApiProblem('unauthenticated', 'Нужно войти')
      const caller: Caller = { actor, model, requestId: request.id }
      const uploadId = request.params.upload
      if (uploadId !== undefined) {
        if (!UPLOAD_ID.test(uploadId)) throw new ApiProblem('not_found', 'Такой загрузки нет')
        await checkOwner(options.db, caller, uploadId)
      }
      reply.raw.setHeader('X-Request-Id', request.id)
      reply.hijack()
      try {
        await current.run(caller, () => server.handle(request.raw, reply.raw))
      } catch (error) {
        // A client gone mid-chunk: what arrived is on disk and its offset is saved.
        request.log.warn({ err: error }, 'tus request ended with an error')
      }
    }
    scope.route({
      method: 'POST',
      url: '/api/v1/:model/uploads/tus',
      schema: { hide: true },
      handler: handle,
    })
    scope.route({
      method: ['HEAD', 'PATCH', 'DELETE'],
      url: '/api/v1/:model/uploads/tus/:upload',
      schema: { hide: true },
      handler: handle,
    })
  })
}
