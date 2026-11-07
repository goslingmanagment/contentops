import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  bootstrap,
  createDb,
  createPool,
  type Db,
  enqueueWork,
  resumeSwitch,
  SYSTEM_ACTOR,
  type WorkRow,
  withActorTx,
} from '@contentops/db'
import { createTestDatabase, type TestDatabase } from '@contentops/db/testing'
import type { ProviderName, Stage } from '@contentops/vision'
import { FakeProvider } from '@contentops/vision/testing'
import { sql } from 'drizzle-orm'
import sharp from 'sharp'
import type { BlobStore } from '../media/storage'
import { seedItem, tempStore } from '../media/testing'
import { BOOTSTRAP, OWNER } from '../testing/server'
import type { ProviderRegistry } from './providers'
import type { Consent, Route } from './settings'
import { type AnnotatePlan, annotateHandler } from './work'

/**
 * A stand of the cloud markup for the tests (SPEC §12.0: the providers are fake HTTP servers,
 * no network, no keys): a database after bootstrap, a store, both providers on one fake server
 * and the owner's settings written as `ops.js` writes them. Objects carry stored frames whose
 * EXIF says things that must never leave.
 */

export interface MarkupStand {
  db: Db
  database: TestDatabase
  store: BlobStore
  fake: FakeProvider
  providers: ProviderRegistry
  lora: string
  close(): Promise<void>
}

export async function markupStand(): Promise<MarkupStand> {
  const database = await createTestDatabase()
  const pool = createPool(database.url(), { max: 10 })
  const db = createDb(pool)
  await bootstrap(db, BOOTSTRAP, { env: { CONTENTOPS_OWNER_PASSWORD: OWNER.password } })
  const store = await tempStore('markup')
  const fake = await new FakeProvider().start()
  const adapters = { openai: fake.provider('openai'), anthropic: fake.provider('anthropic') }
  const { rows } = await db.execute<{ id: string }>(sql`SELECT id FROM models WHERE code = 'lora'`)
  return {
    db,
    database,
    store,
    fake,
    providers: (name) => adapters[name],
    lora: rows[0]?.id ?? '',
    close: async () => {
      await fake.stop()
      await pool.end()
      await database.drop()
    },
  }
}

const OWNER_TX = (action: string) => ({
  actor: SYSTEM_ACTOR('ops'),
  action,
  requestId: randomUUID(),
})

/** A `policy_settings` row as `ops.js` writes it; `null` — not set. Switching on releases. */
export async function setPolicy(
  db: Db,
  key: string,
  value: unknown,
  modelId: string | null = null,
): Promise<void> {
  await withActorTx(db, OWNER_TX('test.policy'), async (tx) => {
    await tx.execute(sql`
      INSERT INTO policy_settings (model_id, key, value)
      VALUES (${modelId}::uuid, ${key}, ${value === null ? null : JSON.stringify(value)}::jsonb)
      ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE SET value = excluded.value`)
    if (value !== null && value !== false) await resumeSwitch(tx, key)
  })
}

export const FAKE_MODEL = 'fake-model'

export function consent(overrides: Partial<Consent> = {}): Consent {
  return {
    by: 'Дмитрий',
    at: '2026-11-07T10:00:00.000Z',
    types: ['PPV', 'CUS', 'FYP', 'SET', 'SXT', 'LIFE', 'RAW'],
    stages: ['observe', 'aggregate', 'texts'],
    frames: true,
    privacy: 'store=false; тестовый поставщик',
    prices: { [FAKE_MODEL]: { input: 2, output: 10 } },
    ...overrides,
  }
}

export function route(...providers: ProviderName[]): Route {
  return { providers: providers.map((provider) => ({ provider, model: FAKE_MODEL })) }
}

/** Everything a routine markup of PPV and CUS by `providers` needs, budget $5. */
export async function allowMarkup(
  db: Db,
  providers: ProviderName[] = ['openai'],
  options: { texts?: boolean; usd?: number } = {},
): Promise<void> {
  for (const provider of new Set(providers)) {
    await setPolicy(db, `annotation.external.${provider}`, consent())
  }
  await setPolicy(db, 'annotation.budget', {
    usd: options.usd ?? 5,
    since: '2026-01-01T00:00:00.000Z',
  })
  for (const type of ['PPV', 'CUS']) {
    for (const stage of ['observe', 'aggregate', 'texts'] as const) {
      await setPolicy(db, `annotation.route.${type}.${stage}`, route(...providers))
    }
  }
  await setPolicy(db, 'annotation.enabled', true)
  if (options.texts !== false) await setPolicy(db, 'annotation.texts', true)
}

export interface FramedItem {
  itemId: string
  publicId: string
  versionId: string
  master: Buffer
  artifacts: string[]
}

/** A stored frame: a flat picture of a colour with EXIF that must not survive the send. */
async function frame(index: number, exif: string): Promise<Buffer> {
  return sharp({
    create: {
      width: 640,
      height: 360,
      channels: 3,
      background: { r: (index * 40) % 255, g: 120, b: 200 },
    },
  })
    .webp({ quality: 70 })
    .withExif({ IFD0: { ImageDescription: exif, Artist: exif } })
    .toBuffer()
}

/**
 * An object with a master video and `frames` stored frames, every few seconds, as the decoding
 * pass of intake leaves them (SPEC §9.3 `frames/NNNN.webp`).
 */
export async function framedItem(
  stand: MarkupStand,
  input: {
    type: 'PPV' | 'CUS' | 'FYP'
    number: number
    title?: string
    description?: string
    /** The description confirmed by a person: it goes out as the manager's notes. */
    notes?: boolean
    frames?: number
    exif?: string
  },
): Promise<FramedItem> {
  const master = randomBytes(32)
  const hex = master.toString('hex')
  await stand.db.execute(sql`
    INSERT INTO blobs (sha256, byte_size, mime, ext, media_kind, storage_key)
    VALUES (${master}, 1000, 'video/mp4', 'mp4', 'video',
            ${`blobs/sha256/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`})`)
  const item = await seedItem(stand.db, {
    model: stand.lora,
    type: input.type,
    number: input.number,
    ...(input.title ? { title: input.title } : {}),
    files: [{ role: 'master', mediaKind: 'video', master: hex, durationMs: 60_000 }],
  })
  const versionId = item.files[0]?.versionId ?? ''
  const artifacts: string[] = []
  await withActorTx(stand.db, OWNER_TX('test.frames'), async (tx) => {
    if (input.description !== undefined) {
      await tx.execute(sql`
        UPDATE content_items SET description = ${input.description}
         WHERE model_id = ${stand.lora}::uuid AND id = ${item.itemId}::uuid`)
      if (input.notes) {
        await tx.execute(sql`
          INSERT INTO annotation_fields (model_id, item_id, field, value_version,
                                         confirmed_value_version, confirmed_at)
          VALUES (${stand.lora}::uuid, ${item.itemId}::uuid, 'description', 1, 1, now())`)
      }
    }
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO rendition_generations (master_sha256, kind, recipe_digest, is_active, input_kind,
                                         input_sha256, state, ready_at, bound_at)
      VALUES (${master}, 'frames', 'test-frames', true, 'master', ${master}, 'ready', now(), now())
      RETURNING id`)
    const generation = rows[0]?.id ?? ''
    for (let i = 0; i < (input.frames ?? 4); i += 1) {
      const bytes = await frame(i, input.exif ?? 'clean')
      const name = `frames/${String(i * 4).padStart(4, '0')}.webp`
      const key = `derived/gen/${generation}/${name}`
      const path = stand.store.path(key)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes)
      const { rows: made } = await tx.execute<{ id: string }>(sql`
        INSERT INTO rendition_artifacts (generation_id, name, output_sha256, byte_size, mime, width,
                                         height, frame_ms, storage_key)
        VALUES (${generation}::uuid, ${name}, ${createHash('sha256').update(bytes).digest()},
                ${bytes.length}, 'image/webp', 640, 360, ${i * 4000}, ${key})
        RETURNING id`)
      artifacts.push(made[0]?.id ?? '')
    }
  })
  return { itemId: item.itemId, publicId: item.publicId, versionId, master, artifacts }
}

/** An order the CUS was delivered for: its brief and card are texts that never leave. */
export async function deliveredOrder(
  stand: MarkupStand,
  item: FramedItem,
  texts: { brief: string; card: string },
): Promise<void> {
  await withActorTx(stand.db, OWNER_TX('test.order'), async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO custom_orders (model_id, tg_chat, tg_message_id, card_author, card_at, buyer_name,
                                 brief, expects_video, expects_photos)
      VALUES (${stand.lora}::uuid, 'orders', ${Math.floor(Math.random() * 1e9)}, 'агент', now(),
              'Фан Иван', ${texts.brief}, true, false)
      RETURNING id`)
    const orderId = rows[0]?.id ?? ''
    await tx.execute(sql`
      INSERT INTO custom_order_messages (model_id, order_id, tg_ref, kind, message_at, author, excerpt)
      VALUES (${stand.lora}::uuid, ${orderId}::uuid, 'https://t.me/c/1/2', 'card', now(), 'агент',
              ${texts.card})`)
    const { rows: assets } = await tx.execute<{ membership_id: string; asset_id: string }>(sql`
      SELECT m.id AS membership_id, m.asset_id FROM item_memberships m
       WHERE m.model_id = ${stand.lora}::uuid AND m.item_id = ${item.itemId}::uuid`)
    const file = assets[0]
    const { rows: manifests } = await tx.execute<{ id: string }>(sql`
      INSERT INTO asset_manifests (model_id, purpose, origin_item_id, entry_count)
      VALUES (${stand.lora}::uuid, 'submission', ${item.itemId}::uuid, 1) RETURNING id`)
    const manifestId = manifests[0]?.id ?? ''
    await tx.execute(sql`
      INSERT INTO asset_manifest_entries (model_id, manifest_id, position, item_id, membership_id,
                                          asset_id, asset_version_id, handle_snapshot)
      VALUES (${stand.lora}::uuid, ${manifestId}::uuid, 1, ${item.itemId}::uuid,
              ${file?.membership_id}::uuid, ${file?.asset_id}::uuid, ${item.versionId}::uuid,
              'master')`)
    await tx.execute(sql`
      INSERT INTO custom_order_deliveries (model_id, order_id, part, item_id, manifest_id,
                                           delivered_at, basis)
      VALUES (${stand.lora}::uuid, ${orderId}::uuid, 'video', ${item.itemId}::uuid,
              ${manifestId}::uuid, now(), '{"signals":["test"]}'::jsonb)`)
  })
}

/**
 * Runs the work `annotate` of an object once, as the worker runs it: the routine markup by the
 * routes, or a measurement. Returns the work's report or what it threw.
 */
export async function annotateOnce(
  stand: MarkupStand,
  item: { itemId: string },
  plan: AnnotatePlan,
): Promise<{ report: unknown; error: unknown }> {
  const { work } = await enqueueWork(stand.db, {
    modelId: stand.lora,
    kind: 'annotate',
    workKey: `annotate:test:${randomUUID()}`,
    scope: item.itemId,
    dataset: plan.probe ? 'probe' : 'routine',
    checkpoint: { plan },
  })
  const handler = annotateHandler({ store: stand.store, providers: stand.providers })
  try {
    const result = await handler({
      work: work as WorkRow,
      db: stand.db,
      signal: new AbortController().signal,
      checkpoint: async () => {},
    })
    return { report: result?.report ?? null, error: null }
  } catch (error) {
    return { report: null, error }
  }
}

export const ROUTINE_PPV: AnnotatePlan = {
  stages: ['observe', 'aggregate', 'texts'] satisfies Stage[],
  probe: null,
}
export const ROUTINE_CUS: AnnotatePlan = { stages: ['observe', 'aggregate'], probe: null }
