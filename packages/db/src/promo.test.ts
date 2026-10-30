import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testing/index.ts'
import {
  factory,
  insert,
  journalContext,
  make,
  newBlob,
  newModel,
  newPrincipal,
  nextNumber,
  type Row,
} from './testing/rows.ts'
import { dbErrorCodes } from './values.ts'

/**
 * Promo (schema §3.8, §4, §9.1, §9.4; SPEC §5, §7.1): collections hold references without
 * copying bytes, one file once per collection; a handoff goes `preparing → prepared → sent`,
 * «Передано» only with a date and an author (except past packs from import), a sent handoff
 * never changes, a redo has one successor, and the history keeps the masters referenced — as
 * the app role, on real PostgreSQL.
 */

let db: TestDatabase
let pool: pg.Pool

beforeAll(async () => {
  db = await createTestDatabase()
  pool = new pg.Pool({ connectionString: db.url('app'), max: 4 })
})
afterAll(() => pool?.end())

async function inTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await journalContext(client)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

function fails(promise: Promise<unknown>, code: string, constraint?: string) {
  return expect(promise).rejects.toMatchObject(constraint ? { code, constraint } : { code })
}

function run(statement: string, params: unknown[]) {
  return inTx((c) => c.query(statement, params))
}

interface File {
  assetId: string
  versionId: string
  sha256: Buffer
}

/** A SET with one photo, owned. */
async function setWithPhoto(client: pg.ClientBase, modelId: string): Promise<File> {
  const item = await insert(client, 'content_items', {
    model_id: modelId,
    type: 'SET',
    number: nextNumber(),
    origin: 'manual',
  })
  const file = { assetId: randomUUID(), versionId: randomUUID(), sha256: await newBlob(client) }
  await insert(client, 'assets', {
    model_id: modelId,
    id: file.assetId,
    created_in_item_id: item.id,
    media_kind: 'image',
    current_version_id: file.versionId,
  })
  await insert(client, 'asset_versions', {
    model_id: modelId,
    id: file.versionId,
    asset_id: file.assetId,
    version_no: 1,
    master_sha256: file.sha256,
  })
  await insert(client, 'item_memberships', {
    model_id: modelId,
    item_id: item.id,
    item_type: 'SET',
    asset_id: file.assetId,
    kind: 'owned',
    role: 'raw',
    ordinal: 1,
  })
  return file
}

async function collection(client: pg.ClientBase, modelId: string): Promise<Row> {
  return make(client, 'content_items', modelId, ['promo_channel_id'])
}

function reference(modelId: string, prm: Row, file: File, ordinal: number): Row {
  return {
    model_id: modelId,
    item_id: prm.id,
    item_type: 'PRM',
    asset_id: file.assetId,
    kind: 'reference',
    role: 'pic',
    ordinal,
  }
}

/** A handoff of one file of the collection, sealed manifest included. */
async function handoff(
  client: pg.ClientBase,
  modelId: string,
  prm: Row,
  file: File,
  extra: Row = {},
): Promise<Row> {
  const manifest = await insert(client, 'asset_manifests', {
    model_id: modelId,
    purpose: 'delivery',
    origin_item_id: prm.id,
    entry_count: 1,
  })
  await insert(client, 'asset_manifest_entries', {
    model_id: modelId,
    manifest_id: manifest.id,
    position: 1,
    item_id: prm.id,
    asset_id: file.assetId,
    asset_version_id: file.versionId,
    handle_snapshot: 'SET-001/raw01',
  })
  return insert(client, 'promo_deliveries', {
    model_id: modelId,
    package_item_id: prm.id,
    channel_id: prm.promo_channel_id,
    contractor_id: (await make(client, 'contractors', modelId)).id,
    format: 'upload',
    manifest_id: manifest.id,
    prepared_at: new Date().toISOString(),
    prepared_by: await newPrincipal(client),
    ...extra,
  })
}

/** A sealed receipt of the handoff's manifest: what the export work writes. */
async function receiptFor(client: pg.ClientBase, modelId: string, delivery: Row, file: File) {
  const receipt = await insert(client, 'download_receipts', {
    model_id: modelId,
    principal_id: delivery.prepared_by,
    kind: 'promo',
    manifest_id: delivery.manifest_id,
    meta_stripped: true,
    zip_key: 'exports/x/PRM-001_c.zip',
    entry_count: 1,
  })
  await insert(client, 'download_receipt_entries', {
    model_id: modelId,
    receipt_id: receipt.id,
    position: 1,
    asset_id: file.assetId,
    asset_version_id: file.versionId,
    issued_master: true,
    file_name: 'PRM-001_01_SET-001-raw01.jpg',
    output_sha256: file.sha256,
    byte_size: 1,
  })
  return receipt
}

describe('collections hold references (SPEC §7.1)', () => {
  it('one file twice in one collection is refused; in two collections it is fine', async () => {
    const modelId = await inTx((c) => newModel(c))
    const { file, first, second } = await inTx(async (c) => ({
      file: await setWithPhoto(c, modelId),
      first: await collection(c, modelId),
      second: await collection(c, modelId),
    }))
    await inTx((c) => insert(c, 'item_memberships', reference(modelId, first, file, 1)))
    await fails(
      inTx((c) => insert(c, 'item_memberships', reference(modelId, first, file, 2))),
      '23505',
      'item_memberships_model_id_item_id_asset_id_key',
    )
    await inTx((c) => insert(c, 'item_memberships', reference(modelId, second, file, 1)))
    const { rows } = await pool.query(
      `SELECT count(*)::int AS memberships,
              (SELECT count(*)::int FROM asset_versions WHERE asset_id = $1) AS versions
         FROM item_memberships WHERE asset_id = $1`,
      [file.assetId],
    )
    expect(rows[0], 'links, not copies: still one version and one blob').toEqual({
      memberships: 3,
      versions: 1,
    })
  })

  it('a default contractor belongs to a PRM only', async () => {
    const modelId = await inTx((c) => newModel(c))
    const contractor = await inTx((c) => make(c, 'contractors', modelId))
    await fails(
      inTx((c) =>
        insert(c, 'content_items', {
          model_id: modelId,
          type: 'SET',
          number: nextNumber(),
          origin: 'manual',
          default_contractor_id: contractor.id,
        }),
      ),
      '23514',
      'content_items_default_contractor',
    )
    await inTx(async (c) =>
      insert(c, 'content_items', {
        ...(await factory('content_items')(c, modelId, ['promo_channel_id'])),
        default_contractor_id: contractor.id,
      }),
    )
  })

  it('a contractor name is unique inside the model; the format is from the list', async () => {
    const modelId = await inTx((c) => newModel(c))
    await inTx((c) =>
      insert(c, 'contractors', { model_id: modelId, name: 'Coraline Red', format: 'master' }),
    )
    await fails(
      inTx((c) =>
        insert(c, 'contractors', { model_id: modelId, name: 'Coraline Red', format: 'upload' }),
      ),
      '23505',
      'contractors_name',
    )
    await fails(
      inTx((c) => insert(c, 'contractors', { model_id: modelId, name: 'X', format: 'compact' })),
      '23514',
      'contractors_format_check',
    )
  })
})

describe('handoffs (schema §3.8, §4)', () => {
  async function prepared(modelId: string) {
    return inTx(async (c) => {
      const file = await setWithPhoto(c, modelId)
      const prm = await collection(c, modelId)
      await insert(c, 'item_memberships', reference(modelId, prm, file, 1))
      const delivery = await handoff(c, modelId, prm, file)
      const receipt = await receiptFor(c, modelId, delivery, file)
      await c.query(
        "UPDATE promo_deliveries SET state = 'prepared', receipt_id = $2 WHERE id = $1",
        [delivery.id, receipt.id],
      )
      return { file, prm, delivery, receipt }
    })
  }

  it('«Передано» only with a date and an author; prepared only with a receipt', async () => {
    const modelId = await inTx((c) => newModel(c))
    const { delivery, file, prm } = await prepared(modelId)
    await fails(
      run("UPDATE promo_deliveries SET state = 'sent' WHERE id = $1", [delivery.id]),
      '23514',
      'promo_deliveries_sent',
    )
    await fails(
      run("UPDATE promo_deliveries SET state = 'sent', sent_at = now() WHERE id = $1", [
        delivery.id,
      ]),
      '23514',
      'promo_deliveries_sent',
    )
    await run(
      "UPDATE promo_deliveries SET state = 'sent', sent_at = now(), sent_by = prepared_by WHERE id = $1",
      [delivery.id],
    )
    const other = await inTx((c) => handoff(c, modelId, prm, file))
    await fails(
      run("UPDATE promo_deliveries SET state = 'prepared' WHERE id = $1", [other.id]),
      '23514',
      'promo_deliveries_prepared',
    )
    await fails(
      run(
        "UPDATE promo_deliveries SET state = 'sent', sent_at = now(), sent_by = prepared_by WHERE id = $1",
        [other.id],
      ),
      dbErrorCodes.transitionRefused,
    )
  })

  it('«Передано» twice changes nothing: the update waits for `prepared`', async () => {
    const modelId = await inTx((c) => newModel(c))
    const { delivery } = await prepared(modelId)
    const mark = `UPDATE promo_deliveries SET state = 'sent', sent_at = now(), sent_by = prepared_by
                   WHERE id = $1 AND state = 'prepared'`
    expect((await run(mark, [delivery.id])).rowCount).toBe(1)
    expect((await run(mark, [delivery.id])).rowCount).toBe(0)
  })

  it('a sent handoff is history: no change, no delete; a prepared one never goes back', async () => {
    const modelId = await inTx((c) => newModel(c))
    const { delivery } = await prepared(modelId)
    await fails(
      run("UPDATE promo_deliveries SET state = 'preparing', receipt_id = NULL WHERE id = $1", [
        delivery.id,
      ]),
      dbErrorCodes.immutableColumn,
    )
    await fails(
      run("UPDATE promo_deliveries SET state = 'preparing' WHERE id = $1", [delivery.id]),
      dbErrorCodes.transitionRefused,
    )
    await run(
      "UPDATE promo_deliveries SET state = 'sent', sent_at = now(), sent_by = prepared_by WHERE id = $1",
      [delivery.id],
    )
    await fails(
      run("UPDATE promo_deliveries SET recipient_note = 'позже' WHERE id = $1", [delivery.id]),
      dbErrorCodes.immutableRow,
    )
    await fails(run('DELETE FROM promo_deliveries WHERE id = $1', [delivery.id]), '42501')
  })

  it('the format and the composition of a prepared handoff never change', async () => {
    const modelId = await inTx((c) => newModel(c))
    const { delivery } = await prepared(modelId)
    await fails(
      run("UPDATE promo_deliveries SET format = 'master' WHERE id = $1", [delivery.id]),
      dbErrorCodes.immutableColumn,
    )
    const other = await inTx(async (c) =>
      insert(c, 'asset_manifests', {
        model_id: modelId,
        purpose: 'delivery',
        entry_count: 1,
      }).then(async (manifest) => {
        const file = await setWithPhoto(c, modelId)
        await insert(c, 'asset_manifest_entries', {
          model_id: modelId,
          manifest_id: manifest.id,
          position: 1,
          item_id: delivery.package_item_id,
          asset_id: file.assetId,
          asset_version_id: file.versionId,
          handle_snapshot: 'SET-002/raw01',
        })
        return manifest
      }),
    )
    await fails(
      run('UPDATE promo_deliveries SET manifest_id = $2 WHERE id = $1', [delivery.id, other.id]),
      dbErrorCodes.immutableColumn,
    )
  })

  it('a redo has one successor', async () => {
    const modelId = await inTx((c) => newModel(c))
    const { delivery, file, prm } = await prepared(modelId)
    await inTx((c) => handoff(c, modelId, prm, file, { corrects_id: delivery.id }))
    await fails(
      inTx((c) => handoff(c, modelId, prm, file, { corrects_id: delivery.id })),
      '23505',
      'promo_deliveries_corrects_once',
    )
  })

  it('a past pack from import is sent without date, author, format or receipt', async () => {
    const modelId = await inTx((c) => newModel(c))
    const { file, prm } = await prepared(modelId)
    const past = { origin: 'import', state: 'sent', summary: { folder_date: '2026-09-02' } }
    await inTx((c) =>
      handoff(c, modelId, prm, file, {
        ...past,
        format: null,
        prepared_at: null,
        prepared_by: null,
      }),
    )
    await fails(
      inTx((c) =>
        handoff(c, modelId, prm, file, {
          ...past,
          format: null,
          prepared_at: null,
          prepared_by: null,
          sent_at: new Date().toISOString(),
        }),
      ),
      '23514',
      'promo_deliveries_sent',
    )
    await fails(
      inTx((c) =>
        handoff(c, modelId, prm, file, { ...past, prepared_at: null, prepared_by: null }),
      ),
      '23514',
      'promo_deliveries_prepared',
    )
    await fails(
      inTx((c) => handoff(c, modelId, prm, file, { format: null })),
      '23514',
      'promo_deliveries_sent',
    )
  })

  it('a handoff belongs to a PRM collection', async () => {
    const modelId = await inTx((c) => newModel(c))
    await fails(
      inTx(async (c) => {
        const row = await factory('promo_deliveries')(c, modelId)
        const set = await insert(c, 'content_items', {
          model_id: modelId,
          type: 'SET',
          number: nextNumber(),
          origin: 'manual',
        })
        return insert(c, 'promo_deliveries', {
          ...row,
          package_item_id: set.id,
          package_item_type: 'SET',
        })
      }),
      '23514',
      'promo_deliveries_package_item_type_check',
    )
  })

  it('the history keeps the master referenced after the collection drops the file', async () => {
    const modelId = await inTx((c) => newModel(c))
    const { file, prm, delivery } = await prepared(modelId)
    await run(
      "UPDATE promo_deliveries SET state = 'sent', sent_at = now(), sent_by = prepared_by WHERE id = $1",
      [delivery.id],
    )
    await run(
      'UPDATE item_memberships SET removed_at = now() WHERE item_id = $1 AND asset_id = $2',
      [prm.id, file.assetId],
    )
    const { rows } = await pool.query(
      `SELECT blob_is_referenced($1) AS held,
              (SELECT count(*)::int FROM promo_deliveries d
                 JOIN asset_manifest_entries e ON e.manifest_id = d.manifest_id
                 JOIN asset_versions v ON v.id = e.asset_version_id
                WHERE v.master_sha256 = $1) AS in_history`,
      [file.sha256],
    )
    expect(rows[0]).toEqual({ held: true, in_history: 1 })
  })
})
