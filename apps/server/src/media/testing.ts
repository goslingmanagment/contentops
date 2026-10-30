import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Db, SYSTEM_ACTOR, type Tx, withActorTx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { BlobStore } from './storage'

/**
 * Test helpers of the media pipeline: storage roots in a temp dir and minimal catalog rows
 * (object, files, versions) over real blobs. The catalog fixture factory of 2а builds on the
 * same rows; these stay small on purpose.
 */

export async function tempStore(label = 'store'): Promise<BlobStore> {
  const base = await mkdtemp(join(tmpdir(), `contentops-${label}-`))
  const roots = {
    dataRoot: join(base, 'content'),
    derivedRoot: join(base, 'derived'),
    tmpRoot: join(base, 'tmp'),
  }
  for (const dir of Object.values(roots)) await mkdir(dir, { recursive: true })
  return new BlobStore(roots)
}

/** A file with given bytes in a temp dir; returns its path and SHA-256. */
export async function tempFile(
  bytes: Buffer | string,
  name = 'file.bin',
): Promise<{ path: string; sha256: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'contentops-file-'))
  const path = join(dir, name)
  await writeFile(path, bytes)
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') }
}

export async function systemTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withActorTx(
    db,
    { actor: SYSTEM_ACTOR('test'), action: 'test', requestId: randomUUID() },
    fn,
  )
}

export async function modelId(db: Db, code: string): Promise<string> {
  const { rows } = await db.execute<{ id: string }>(sql`SELECT id FROM models WHERE code = ${code}`)
  const id = rows[0]?.id
  if (!id) throw new Error(`no model ${code}`)
  return id
}

export interface SeedFile {
  role: 'master' | 'teaser' | 'pic' | 'raw' | 'ed' | 'clip' | 'thumb'
  ordinal?: number | null
  mediaKind: 'video' | 'image'
  /** Hex SHA-256 of a present blob. */
  master: string
  sourceSha256?: string | null
  durationMs?: number | null
  width?: number | null
  height?: number | null
  selected?: boolean
  lifeUse?: 'feed' | 'chats' | 'both' | null
}

export interface SeededItem {
  itemId: string
  publicId: string
  files: { assetId: string; versionId: string; membershipId: string; master: string }[]
}

const PAD: Record<string, number> = { FYP: 4, RAW: 4 }

/** An object with owned files whose current versions point at present blobs. */
export async function seedItem(
  db: Db,
  input: {
    model: string
    type: 'PPV' | 'SET' | 'SXT' | 'CUS' | 'FYP' | 'LIFE' | 'RAW'
    number: number
    title?: string
    titleEn?: string | null
    files: SeedFile[]
  },
): Promise<SeededItem> {
  return systemTx(db, async (tx) => {
    const itemId = randomUUID()
    await tx.execute(sql`
      INSERT INTO content_items (model_id, id, type, number, title, title_en, ppv_kind, raw_purpose,
                                 origin)
      VALUES (${input.model}::uuid, ${itemId}::uuid, ${input.type}, ${input.number},
              ${input.title ?? null}, ${input.titleEn ?? null},
              ${input.type === 'PPV' ? 'bundle' : null}, ${input.type === 'RAW' ? 'unknown' : null},
              'manual')`)
    const files: SeededItem['files'] = []
    for (const [index, file] of input.files.entries()) {
      const assetId = randomUUID()
      const versionId = randomUUID()
      const membershipId = randomUUID()
      await tx.execute(sql`
        INSERT INTO assets (model_id, id, created_in_item_id, media_kind, current_version_id)
        VALUES (${input.model}::uuid, ${assetId}::uuid, ${itemId}::uuid, ${file.mediaKind},
                ${versionId}::uuid)`)
      await tx.execute(sql`
        INSERT INTO asset_versions (model_id, id, asset_id, version_no, master_sha256, source_sha256,
                                    duration_ms, width, height)
        VALUES (${input.model}::uuid, ${versionId}::uuid, ${assetId}::uuid, 1,
                ${Buffer.from(file.master, 'hex')},
                ${file.sourceSha256 ? Buffer.from(file.sourceSha256, 'hex') : null},
                ${file.durationMs ?? null}, ${file.width ?? null}, ${file.height ?? null})`)
      await tx.execute(sql`
        INSERT INTO item_memberships (model_id, id, item_id, item_type, asset_id, kind, role, ordinal,
                                      display_position, selected, life_use)
        VALUES (${input.model}::uuid, ${membershipId}::uuid, ${itemId}::uuid, ${input.type},
                ${assetId}::uuid, 'owned', ${file.role}, ${file.ordinal ?? null}, ${index + 1},
                ${file.selected ?? false}, ${file.lifeUse ?? null})`)
      files.push({ assetId, versionId, membershipId, master: file.master })
    }
    const pad = PAD[input.type] ?? 3
    return { itemId, publicId: `${input.type}-${String(input.number).padStart(pad, '0')}`, files }
  })
}
