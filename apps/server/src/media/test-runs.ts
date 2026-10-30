import { copyFile, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type Db, enqueueWork } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { currentDigests } from './pipeline'
import { type BlobStore, extOfName, sha256OfFile, shaBytes } from './storage'
import { renderKey } from './work/copies'

/**
 * Test runs of the media pipeline on real files before intake exists (PLAN 2б «проверен и
 * на настоящих файлах в ВМ»; stage 3 replaces this with 2в): a copy of a file already on
 * the VM's own disk goes to `staging/` under its hash, and the worker roles get the same
 * works intake will put — `derive_*` and, for a video, `encode_master`. Never a path under
 * `/mnt`: copy the file to `/srv/tmp` first (SPEC §12.0).
 */

const VIDEO = new Set(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi'])

async function modelId(db: Db, code: string): Promise<string> {
  const { rows } = await db.execute<{ id: string }>(sql`SELECT id FROM models WHERE code = ${code}`)
  const id = rows[0]?.id
  if (!id) throw new Error(`no model ${code}`)
  return id
}

export async function stageForTest(db: Db, store: BlobStore, model: string, file: string) {
  if (file.startsWith('/mnt/'))
    throw new Error('copy the file to /srv/tmp first: no work reads /mnt')
  const ext = extOfName(file)
  const sha = await sha256OfFile(file)
  await mkdir(store.stagingDir, { recursive: true })
  const target = join(store.stagingDir, `${sha}.${ext}`)
  const temp = `${target}.partial`
  await copyFile(file, temp)
  await rename(temp, target).catch(async (error) => {
    await rm(temp, { force: true })
    throw error
  })
  const id = await modelId(db, model)
  const video = VIDEO.has(ext)
  const works: string[] = []
  await db.transaction(async (tx) => {
    for (const kind of video
      ? (['derive_video', 'encode_master'] as const)
      : (['derive_image'] as const)) {
      const { work } = await enqueueWork(tx, {
        modelId: id,
        kind,
        workKey: `${kind === 'encode_master' ? 'master' : 'derive'}:${sha}`,
        inputSha256: shaBytes(sha),
        priority: kind === 'encode_master' ? 0 : 10,
      })
      works.push(`${kind} ${work.id}`)
    }
  })
  return { sha256: sha, staged: target, works }
}

/** «Для заливки» without a plan for a registered master: the platform copy, as a download asks. */
export async function renderForTest(db: Db, model: string, sha: string, stripped: boolean) {
  const digests = await currentDigests(db)
  if (!digests) throw new Error('no current pipeline version: start the worker roles first')
  const digest = stripped ? digests.platformStripped : digests.platform
  const { work } = await enqueueWork(db, {
    modelId: await modelId(db, model),
    kind: 'render',
    workKey: renderKey(sha, digest),
    inputSha256: shaBytes(sha),
    scope: stripped ? 'stripped' : 'kept',
    recipeDigest: digest,
    priority: 1_000_000,
  })
  return { work: work.id, state: work.state }
}
