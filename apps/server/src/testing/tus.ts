import type { TestServer } from './server'

/**
 * The tus 1.0 client side for tests (SPEC §6.1): create, send a chunk at its offset, ask for
 * the accepted byte — the same requests `tus-js-client` makes, over real HTTP: tus answers
 * through the Node response itself, which `app.inject` does not imitate fully.
 */

type App = TestServer['app']

/** Starts the app on a free loopback port once; gives its base address. */
export async function listening(app: App): Promise<string> {
  const address = app.server.address()
  if (address && typeof address === 'object') return `http://127.0.0.1:${address.port}`
  return app.listen({ host: '127.0.0.1', port: 0 })
}

function auth(as: string | null): Record<string, string> {
  if (!as) return {}
  return as.startsWith('Bearer ') ? { authorization: as } : { cookie: `co_session=${as}` }
}

const TUS = { 'tus-resumable': '1.0.0' }

function metadata(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`)
    .join(',')
}

export interface TusCreated {
  status: number
  /** `/api/v1/<model>/uploads/tus/<upload-id>` */
  location: string
  uploadId: string
}

export async function tusCreate(
  app: App,
  input: { model: string; as: string | null; name: string; size: number; kind?: string },
): Promise<TusCreated> {
  const response = await fetch(`${await listening(app)}/api/v1/${input.model}/uploads/tus`, {
    method: 'POST',
    headers: {
      ...TUS,
      ...auth(input.as),
      'upload-length': String(input.size),
      'upload-metadata': metadata({ filename: input.name, kind: input.kind ?? 'other' }),
    },
  })
  await response.arrayBuffer()
  const location = response.headers.get('location') ?? ''
  return { status: response.status, location, uploadId: location.split('/').pop() ?? '' }
}

export async function tusPatch(
  app: App,
  input: { location: string; as: string | null; offset: number; bytes: Buffer },
): Promise<{ status: number; offset: string | null }> {
  const response = await fetch(`${await listening(app)}${input.location}`, {
    method: 'PATCH',
    headers: {
      ...TUS,
      ...auth(input.as),
      'upload-offset': String(input.offset),
      'content-type': 'application/offset+octet-stream',
    },
    body: new Uint8Array(input.bytes),
  })
  await response.arrayBuffer()
  return { status: response.status, offset: response.headers.get('upload-offset') }
}

export async function tusHead(
  app: App,
  location: string,
  as: string | null,
): Promise<{ status: number; offset: string | null }> {
  const response = await fetch(`${await listening(app)}${location}`, {
    method: 'HEAD',
    headers: { ...TUS, ...auth(as) },
  })
  return { status: response.status, offset: response.headers.get('upload-offset') }
}

/** A whole upload in one chunk; gives its id for the command. */
export async function tusUpload(
  app: App,
  input: { model: string; as: string; name: string; bytes: Buffer; kind?: string },
): Promise<string> {
  const created = await tusCreate(app, { ...input, size: input.bytes.length })
  if (created.status !== 201) throw new Error(`tus create: ${created.status}`)
  const sent = await tusPatch(app, {
    location: created.location,
    as: input.as,
    offset: 0,
    bytes: input.bytes,
  })
  if (sent.status !== 204) throw new Error(`tus patch: ${sent.status}`)
  return created.uploadId
}
