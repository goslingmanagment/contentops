// Web upload from the command line, for agents and the owner (SPEC §6.1, DESIGN §3.7): the
// same tus 1.0 chunks as the interface, resumed from the accepted byte when run again for
// the same files, then the final command `POST /api/v1/<model>/uploads` with an
// Idempotency-Key. The environment is that of `contentops` (packages/cli): the server in
// `CONTENTOPS_URL`, an agent's bearer token in `CONTENTOPS_TOKEN`; a person may pass the
// session cookie value in `CONTENTOPS_SESSION` instead.
//
//   CONTENTOPS_URL=… CONTENTOPS_TOKEN=… node apps/server/scripts/upload.ts <model> <kind> \
//     [--target PPV-089] [--type set] <files…>
//
// <kind>: fyp_montage | teaser | frames | master_version | other. Every kind but `other`
// needs --target (an object); `other` lands in «Приехало», --type answers «Что это?».
import { randomUUID } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { FileUrlStorage, Upload } from 'tus-js-client'

const KINDS = ['fyp_montage', 'teaser', 'frames', 'master_version', 'other']
const VIDEO = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mts'])
const CHUNK_BYTES = 50 * 1024 * 1024

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { target: { type: 'string' }, type: { type: 'string' } },
})
const [model, kind, ...files] = positionals
const token = process.env.CONTENTOPS_TOKEN
const session = process.env.CONTENTOPS_SESSION
if (!model || !kind || !KINDS.includes(kind) || files.length === 0) {
  process.stderr.write(
    'usage: CONTENTOPS_TOKEN=<token> node apps/server/scripts/upload.ts <model> ' +
      `<${KINDS.join('|')}> [--target PPV-089] [--type set] <files…>\n`,
  )
  process.exit(64)
}
const base = (process.env.CONTENTOPS_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')
if (!token && !session) {
  process.stderr.write('CONTENTOPS_TOKEN (agent) or CONTENTOPS_SESSION (person) is needed\n')
  process.exit(64)
}
const headers: Record<string, string> = token
  ? { Authorization: `Bearer ${token}` }
  : { Cookie: `co_session=${session}` }
// Upload addresses by file: a second run continues where the first stopped.
const urlStorage = new FileUrlStorage(join(tmpdir(), 'contentops-tus-uploads.json'))

function send(path: string): Promise<{ upload_id: string; file_name: string; size: number }> {
  const size = statSync(path).size
  const name = basename(path)
  return new Promise((resolve, reject) => {
    const upload = new Upload(createReadStream(path), {
      endpoint: `${base}/api/v1/${model}/uploads/tus`,
      headers,
      chunkSize: CHUNK_BYTES,
      retryDelays: [0, 1_000, 3_000, 10_000],
      uploadSize: size,
      metadata: { filename: name, kind: kind as string },
      urlStorage,
      removeFingerprintOnSuccess: true,
      onProgress: (sent, total) => {
        process.stderr.write(`\r${name}: ${Math.floor((sent / total) * 100)} %`)
      },
      onError: reject,
      onSuccess: () => {
        process.stderr.write(`\r${name}: передан\n`)
        resolve({ upload_id: upload.url?.split('/').pop() ?? '', file_name: name, size })
      },
    })
    upload.findPreviousUploads().then((previous) => {
      const [last] = previous
      if (last) upload.resumeFromPreviousUpload(last)
      upload.start()
    }, reject)
  })
}

const sent = []
for (const path of files) sent.push(await send(path))

const response = await fetch(`${base}/api/v1/${model}/uploads`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
  body: JSON.stringify({
    kind,
    target: values.target ? { kind: 'item', item_id: values.target } : null,
    ...(values.type ? { type: values.type } : {}),
    files: sent.map((file) => ({
      upload_id: file.upload_id,
      file_name: file.file_name,
      size_bytes: file.size,
      media: VIDEO.has(extname(file.file_name).toLowerCase()) ? 'video' : 'photo',
    })),
  }),
})
process.stdout.write(`${response.status} ${await response.text()}\n`)
process.exit(response.ok ? 0 : 1)
