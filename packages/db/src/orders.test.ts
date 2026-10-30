import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testing/index.ts'
import {
  factory,
  insert,
  journalContext,
  newBlob,
  newModel,
  nextNumber,
  type Row,
} from './testing/rows.ts'
import { dbErrorCodes } from './values.ts'

/**
 * Custom orders (schema §3.7, §9.2, §9.4; SPEC §5, §8.2): parts and status, closing and
 * cancelling, retractions and revisions inside their order, serialisation on the order row and
 * the custom fields of `catalog_index` — as the app role, on real PostgreSQL.
 */

let db: TestDatabase
let pool: pg.Pool

beforeAll(async () => {
  db = await createTestDatabase()
  pool = new pg.Pool({ connectionString: db.url('app'), max: 4 })
})
afterAll(() => pool?.end())

/** One committed transaction with the journal context; COMMIT errors (deferred) reject too. */
async function inTx<T>(fn: (client: pg.PoolClient) => Promise<T>, target = pool): Promise<T> {
  const client = await target.connect()
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

async function model(): Promise<string> {
  return inTx((client) => newModel(client))
}

async function newOrder(client: pg.ClientBase, modelId: string, extra: Row = {}): Promise<Row> {
  return insert(client, 'custom_orders', {
    ...(await factory('custom_orders')(client, modelId)),
    ...extra,
  })
}

async function newCustom(client: pg.ClientBase, modelId: string, extra: Row = {}): Promise<Row> {
  return insert(client, 'content_items', {
    model_id: modelId,
    type: 'CUS',
    number: nextNumber(),
    origin: 'intake',
    ...extra,
  })
}

interface File {
  assetId: string
  versionId: string
}

/** Owned files of a CUS: a video is its master, images are `pic` from `firstOrdinal` on. */
async function addFiles(
  client: pg.ClientBase,
  modelId: string,
  item: Row,
  media: 'video' | 'image',
  count: number,
  firstOrdinal = 1,
): Promise<File[]> {
  const files: File[] = []
  for (let i = 0; i < count; i++) {
    const file = { assetId: randomUUID(), versionId: randomUUID() }
    await insert(client, 'assets', {
      model_id: modelId,
      id: file.assetId,
      created_in_item_id: item.id,
      media_kind: media,
      current_version_id: file.versionId,
    })
    await insert(client, 'asset_versions', {
      model_id: modelId,
      id: file.versionId,
      asset_id: file.assetId,
      version_no: 1,
      master_sha256: await newBlob(client, media),
    })
    await insert(client, 'item_memberships', {
      model_id: modelId,
      item_id: item.id,
      item_type: 'CUS',
      asset_id: file.assetId,
      kind: 'owned',
      role: media === 'video' ? 'master' : 'pic',
      ordinal: media === 'video' ? null : firstOrdinal + i,
    })
    files.push(file)
  }
  return files
}

/** A delivery of a part: a sealed manifest of the files, then the delivery row. */
async function deliver(
  client: pg.ClientBase,
  modelId: string,
  orderId: unknown,
  item: Row,
  part: 'video' | 'photos',
  files: File[],
  extra: Row = {},
): Promise<Row> {
  const manifest = await insert(client, 'asset_manifests', {
    model_id: modelId,
    purpose: 'submission',
    origin_item_id: item.id,
    entry_count: files.length,
  })
  for (const [i, file] of files.entries()) {
    await insert(client, 'asset_manifest_entries', {
      model_id: modelId,
      manifest_id: manifest.id,
      position: i + 1,
      item_id: item.id,
      asset_id: file.assetId,
      asset_version_id: file.versionId,
      handle_snapshot: `CUS/${i + 1}`,
    })
  }
  return insert(client, 'custom_order_deliveries', {
    model_id: modelId,
    order_id: orderId,
    part,
    item_id: item.id,
    manifest_id: manifest.id,
    delivered_at: new Date().toISOString(),
    basis: { reply: true },
    ...extra,
  })
}

function retraction(modelId: string, delivery: Row): Row {
  return {
    model_id: modelId,
    order_id: delivery.order_id,
    retracts_id: delivery.id,
    retract_reason: 'не тот заказ',
  }
}

async function orderRow(id: unknown): Promise<Row> {
  const { rows } = await pool.query('SELECT * FROM custom_orders WHERE id = $1', [id])
  return rows[0]
}

const MARK_VIDEO = 'UPDATE custom_orders SET video_completed_at = now() WHERE id = $1'
const MARK_PHOTOS = 'UPDATE custom_orders SET photos_completed_at = now() WHERE id = $1'
const CLOSE = "UPDATE custom_orders SET status = 'closed', closed_at = now() WHERE id = $1"

/** A video-only order with its video delivered and marked: status `delivered`. */
async function deliveredOrder(modelId: string): Promise<{ order: Row; delivery: Row }> {
  return inTx(async (c) => {
    const order = await newOrder(c, modelId)
    const item = await newCustom(c, modelId)
    const clip = await addFiles(c, modelId, item, 'video', 1)
    const delivery = await deliver(c, modelId, order.id, item, 'video', clip)
    await c.query(MARK_VIDEO, [order.id])
    return { order, delivery }
  })
}

describe('parts and status of an order (schema §9.2; SPEC §5, §8.2)', () => {
  it('only the video of a video+photos order is not delivered; 1 of 20 photos is not delivered', async () => {
    const modelId = await model()
    const order = await inTx(async (c) => {
      const order = await newOrder(c, modelId, {
        ordered_duration_raw: '10 минут - 20 фото',
        expects_photos: true,
        photo_count: 20,
      })
      const video = await newCustom(c, modelId)
      await deliver(
        c,
        modelId,
        order.id,
        video,
        'video',
        await addFiles(c, modelId, video, 'video', 1),
      )
      return order
    })
    expect(order.status).toBe('open')
    // The video part alone: its mark stands, the order stays open.
    await run(MARK_VIDEO, [order.id])
    expect(await orderRow(order.id)).toMatchObject({ status: 'open' })
    await fails(run(MARK_PHOTOS, [order.id]), dbErrorCodes.transitionRefused)

    // One photo of twenty, then the same photo again: one distinct file.
    const { photos, first } = await inTx(async (c) => {
      const photos = await newCustom(c, modelId)
      const first = await addFiles(c, modelId, photos, 'image', 1)
      await deliver(c, modelId, order.id, photos, 'photos', first)
      await deliver(c, modelId, order.id, photos, 'photos', first)
      return { photos, first }
    })
    await fails(run(MARK_PHOTOS, [order.id]), dbErrorCodes.transitionRefused)
    expect(await orderRow(order.id)).toMatchObject({ status: 'open', photos_completed_at: null })

    // A video sent as the photo part is not a photo.
    await inTx(async (c) => {
      const clip = await newCustom(c, modelId)
      await deliver(c, modelId, order.id, clip, 'photos', [
        ...first,
        ...(await addFiles(c, modelId, clip, 'video', 1)),
      ])
    })
    await fails(run(MARK_PHOTOS, [order.id]), dbErrorCodes.transitionRefused)

    // Nineteen more: twenty distinct photos, every part is in.
    const rest = await inTx(async (c) =>
      deliver(
        c,
        modelId,
        order.id,
        photos,
        'photos',
        await addFiles(c, modelId, photos, 'image', 19, 2),
      ),
    )
    await run(MARK_PHOTOS, [order.id])
    expect(await orderRow(order.id)).toMatchObject({ status: 'delivered' })

    // A retraction takes the mark of its part away: the order is open again.
    await inTx((c) => insert(c, 'custom_order_deliveries', retraction(modelId, rest)))
    const after = await orderRow(order.id)
    expect(after).toMatchObject({ status: 'open', photos_completed_at: null })
    expect(after.video_completed_at).not.toBeNull()
    await fails(run(MARK_PHOTOS, [order.id]), dbErrorCodes.transitionRefused)
  })

  it('a mark only for an ordered part; a new order is never born delivered', async () => {
    const modelId = await model()
    const photosOnly = await inTx((c) =>
      newOrder(c, modelId, { expects_video: false, expects_photos: true }),
    )
    await fails(run(MARK_VIDEO, [photosOnly.id]), '23514', 'custom_orders_video_mark')
    await fails(
      inTx((c) => newOrder(c, modelId, { expects_video: false })),
      '23514',
      'custom_orders_parts',
    )
    await fails(
      inTx((c) => newOrder(c, modelId, { video_completed_at: new Date().toISOString() })),
      dbErrorCodes.transitionRefused,
    )
    await fails(
      inTx((c) => newOrder(c, modelId, { status: 'closed', closed_at: new Date().toISOString() })),
      dbErrorCodes.transitionRefused,
    )
    // Writing `delivered` does not make it so: open ⇔ delivered follows the marks.
    const order = await inTx((c) => newOrder(c, modelId, { status: 'delivered' }))
    expect(order.status).toBe('open')
  })

  it('closing needs every part and no open revision; closed and cancelled are final', async () => {
    const modelId = await model()
    const { order, item, clip } = await inTx(async (c) => {
      const order = await newOrder(c, modelId)
      const item = await newCustom(c, modelId)
      return { order, item, clip: await addFiles(c, modelId, item, 'video', 1) }
    })
    await fails(run(CLOSE, [order.id]), dbErrorCodes.transitionRefused)
    await inTx(async (c) => {
      await deliver(c, modelId, order.id, item, 'video', clip)
      await c.query(MARK_VIDEO, [order.id])
    })
    expect(await orderRow(order.id)).toMatchObject({ status: 'delivered' })

    // «Сдано, требуется правка»: delivered with an open revision; closing is refused.
    const revision = await inTx((c) =>
      insert(c, 'custom_order_revisions', {
        model_id: modelId,
        order_id: order.id,
        requirement: 'без музыки',
        request_tg_ref: 'tg:-100/3/9',
        requested_at: new Date().toISOString(),
      }),
    )
    await fails(run(CLOSE, [order.id]), dbErrorCodes.transitionRefused)
    // The fixed version is a new delivery; binding it does not close the revision.
    const fixed = await inTx(async (c) => {
      const second = await newCustom(c, modelId)
      return deliver(
        c,
        modelId,
        order.id,
        second,
        'video',
        await addFiles(c, modelId, second, 'video', 1),
      )
    })
    await fails(
      run(
        'UPDATE custom_order_revisions SET done = true, done_at = now(), fixed_delivery_id = $2 WHERE id = $1',
        [revision.id, fixed.id],
      ),
      '23514',
      'custom_order_revisions_done_basis',
    )
    await run(
      `UPDATE custom_order_revisions SET done = true, done_at = now(), fixed_delivery_id = $2,
              done_basis = 'новая версия проверена' WHERE id = $1`,
      [revision.id, fixed.id],
    )
    await run(CLOSE, [order.id])
    expect(await orderRow(order.id)).toMatchObject({ status: 'closed' })

    // A closed order takes no open revision, delivery, retraction, mark or status change.
    const refused: [string, (c: pg.PoolClient) => Promise<unknown>][] = [
      [
        'open revision',
        (c) =>
          insert(c, 'custom_order_revisions', {
            model_id: modelId,
            order_id: order.id,
            requirement: 'ещё правка',
            request_tg_ref: 'tg:-100/3/10',
            requested_at: new Date().toISOString(),
          }),
      ],
      [
        'reopened revision',
        (c) =>
          c.query(
            'UPDATE custom_order_revisions SET done = false, done_at = NULL, reopened_at = now() WHERE id = $1',
            [revision.id],
          ),
      ],
      ['delivery', (c) => deliver(c, modelId, order.id, item, 'video', clip)],
      ['retraction', (c) => insert(c, 'custom_order_deliveries', retraction(modelId, fixed))],
      [
        'reopen',
        (c) =>
          c.query("UPDATE custom_orders SET status = 'open', closed_at = NULL WHERE id = $1", [
            order.id,
          ]),
      ],
      [
        'cancel',
        (c) =>
          c.query(
            `UPDATE custom_orders SET status = 'cancelled', closed_at = NULL, cancelled_at = now(),
                    cancel_reason = 'возврат' WHERE id = $1`,
            [order.id],
          ),
      ],
      [
        'unmark',
        (c) =>
          c.query('UPDATE custom_orders SET video_completed_at = NULL WHERE id = $1', [order.id]),
      ],
    ]
    for (const [what, statement] of refused) {
      await expect(inTx(statement), what).rejects.toMatchObject({
        code: dbErrorCodes.transitionRefused,
      })
    }
    // The card fields stay editable.
    await run("UPDATE custom_orders SET buyer_name = 'фан' WHERE id = $1", [order.id])

    // «Снят» needs a reason; then it is final too.
    const other = await inTx((c) => newOrder(c, modelId))
    await fails(
      run("UPDATE custom_orders SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [
        other.id,
      ]),
      '23514',
      'custom_orders_cancelled',
    )
    await run(
      `UPDATE custom_orders SET status = 'cancelled', cancelled_at = now(),
              cancel_reason = 'ошибочная карточка' WHERE id = $1`,
      [other.id],
    )
    await fails(
      inTx(async (c) => deliver(c, modelId, other.id, item, 'video', clip)),
      dbErrorCodes.transitionRefused,
    )
    await fails(
      run("UPDATE custom_orders SET status = 'open', cancelled_at = NULL WHERE id = $1", [
        other.id,
      ]),
      dbErrorCodes.transitionRefused,
    )
  })
})

describe('deliveries and revisions inside their order (schema §9.2, §9.4)', () => {
  it('a revision or a retraction on another order’s delivery fails; a delivery is retracted once', async () => {
    const modelId = await model()
    const { mine, theirs } = await inTx(async (c) => {
      const deliveryOf = async () => {
        const order = await newOrder(c, modelId)
        const item = await newCustom(c, modelId)
        return deliver(
          c,
          modelId,
          order.id,
          item,
          'video',
          await addFiles(c, modelId, item, 'video', 1),
        )
      }
      return { mine: await deliveryOf(), theirs: await deliveryOf() }
    })
    await fails(
      inTx((c) =>
        insert(c, 'custom_order_deliveries', {
          ...retraction(modelId, theirs),
          order_id: mine.order_id,
        }),
      ),
      '23503',
      'custom_order_deliveries_model_id_order_id_retracts_id_fkey',
    )
    await fails(
      inTx((c) =>
        insert(c, 'custom_order_revisions', {
          model_id: modelId,
          order_id: mine.order_id,
          requirement: 'без музыки',
          request_tg_ref: 'tg:-100/3/11',
          requested_at: new Date().toISOString(),
          fixed_delivery_id: theirs.id,
        }),
      ),
      '23503',
      'custom_order_revisions_model_id_order_id_fixed_delivery_id_fkey',
    )
    const retracted = await inTx((c) =>
      insert(c, 'custom_order_deliveries', retraction(modelId, mine)),
    )
    await fails(
      inTx((c) => insert(c, 'custom_order_deliveries', retraction(modelId, mine))),
      '23505',
      'custom_order_deliveries_retracts_once',
    )
    await fails(
      inTx((c) => insert(c, 'custom_order_deliveries', retraction(modelId, retracted))),
      dbErrorCodes.transitionRefused,
    )
  })

  it('only a CUS is delivered; a delivery and a retraction have their own shape', async () => {
    const modelId = await model()
    const { order, set, clip, item } = await inTx(async (c) => {
      const set = await insert(c, 'content_items', {
        model_id: modelId,
        type: 'SET',
        number: nextNumber(),
        origin: 'manual',
      })
      const item = await newCustom(c, modelId)
      return {
        order: await newOrder(c, modelId),
        set,
        item,
        clip: await addFiles(c, modelId, item, 'video', 1),
      }
    })
    await fails(
      inTx((c) => deliver(c, modelId, order.id, set, 'video', clip)),
      '23503',
      'custom_order_deliveries_model_id_item_id_item_type_fkey',
    )
    await fails(
      inTx((c) => deliver(c, modelId, order.id, set, 'video', clip, { item_type: 'SET' })),
      '23514',
      'custom_order_deliveries_item_type_check',
    )
    await fails(
      inTx((c) => deliver(c, modelId, order.id, item, 'video', clip, { basis: null })),
      '23514',
      'custom_order_deliveries_shape',
    )
    const delivery = await inTx((c) => deliver(c, modelId, order.id, item, 'video', clip))
    await fails(
      inTx((c) =>
        insert(c, 'custom_order_deliveries', { ...retraction(modelId, delivery), part: 'video' }),
      ),
      '23514',
      'custom_order_deliveries_shape',
    )
    // Append-only: no UPDATE or DELETE for the app role, nor for the owner role.
    const owner = new pg.Pool({ connectionString: db.url('migrate'), max: 1 })
    try {
      for (const statement of [
        'UPDATE custom_order_deliveries SET evidence_refs = evidence_refs WHERE id = $1',
        'DELETE FROM custom_order_deliveries WHERE id = $1',
      ]) {
        await fails(run(statement, [delivery.id]), '42501')
        await fails(
          inTx((c) => c.query(statement, [delivery.id]), owner),
          dbErrorCodes.immutableRow,
        )
      }
    } finally {
      await owner.end()
    }
  })
})

describe('serialisation on the order row (schema §9.2, §9.4)', () => {
  async function begin(): Promise<pg.PoolClient> {
    const client = await pool.connect()
    await client.query('BEGIN')
    await journalContext(client)
    return client
  }

  /** Ends the transaction and returns the client to the pool. */
  async function end(client: pg.PoolClient, how: 'COMMIT' | 'ROLLBACK') {
    try {
      await client.query(how)
    } finally {
      client.release()
    }
  }

  /** The statement waits for the order row held by the other transaction. */
  async function waitsForOrder(client: pg.PoolClient, statement: () => Promise<unknown>) {
    await client.query('SAVEPOINT probe')
    await client.query("SET LOCAL lock_timeout = '200ms'")
    await expect(statement()).rejects.toMatchObject({ code: '55P03' })
    await client.query('ROLLBACK TO SAVEPOINT probe')
  }

  /**
   * `first` changes the order and holds its transaction; `second` waits for the order row,
   * then sees what `first` committed and is refused.
   */
  async function race(
    first: (c: pg.PoolClient) => Promise<unknown>,
    second: (c: pg.PoolClient) => Promise<unknown>,
  ) {
    const a = await begin()
    const b = await begin()
    let committed = false
    try {
      await first(a)
      await waitsForOrder(b, () => second(b))
      await end(a, 'COMMIT')
      committed = true
      await expect(second(b)).rejects.toMatchObject({ code: dbErrorCodes.transitionRefused })
    } finally {
      // Without this a failed check would leave `a` holding the order row and the pool.
      if (!committed) await end(a, 'ROLLBACK')
      await end(b, 'ROLLBACK')
    }
  }

  function openRevision(modelId: string, orderId: unknown) {
    return (c: pg.PoolClient) =>
      insert(c, 'custom_order_revisions', {
        model_id: modelId,
        order_id: orderId,
        requirement: 'без музыки',
        request_tg_ref: `tg:-100/3/${nextNumber()}`,
        requested_at: new Date().toISOString(),
      })
  }

  it('closing waits for a revision being recorded and is refused after it', async () => {
    const modelId = await model()
    const { order } = await deliveredOrder(modelId)
    await race(openRevision(modelId, order.id), (c) => c.query(CLOSE, [order.id]))
    expect(await orderRow(order.id)).toMatchObject({ status: 'delivered' })
  })

  it('a revision and a delivery wait for closing and are refused after it', async () => {
    const modelId = await model()
    const first = await deliveredOrder(modelId)
    await race((c) => c.query(CLOSE, [first.order.id]), openRevision(modelId, first.order.id))
    const second = await deliveredOrder(modelId)
    const { item, clip } = await inTx(async (c) => {
      const item = await newCustom(c, modelId)
      return { item, clip: await addFiles(c, modelId, item, 'video', 1) }
    })
    await race(
      (c) => c.query(CLOSE, [second.order.id]),
      (c) => deliver(c, modelId, second.order.id, item, 'video', clip),
    )
  })

  it('a part mark waits for a retraction of its delivery and is refused after it', async () => {
    const modelId = await model()
    const delivery = await inTx(async (c) => {
      const order = await newOrder(c, modelId, {
        expects_video: false,
        expects_photos: true,
        photo_count: 2,
      })
      const item = await newCustom(c, modelId)
      return deliver(
        c,
        modelId,
        order.id,
        item,
        'photos',
        await addFiles(c, modelId, item, 'image', 2),
      )
    })
    await race(
      (c) => insert(c, 'custom_order_deliveries', retraction(modelId, delivery)),
      (c) => c.query(MARK_PHOTOS, [delivery.order_id]),
    )
    expect(await orderRow(delivery.order_id)).toMatchObject({ status: 'open' })
  })
})

describe('custom fields of catalog_index (SPEC §12.0)', () => {
  it('a CUS shows its order, the delivery date and the order’s «имя есть» while the delivery is live', async () => {
    const modelId = await model()
    const { item, delivery, order } = await inTx(async (c) => {
      const order = await newOrder(c, modelId, { name_in_media: 'yes' })
      const item = await newCustom(c, modelId, { name_in_media: 'no' })
      const delivery = await deliver(
        c,
        modelId,
        order.id,
        item,
        'video',
        await addFiles(c, modelId, item, 'video', 1),
        { delivered_at: '2026-10-01T10:00:00Z' },
      )
      return { item, delivery, order }
    })
    const indexRow = async () =>
      (
        await pool.query(
          'SELECT order_id, delivered_at, name_in_media FROM catalog_index WHERE item_id = $1',
          [item.id],
        )
      ).rows[0]
    expect(await indexRow()).toEqual({
      order_id: order.id,
      delivered_at: new Date('2026-10-01T10:00:00Z'),
      name_in_media: 'yes',
    })
    await inTx((c) => insert(c, 'custom_order_deliveries', retraction(modelId, delivery)))
    expect(await indexRow()).toEqual({ order_id: null, delivered_at: null, name_in_media: 'no' })
  })
})
