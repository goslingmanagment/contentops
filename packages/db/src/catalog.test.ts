import { randomBytes, randomUUID } from 'node:crypto'
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
import {
  assetRoles,
  type ContentType,
  contentTypes,
  dbErrorCodes,
  idPadding,
  rolesByType,
} from './values.ts'

/**
 * Constraints of the catalog, intake and issue tables (schema §4, §9.2, §9.4), the byte
 * reference contract, `catalog_index` and search — as the app role, on real PostgreSQL.
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

async function model(): Promise<string> {
  return inTx((client) => newModel(client))
}

async function newItem(
  client: pg.ClientBase,
  modelId: string,
  type: ContentType,
  extra: Row = {},
): Promise<Row> {
  const row: Row = { model_id: modelId, type, number: nextNumber(), origin: 'manual', ...extra }
  if (type === 'PPV' && !('ppv_kind' in extra)) row.ppv_kind = 'bundle'
  if (type === 'RAW' && !('raw_purpose' in extra)) row.raw_purpose = 'unknown'
  if (type === 'PRM' && !('promo_channel_id' in extra)) {
    row.promo_channel_id = (await make(client, 'promo_channels', modelId)).id
  }
  return insert(client, 'content_items', row)
}

interface FileSpec {
  role: string
  ordinal?: number
  variantNo?: number
  media?: 'video' | 'image'
  bytes?: number
  durationMs?: number
  width?: number
  height?: number
  position?: number
  sourceRevisionId?: string
  membership?: Row
}

interface AddedFile {
  assetId: string
  versionId: string
  membershipId: string
  sha256: Buffer
}

/** An owned file of the item: blob, asset, its first version and the membership. */
async function addFile(
  client: pg.ClientBase,
  modelId: string,
  item: Row,
  spec: FileSpec,
): Promise<AddedFile> {
  const media = spec.media ?? 'image'
  const sha256 = await newBlob(client, media, spec.bytes ?? 1)
  const assetId = randomUUID()
  const versionId = randomUUID()
  const variantNo = spec.variantNo ?? 0
  await insert(client, 'assets', {
    model_id: modelId,
    id: assetId,
    created_in_item_id: item.id,
    media_kind: media,
    current_version_id: versionId,
    variant_kind: variantNo > 0 ? 'uniq' : 'none',
    variant_no: variantNo,
    uniq_level: variantNo > 0 ? 'soft' : null,
  })
  await insert(client, 'asset_versions', {
    model_id: modelId,
    id: versionId,
    asset_id: assetId,
    version_no: 1,
    master_sha256: sha256,
    duration_ms: spec.durationMs ?? null,
    width: spec.width ?? null,
    height: spec.height ?? null,
    source_revision_id: spec.sourceRevisionId ?? null,
  })
  const membership = await insert(client, 'item_memberships', {
    model_id: modelId,
    item_id: item.id,
    item_type: item.type,
    asset_id: assetId,
    variant_no: variantNo,
    kind: 'owned',
    role: spec.role,
    ordinal: spec.ordinal ?? null,
    display_position: spec.position ?? null,
    ...spec.membership,
  })
  return { assetId, versionId, membershipId: membership.id as string, sha256 }
}

/** A sealed manifest of the given versions. */
async function newManifest(
  client: pg.ClientBase,
  modelId: string,
  item: Row,
  files: AddedFile[],
): Promise<string> {
  const manifest = await insert(client, 'asset_manifests', {
    model_id: modelId,
    purpose: 'download',
    origin_item_id: item.id,
    entry_count: files.length,
  })
  for (const [i, file] of files.entries()) {
    await insert(client, 'asset_manifest_entries', {
      model_id: modelId,
      manifest_id: manifest.id,
      position: i + 1,
      item_id: item.id,
      membership_id: file.membershipId,
      asset_id: file.assetId,
      asset_version_id: file.versionId,
      handle_snapshot: `pos${i + 1}`,
    })
  }
  return manifest.id as string
}

async function newDraft(client: pg.ClientBase, modelId: string, extra: Row = {}): Promise<Row> {
  return insert(client, 'inbox_drafts', {
    model_id: modelId,
    group_id: (await make(client, 'inbox_groups', modelId)).id,
    source_revision_id: (await make(client, 'source_revisions', modelId)).id,
    origin: 'disk_scan',
    ...extra,
  })
}

describe('identity and intake (schema §4)', () => {
  it('a number is never reused, a tombstone keeps it, type and number never change', async () => {
    const modelId = await model()
    const item = await inTx((c) => newItem(c, modelId, 'PPV', { number: 73 }))
    await fails(
      inTx((c) => newItem(c, modelId, 'PPV', { number: 73 })),
      '23505',
      'content_items_number',
    )
    await inTx((c) =>
      c.query('UPDATE content_items SET deleted_at = now() WHERE id = $1', [item.id]),
    )
    await fails(
      inTx((c) => newItem(c, modelId, 'PPV', { number: 73 })),
      '23505',
      'content_items_number',
    )
    // Another type or another model has its own row of numbers.
    await inTx((c) => newItem(c, modelId, 'SET', { number: 73 }))
    const other = await model()
    await inTx((c) => newItem(c, other, 'PPV', { number: 73 }))
    for (const change of ["type = 'SET'", 'number = 74']) {
      await fails(
        inTx((c) => c.query(`UPDATE content_items SET ${change} WHERE id = $1`, [item.id])),
        dbErrorCodes.immutableColumn,
      )
    }
  })

  it('one intake group creates at most one object', async () => {
    const modelId = await model()
    const group = await inTx((c) => make(c, 'inbox_groups', modelId))
    await inTx((c) => newItem(c, modelId, 'SET', { created_from_group_id: group.id }))
    await fails(
      inTx((c) => newItem(c, modelId, 'SET', { created_from_group_id: group.id })),
      '23505',
      'content_items_created_from_group',
    )
  })

  it('one source revision gives one draft', async () => {
    const modelId = await model()
    const revision = await inTx((c) => make(c, 'source_revisions', modelId))
    await inTx((c) => newDraft(c, modelId, { source_revision_id: revision.id }))
    await fails(
      inTx((c) => newDraft(c, modelId, { source_revision_id: revision.id })),
      '23505',
      'inbox_drafts_source_revision',
    )
  })

  it('a draft is accepted only with a verified master', async () => {
    const modelId = await model()
    const { item, draft, sha } = await inTx(async (c) => ({
      item: await newItem(c, modelId, 'SET'),
      draft: await newDraft(c, modelId),
      sha: await newBlob(c),
    }))
    const accept = (extra: string) =>
      inTx((c) =>
        c.query(
          `UPDATE inbox_drafts SET state = 'resolved', outcome = 'new_item', applied_item_id = $2,
                  decided_at = now() ${extra} WHERE id = $1`,
          [draft.id, item.id],
        ),
      )
    await fails(accept(''), '23514', 'inbox_drafts_accept_verified')
    await fails(accept(', master_verified_at = now()'), '23514', 'inbox_drafts_verified_master')
    await inTx((c) =>
      c.query(
        'UPDATE inbox_drafts SET master_sha256 = $2, master_verified_at = now() WHERE id = $1',
        [draft.id, sha],
      ),
    )
    await accept('')
    // A refusal needs no master.
    const refused = await inTx((c) => newDraft(c, modelId))
    await inTx((c) =>
      c.query(
        `UPDATE inbox_drafts SET state = 'resolved', outcome = 'rejected', rejected_at = now()
          WHERE id = $1`,
        [refused.id],
      ),
    )
  })

  it('an unknown value fails its CHECK', async () => {
    const modelId = await model()
    const item = await inTx((c) => newItem(c, modelId, 'SET'))
    const cases: [string, string, unknown[]][] = [
      [
        "INSERT INTO content_items (model_id, type, number, origin) VALUES ($1, 'BUN', 1, 'manual')",
        'content_items_type_check',
        [modelId],
      ],
      [
        `INSERT INTO item_memberships (model_id, item_id, item_type, asset_id, kind, role)
         VALUES ($1, $2, 'SET', $3, 'owned', 'poster')`,
        'item_memberships_role_check',
        [modelId, item.id, randomUUID()],
      ],
      [
        "INSERT INTO sources (model_id, kind, label) VALUES ($1, 'gdrive', 'x')",
        'sources_kind_check',
        [modelId],
      ],
      [
        "UPDATE blobs SET state = 'gone' WHERE sha256 = $1",
        'blobs_state_check',
        [await inTx((c) => newBlob(c))],
      ],
    ]
    for (const [statement, constraint, params] of cases) {
      await fails(
        inTx((c) => c.query(statement, params)),
        '23514',
        constraint,
      )
    }
  })

  it('a cloud source is read-only', async () => {
    const modelId = await model()
    for (const kind of ['yandex_disk', 'dropbox']) {
      await fails(
        inTx((c) =>
          insert(c, 'sources', { model_id: modelId, kind, label: kind, read_only: false }),
        ),
        '23514',
        'sources_cloud_read_only',
      )
    }
    await inTx((c) =>
      insert(c, 'sources', {
        model_id: modelId,
        kind: 'web_upload',
        label: 'web',
        read_only: false,
      }),
    )
  })
})

describe('files, handles and owners (schema §9.2, naming §3)', () => {
  it('a handle is never reused, also next to live master + u1 + u2', async () => {
    const modelId = await model()
    const fyp = await inTx((c) => newItem(c, modelId, 'FYP'))
    await inTx(async (c) => {
      await addFile(c, modelId, fyp, { role: 'master', media: 'video' })
      await addFile(c, modelId, fyp, { role: 'master', media: 'video', variantNo: 1 })
      await addFile(c, modelId, fyp, { role: 'master', media: 'video', variantNo: 2 })
    })
    for (const variantNo of [0, 1, 2]) {
      await fails(
        inTx((c) => addFile(c, modelId, fyp, { role: 'master', media: 'video', variantNo })),
        '23505',
        variantNo === 0 ? 'item_memberships_handle' : 'assets_uniq_variant',
      )
    }
    await inTx((c) => addFile(c, modelId, fyp, { role: 'master', media: 'video', variantNo: 3 }))
    // The membership key itself: a free `u1` file of another FYP moved here.
    const loose = await inTx(async (c) => {
      const other = await newItem(c, modelId, 'FYP')
      const file = await addFile(c, modelId, other, {
        role: 'master',
        media: 'video',
        variantNo: 1,
      })
      await c.query('UPDATE item_memberships SET removed_at = now() WHERE id = $1', [
        file.membershipId,
      ])
      return file
    })
    await fails(
      inTx((c) =>
        insert(c, 'item_memberships', {
          model_id: modelId,
          item_id: fyp.id,
          item_type: 'FYP',
          asset_id: loose.assetId,
          variant_no: 1,
          kind: 'owned',
          role: 'master',
        }),
      ),
      '23505',
      'item_memberships_handle',
    )

    // A removed sub-handle stays taken: `SET-069/ed07` never goes to another file.
    const set = await inTx((c) => newItem(c, modelId, 'SET'))
    const ed07 = await inTx((c) => addFile(c, modelId, set, { role: 'ed', ordinal: 7 }))
    await inTx((c) =>
      c.query('UPDATE item_memberships SET removed_at = now() WHERE id = $1', [ed07.membershipId]),
    )
    await fails(
      inTx((c) => addFile(c, modelId, set, { role: 'ed', ordinal: 7 })),
      '23505',
      'item_memberships_handle',
    )
  })

  it('a unique version `uN` lives only on the master of a FYP', async () => {
    const modelId = await model()
    const ppv = await inTx((c) => newItem(c, modelId, 'PPV'))
    await fails(
      inTx((c) => addFile(c, modelId, ppv, { role: 'master', media: 'video', variantNo: 1 })),
      '23514',
      'item_memberships_variant',
    )
    await fails(
      inTx((c) =>
        insert(c, 'assets', {
          model_id: modelId,
          created_in_item_id: ppv.id,
          media_kind: 'video',
          current_version_id: randomUUID(),
          variant_kind: 'uniq',
          variant_no: 0,
          uniq_level: 'soft',
        }),
      ),
      '23514',
      'assets_variant_no',
    )
  })

  it('a file has one owner; a PRM collection holds references', async () => {
    const modelId = await model()
    const { raw, file } = await inTx(async (c) => {
      const set = await newItem(c, modelId, 'SET')
      return {
        raw: await newItem(c, modelId, 'RAW'),
        file: await addFile(c, modelId, set, { role: 'raw', ordinal: 1 }),
      }
    })
    const own = (item: Row) =>
      inTx((c) =>
        insert(c, 'item_memberships', {
          model_id: modelId,
          item_id: item.id,
          item_type: item.type,
          asset_id: file.assetId,
          kind: 'owned',
          role: 'raw',
          ordinal: 1,
        }),
      )
    await fails(own(raw), '23505', 'item_memberships_one_owner')
    const prm = await inTx((c) => newItem(c, modelId, 'PRM'))
    await inTx((c) =>
      insert(c, 'item_memberships', {
        model_id: modelId,
        item_id: prm.id,
        item_type: 'PRM',
        asset_id: file.assetId,
        kind: 'reference',
        role: 'raw',
        ordinal: 1,
      }),
    )
    // A reference outside PRM is refused; after the owner removes the file it can move.
    await fails(
      inTx((c) =>
        insert(c, 'item_memberships', {
          model_id: modelId,
          item_id: raw.id,
          item_type: 'RAW',
          asset_id: file.assetId,
          kind: 'reference',
          role: 'raw',
          ordinal: 2,
        }),
      ),
      '23514',
      'item_memberships_reference_in_prm',
    )
    await inTx((c) =>
      c.query('UPDATE item_memberships SET removed_at = now() WHERE id = $1', [file.membershipId]),
    )
    await own(raw)
  })

  it('a role fits its type exactly as values.rolesByType says', async () => {
    const { rows } = await pool.query<{ type: string; role: string; fits: boolean }>(
      `SELECT t AS type, r AS role, role_fits_type(t, r) AS fits
         FROM unnest($1::text[]) AS t, unnest($2::text[]) AS r`,
      [contentTypes, assetRoles],
    )
    for (const row of rows) {
      const allowed = (rolesByType[row.type as ContentType] as readonly string[]).includes(row.role)
      expect(row.fits, `${row.type} ${row.role}`).toBe(allowed)
    }
    const modelId = await model()
    const set = await inTx((c) => newItem(c, modelId, 'SET'))
    await fails(
      inTx((c) => addFile(c, modelId, set, { role: 'master', media: 'video' })),
      '23514',
      'item_memberships_role_fits_type',
    )
  })

  it('public_item_id pads numbers as values.idPadding says', async () => {
    for (const type of contentTypes) {
      for (const n of [1, 73, 1000, 123456]) {
        const { rows } = await pool.query('SELECT public_item_id($1, $2) AS id', [type, n])
        const digits = String(n)
        expect(rows[0].id).toBe(`${type}-${digits.padStart(idPadding[type], '0')}`)
      }
    }
  })
})

describe('ownership inside a model (schema §9.4)', () => {
  it('a version of another file, a cover of another object, a current version of another file', async () => {
    const modelId = await model()
    const { set, a, b } = await inTx(async (c) => {
      const set = await newItem(c, modelId, 'SET')
      return {
        set,
        a: await addFile(c, modelId, set, { role: 'raw', ordinal: 1 }),
        b: await addFile(c, modelId, set, { role: 'raw', ordinal: 2 }),
      }
    })
    const prm = await inTx((c) => newItem(c, modelId, 'PRM'))
    await fails(
      inTx((c) =>
        insert(c, 'item_memberships', {
          model_id: modelId,
          item_id: prm.id,
          item_type: 'PRM',
          asset_id: a.assetId,
          kind: 'reference',
          role: 'raw',
          ordinal: 1,
          pinned_version_id: b.versionId,
        }),
      ),
      '23503',
      'item_memberships_model_id_asset_id_pinned_version_id_fkey',
    )
    await fails(
      inTx(async (c) => {
        const manifest = await insert(c, 'asset_manifests', {
          model_id: modelId,
          purpose: 'plan',
          entry_count: 1,
        })
        await insert(c, 'asset_manifest_entries', {
          model_id: modelId,
          manifest_id: manifest.id,
          position: 1,
          item_id: set.id,
          asset_id: a.assetId,
          asset_version_id: b.versionId,
          handle_snapshot: 'SET/raw01',
        })
      }),
      '23503',
      'asset_manifest_entries_model_id_asset_id_asset_version_id_fkey',
    )
    const other = await inTx((c) => newItem(c, modelId, 'SET'))
    await fails(
      inTx((c) =>
        c.query('UPDATE content_items SET cover_membership_id = $2 WHERE id = $1', [
          other.id,
          a.membershipId,
        ]),
      ),
      '23503',
      'content_items_cover_fkey',
    )
    await inTx((c) =>
      c.query('UPDATE content_items SET cover_membership_id = $2 WHERE id = $1', [
        set.id,
        a.membershipId,
      ]),
    )
    await fails(
      inTx((c) =>
        c.query('UPDATE assets SET current_version_id = $2 WHERE id = $1', [
          a.assetId,
          b.versionId,
        ]),
      ),
      '23503',
      'assets_current_version_fkey',
    )
  })

  it('a shared tag works, a private tag of another model does not', async () => {
    const [modelA, modelB] = [await model(), await model()]
    const item = await inTx((c) => newItem(c, modelA, 'SET'))
    const tags = await inTx(async (c) => ({
      shared: await insert(c, 'tags', { slug: `yoga-${randomUUID()}`, label_ru: 'йога' }),
      own: await insert(c, 'tags', { model_id: modelA, slug: 'mirror', label_ru: 'зеркало' }),
      foreign: await insert(c, 'tags', { model_id: modelB, slug: 'mirror', label_ru: 'зеркало' }),
    }))
    const link = (tag: Row) =>
      inTx((c) =>
        insert(c, 'item_tags', {
          model_id: modelA,
          item_id: item.id,
          tag_id: tag.id,
          source: 'human',
        }),
      )
    await link(tags.shared)
    await link(tags.own)
    await fails(link(tags.foreign), dbErrorCodes.foreignTag)
    await fails(
      inTx((c) => c.query('UPDATE tags SET model_id = NULL WHERE id = $1', [tags.own.id])),
      dbErrorCodes.immutableColumn,
    )
  })

  it('a work without a model carries no model target', async () => {
    const modelId = await model()
    const draft = await inTx((c) => newDraft(c, modelId))
    await fails(
      inTx((c) =>
        insert(c, 'work_operations', {
          kind: 'verify_blobs',
          work_key: `verify:${randomUUID()}`,
          draft_id: draft.id,
        }),
      ),
      '23514',
      'work_operations_model_targets',
    )
  })
})

describe('sealed compositions and immutable tables (schema §9.2, §9.4)', () => {
  it('a manifest and a receipt hold exactly entry_count rows at positions 1..N', async () => {
    const modelId = await model()
    const { item, files } = await inTx(async (c) => {
      const item = await newItem(c, modelId, 'SET')
      return {
        item,
        files: [
          await addFile(c, modelId, item, { role: 'raw', ordinal: 1 }),
          await addFile(c, modelId, item, { role: 'raw', ordinal: 2 }),
        ],
      }
    })
    const [first, second] = files as [AddedFile, AddedFile]
    // Too few rows, a gap in positions, a late row: each fails its transaction.
    await fails(
      inTx(async (c) => {
        const manifest = await newManifest(c, modelId, item, [first])
        // A header sealed with two rows that gets one.
        await c.query('SELECT $1::uuid', [manifest])
        const short = await insert(c, 'asset_manifests', {
          model_id: modelId,
          purpose: 'plan',
          entry_count: 2,
        })
        await insert(c, 'asset_manifest_entries', {
          model_id: modelId,
          manifest_id: short.id,
          position: 1,
          item_id: item.id,
          asset_id: first.assetId,
          asset_version_id: first.versionId,
          handle_snapshot: 'x',
        })
      }),
      dbErrorCodes.sealedCountMismatch,
    )
    await fails(
      inTx(async (c) => {
        const manifest = await insert(c, 'asset_manifests', {
          model_id: modelId,
          purpose: 'plan',
          entry_count: 2,
        })
        for (const [position, file] of [
          [1, first],
          [3, second],
        ] as const) {
          await insert(c, 'asset_manifest_entries', {
            model_id: modelId,
            manifest_id: manifest.id,
            position,
            item_id: item.id,
            asset_id: file.assetId,
            asset_version_id: file.versionId,
            handle_snapshot: 'x',
          })
        }
      }),
      dbErrorCodes.sealedCountMismatch,
    )
    const manifestId = await inTx((c) => newManifest(c, modelId, item, [first]))
    await fails(
      inTx((c) =>
        insert(c, 'asset_manifest_entries', {
          model_id: modelId,
          manifest_id: manifestId,
          position: 2,
          item_id: item.id,
          asset_id: second.assetId,
          asset_version_id: second.versionId,
          handle_snapshot: 'late',
        }),
      ),
      dbErrorCodes.sealedCountMismatch,
    )

    const principal = await inTx((c) => newPrincipal(c))
    const receipt = (count: number, rows: AddedFile[]) =>
      inTx(async (c) => {
        const head = await insert(c, 'download_receipts', {
          model_id: modelId,
          principal_id: principal,
          kind: 'master',
          manifest_id: manifestId,
          meta_stripped: true,
          entry_count: count,
        })
        for (const [i, file] of rows.entries()) {
          await insert(c, 'download_receipt_entries', {
            model_id: modelId,
            receipt_id: head.id,
            position: i + 1,
            asset_id: file.assetId,
            asset_version_id: file.versionId,
            issued_master: true,
            file_name: `SET-001_raw0${i + 1}.jpg`,
            output_sha256: file.sha256,
            byte_size: 1,
          })
        }
        return head.id as string
      })
    await fails(receipt(2, [first]), dbErrorCodes.sealedCountMismatch)
    const receiptId = await receipt(1, [first])
    await fails(
      inTx((c) =>
        insert(c, 'download_receipt_entries', {
          model_id: modelId,
          receipt_id: receiptId,
          position: 2,
          asset_id: second.assetId,
          asset_version_id: second.versionId,
          issued_master: true,
          file_name: 'late.jpg',
          output_sha256: second.sha256,
          byte_size: 1,
        }),
      ),
      dbErrorCodes.sealedCountMismatch,
    )
    // A row names exactly one issued file: an artifact, the master as is or an export.
    await fails(
      inTx(async (c) => {
        const head = await insert(c, 'download_receipts', {
          model_id: modelId,
          principal_id: principal,
          kind: 'edit',
          manifest_id: manifestId,
          meta_stripped: true,
          entry_count: 1,
        })
        await insert(c, 'download_receipt_entries', {
          model_id: modelId,
          receipt_id: head.id,
          position: 1,
          asset_id: first.assetId,
          asset_version_id: first.versionId,
          issued_master: true,
          export_key: `exports/${randomUUID()}/x.mp4`,
          file_name: 'x.mp4',
          output_sha256: first.sha256,
          byte_size: 1,
        })
      }),
      '23514',
      'download_receipt_entries_one_file',
    )
  })

  it('no UPDATE or DELETE on any append-only table, for the app and the owner role', async () => {
    const modelId = await model()
    await inTx(async (c) => {
      const item = await newItem(c, modelId, 'SET')
      const file = await addFile(c, modelId, item, { role: 'raw', ordinal: 1 })
      const manifest = await newManifest(c, modelId, item, [file])
      const receipt = await insert(c, 'download_receipts', {
        model_id: modelId,
        principal_id: await newPrincipal(c),
        kind: 'master',
        manifest_id: manifest,
        meta_stripped: false,
        entry_count: 1,
      })
      await insert(c, 'download_receipt_entries', {
        model_id: modelId,
        receipt_id: receipt.id,
        position: 1,
        asset_id: file.assetId,
        asset_version_id: file.versionId,
        issued_master: true,
        file_name: 'SET-001_raw01.jpg',
        output_sha256: file.sha256,
        byte_size: 1,
      })
    })
    const owner = new pg.Pool({ connectionString: db.url('migrate'), max: 1 })
    try {
      for (const table of [
        'asset_versions',
        'asset_manifests',
        'asset_manifest_entries',
        'download_receipts',
        'download_receipt_entries',
      ]) {
        for (const statement of [
          `UPDATE ${table} SET model_id = model_id WHERE model_id = $1`,
          `DELETE FROM ${table} WHERE model_id = $1`,
        ]) {
          await fails(
            inTx((c) => c.query(statement, [modelId])),
            '42501',
          )
          await fails(
            inTx((c) => c.query(statement, [modelId]), owner),
            dbErrorCodes.immutableRow,
          )
        }
      }
    } finally {
      await owner.end()
    }
  })

  it('a source revision keeps what was observed; the check is written once', async () => {
    const modelId = await model()
    const revision = await inTx((c) => make(c, 'source_revisions', modelId))
    const sha = randomBytes(32)
    await inTx((c) =>
      c.query(
        `UPDATE source_revisions SET source_sha256 = $2, verified_at = now(),
                verified_route = 'download' WHERE id = $1`,
        [revision.id, sha],
      ),
    )
    // Repeating the same value is no change.
    await inTx((c) =>
      c.query('UPDATE source_revisions SET source_sha256 = $2 WHERE id = $1', [revision.id, sha]),
    )
    for (const change of [
      `source_sha256 = '\\x${randomBytes(32).toString('hex')}'`,
      "verified_route = 'local_copy'",
      'byte_size = 2',
      `md5 = '\\x${randomBytes(16).toString('hex')}'`,
    ]) {
      await fails(
        inTx((c) => c.query(`UPDATE source_revisions SET ${change} WHERE id = $1`, [revision.id])),
        dbErrorCodes.immutableColumn,
      )
    }
    // The hash, the check and the route come together.
    const other = await inTx((c) => make(c, 'source_revisions', modelId))
    await fails(
      inTx((c) =>
        c.query('UPDATE source_revisions SET source_sha256 = $2 WHERE id = $1', [other.id, sha]),
      ),
      '23514',
      'source_revisions_verified',
    )
  })

  it('a storage operation is cancelled only before it starts', async () => {
    const sha = randomBytes(32)
    const { rows } = await pool.query(
      "INSERT INTO storage_operations (kind, blob_sha256) VALUES ('purge', $1) RETURNING id",
      [sha],
    )
    await fails(
      pool.query("INSERT INTO storage_operations (kind, blob_sha256) VALUES ('purge', $1)", [sha]),
      '23505',
      'storage_operations_active',
    )
    await pool.query(
      "UPDATE storage_operations SET state = 'started', started_at = now() WHERE id = $1",
      [rows[0].id],
    )
    await fails(
      pool.query(
        "UPDATE storage_operations SET state = 'cancelled', finished_at = now() WHERE id = $1",
        [rows[0].id],
      ),
      dbErrorCodes.transitionRefused,
    )
  })
})

describe('the byte reference contract (schema §1 p. 6, §5)', () => {
  type Holder = (
    c: pg.ClientBase,
    modelId: string,
    sha: Buffer,
  ) => Promise<((c: pg.ClientBase) => Promise<unknown>) | null>

  /** Every FK on `blobs (sha256)`: how a row holds the blob and how it lets go (null: never). */
  const HOLDERS: Record<string, Holder> = {
    'asset_versions.master_sha256': async (c, modelId, sha) => {
      const item = await newItem(c, modelId, 'SET')
      const assetId = randomUUID()
      const versionId = randomUUID()
      await insert(c, 'assets', {
        model_id: modelId,
        id: assetId,
        created_in_item_id: item.id,
        media_kind: 'image',
        current_version_id: versionId,
      })
      await insert(c, 'asset_versions', {
        model_id: modelId,
        id: versionId,
        asset_id: assetId,
        version_no: 1,
        master_sha256: sha,
      })
      return null
    },
    'inbox_drafts.master_sha256': async (c, modelId, sha) => {
      const draft = await newDraft(c, modelId, { master_sha256: sha })
      return (c2) => reject(c2, draft.id as string)
    },
    'inbox_drafts.source_blob_sha256': async (c, modelId, sha) => {
      const draft = await newDraft(c, modelId, { source_blob_sha256: sha })
      return (c2) => reject(c2, draft.id as string)
    },
    'web_uploads.sha256': async (c, modelId, sha) => {
      const upload = await make(c, 'web_uploads', modelId)
      await c.query("UPDATE web_uploads SET sha256 = $2, state = 'verified' WHERE id = $1", [
        upload.id,
        sha,
      ])
      return (c2) =>
        c2.query("UPDATE web_uploads SET state = 'registered' WHERE id = $1", [upload.id])
    },
    'work_operations.output_sha256': async (c, modelId, sha) => {
      const work = await make(c, 'work_operations', modelId)
      await c.query('UPDATE work_operations SET output_sha256 = $2 WHERE id = $1', [work.id, sha])
      return (c2) =>
        c2.query("UPDATE work_operations SET state = 'failed', finished_at = now() WHERE id = $1", [
          work.id,
        ])
    },
  }

  function reject(c: pg.ClientBase, draftId: string) {
    return c.query(
      `UPDATE inbox_drafts SET state = 'resolved', outcome = 'rejected', rejected_at = now()
        WHERE id = $1`,
      [draftId],
    )
  }

  async function referenced(sha: Buffer): Promise<boolean> {
    const { rows } = await pool.query('SELECT blob_is_referenced($1) AS held', [sha])
    return rows[0].held
  }

  it('counts every FK on blobs (sha256) and nothing else', async () => {
    const { rows } = await pool.query<{ ref: string }>(`
      SELECT src.relname || '.' || a.attname AS ref
        FROM pg_constraint con
        JOIN pg_class src ON src.oid = con.conrelid
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND con.confrelid = 'blobs'::regclass`)
    expect(rows.map((row) => row.ref).sort()).toEqual(Object.keys(HOLDERS).sort())

    const modelId = await model()
    for (const [ref, hold] of Object.entries(HOLDERS)) {
      const sha = await inTx((c) => newBlob(c))
      expect(await referenced(sha), `${ref}: a fresh blob`).toBe(false)
      const release = await inTx((c) => hold(c, modelId, sha))
      expect(await referenced(sha), `${ref} holds the blob`).toBe(true)
      if (release) {
        await inTx((c) => release(c))
        expect(await referenced(sha), `${ref} let the blob go`).toBe(false)
      }
    }
  })

  it('derivatives are not references', async () => {
    const sha = await inTx((c) => newBlob(c, 'video'))
    await pool.query(
      `INSERT INTO rendition_generations (master_sha256, kind, recipe_digest, input_kind,
         input_sha256, state, ready_at, is_active)
       VALUES ($1, 'thumb640', 'r1', 'master', $1, 'ready', now(), true)`,
      [sha],
    )
    expect(await referenced(sha)).toBe(false)
  })

  it('a rejected draft reopens while its bytes are present, never after the purge', async () => {
    const modelId = await model()
    const reopen = (id: unknown) =>
      inTx((c) =>
        c.query(
          `UPDATE inbox_drafts SET state = 'ready', outcome = NULL, reopened_at = now(),
                  reopen_count = reopen_count + 1 WHERE id = $1`,
          [id],
        ),
      )
    const present = await inTx(async (c) =>
      newDraft(c, modelId, { master_sha256: await newBlob(c) }),
    )
    await inTx((c) => reject(c, present.id as string))
    await reopen(present.id)
    expect(await referenced(Buffer.from(String(present.master_sha256).slice(2), 'hex'))).toBe(true)

    const purgedSha = await inTx((c) => newBlob(c))
    const purged = await inTx((c) => newDraft(c, modelId, { source_blob_sha256: purgedSha }))
    await inTx((c) => reject(c, purged.id as string))
    await inTx((c) =>
      c.query("UPDATE blobs SET state = 'purged', purged_at = now() WHERE sha256 = $1", [
        purgedSha,
      ]),
    )
    await fails(reopen(purged.id), dbErrorCodes.transitionRefused)

    // Accepted, appended and alias drafts never reopen.
    const item = await inTx((c) => newItem(c, modelId, 'SET'))
    const accepted = await inTx(async (c) =>
      newDraft(c, modelId, {
        master_sha256: await newBlob(c),
        master_verified_at: new Date().toISOString(),
        state: 'resolved',
        outcome: 'new_item',
        applied_item_id: item.id,
      }),
    )
    await fails(reopen(accepted.id), dbErrorCodes.transitionRefused)
  })
})

describe('catalog_index and search (SPEC §11.2, §12.0)', () => {
  it('returns the expected row for a fixture object', async () => {
    const modelId = await model()
    const slug = `yoga-${randomUUID().slice(0, 8)}`
    const fixture = await inTx(async (c) => {
      const revision = await insert(c, 'source_revisions', {
        ...(await factory('source_revisions')(c, modelId)),
        remote_created_at: '2026-08-07T10:00:00Z',
      })
      const ppv = await newItem(c, modelId, 'PPV', {
        number: 73,
        title: 'Йога в красном платье',
        title_en: 'yoga red dress',
        shot_on: '2026-08-06',
        has_second_person: false,
      })
      const master = await addFile(c, modelId, ppv, {
        role: 'master',
        media: 'video',
        bytes: 1000,
        durationMs: 600_000,
        width: 1080,
        height: 1920,
        position: 1,
        sourceRevisionId: revision.id as string,
      })
      await addFile(c, modelId, ppv, {
        role: 'teaser',
        media: 'video',
        bytes: 100,
        durationMs: 15_000,
        position: 2,
      })
      await addFile(c, modelId, ppv, { role: 'pic', ordinal: 1, bytes: 10, position: 3 })
      await addFile(c, modelId, ppv, { role: 'pic', ordinal: 2, bytes: 10, position: 4 })
      await c.query('UPDATE content_items SET cover_membership_id = $2 WHERE id = $1', [
        ppv.id,
        master.membershipId,
      ])
      const generation = await insert(c, 'rendition_generations', {
        master_sha256: master.sha256,
        kind: 'thumb640',
        recipe_digest: 'thumb640-r1',
        input_kind: 'master',
        input_sha256: master.sha256,
        state: 'ready',
        ready_at: new Date().toISOString(),
        is_active: true,
      })
      const shared = await insert(c, 'tags', { slug, label_ru: 'йога' })
      const own = await insert(c, 'tags', {
        model_id: modelId,
        slug: 'red-dress',
        label_ru: 'красное',
      })
      for (const tag of [shared, own]) {
        await insert(c, 'item_tags', {
          model_id: modelId,
          item_id: ppv.id,
          tag_id: tag.id,
          source: 'human',
        })
      }
      await insert(c, 'annotation_fields', {
        model_id: modelId,
        item_id: ppv.id,
        field: 'title',
        value_version: 1,
        confirmed_value_version: 1,
        confirmed_at: new Date().toISOString(),
      })
      await insert(c, 'annotation_fields', {
        model_id: modelId,
        item_id: ppv.id,
        field: 'description',
        value_version: 1,
      })
      for (const [kind, value] of [
        ['legacy_id', 'PPV-032'],
        ['legacy_name', '13:03 Ник Фана.mov'],
      ]) {
        await insert(c, 'aliases', { model_id: modelId, kind, value_raw: value, item_id: ppv.id })
      }
      const cus = await newItem(c, modelId, 'CUS', { number: 181, name_in_media: 'no' })
      await addFile(c, modelId, cus, { role: 'master', media: 'video', durationMs: 60_000 })
      await insert(c, 'provenance', {
        model_id: modelId,
        relation: 'ppv_from_custom',
        child_item_id: ppv.id,
        parent_item_id: cus.id,
      })
      const photoCustom = await newItem(c, modelId, 'CUS', { number: 182 })
      await addFile(c, modelId, photoCustom, { role: 'pic', ordinal: 1 })
      const set = await newItem(c, modelId, 'SET', { number: 69 })
      await addFile(c, modelId, set, { role: 'raw', ordinal: 1, membership: { selected: true } })
      await addFile(c, modelId, set, { role: 'raw', ordinal: 2 })
      await addFile(c, modelId, set, { role: 'ed', ordinal: 1 })
      const gone = await newItem(c, modelId, 'SET', { number: 70 })
      await c.query('UPDATE content_items SET deleted_at = now() WHERE id = $1', [gone.id])
      return { ppv, master, generation }
    })

    const { rows } = await pool.query(
      'SELECT * FROM catalog_index WHERE model_id = $1 ORDER BY public_id',
      [modelId],
    )
    expect(rows.map((row) => row.public_id)).toEqual(['CUS-181', 'CUS-182', 'PPV-073', 'SET-069'])
    const ppv = rows.find((row) => row.public_id === 'PPV-073')
    expect(ppv).toMatchObject({
      item_id: fixture.ppv.id,
      type: 'PPV',
      number: 73,
      title: 'Йога в красном платье',
      title_en: 'yoga red dress',
      tags: ['red-dress', slug].sort(),
      markup_state: 'partial',
      cover_version_id: fixture.master.versionId,
      cover_width: 1080,
      cover_height: 1920,
      cover_thumb320_generation_id: null,
      cover_thumb640_generation_id: fixture.generation.id,
      duration_ms: '600000',
      photo_count: 2,
      video_count: 2,
      version_count: 1,
      has_teaser: true,
      size_bytes: '1120',
      arrived_at: new Date('2026-08-07T10:00:00Z'),
      ppv_kind: 'bundle',
      raw_purpose: null,
      ppv_made_as: null,
      has_second_person: false,
      selected_count: null,
      photo_custom: false,
      aliases: ['PPV-032'],
      promo_channel_code: null,
    })
    const byId = Object.fromEntries(rows.map((row) => [row.public_id, row]))
    expect(byId['CUS-181']).toMatchObject({
      ppv_made_as: 'PPV-073',
      name_in_media: 'no',
      photo_custom: false,
      markup_state: 'draft',
      has_second_person: null,
    })
    expect(byId['CUS-182']).toMatchObject({ photo_custom: true, ppv_made_as: null })
    expect(byId['SET-069']).toMatchObject({ selected_count: 1, processed_count: 1, photo_count: 3 })
  })

  it('full text finds Russian and English titles, an alias and chronology inside the model', async () => {
    const [modelA, modelB] = [await model(), await model()]
    const ids = await inTx(async (c) => {
      const ppv = await newItem(c, modelA, 'PPV', {
        title: 'Йога в красном платье',
        title_en: 'yoga red dress',
      })
      const cus = await newItem(c, modelA, 'CUS', { title: 'нейлон и каблуки' })
      // An NFD «й» in the old name: aliases compare in NFC and without case.
      await insert(c, 'aliases', {
        model_id: modelA,
        kind: 'legacy_name',
        value_raw: '13:03 Ник Фана Йога.mov'.normalize('NFD'),
        item_id: cus.id,
      })
      const set = await newItem(c, modelA, 'SET', { title: 'Отель' })
      const file = await addFile(c, modelA, set, { role: 'ed', ordinal: 1 })
      await insert(c, 'chronology_entries', {
        model_id: modelA,
        item_id: set.id,
        asset_version_id: file.versionId,
        at_ms: 125_000,
        text: 'смотрит в зеркало',
        source: 'human',
      })
      await newItem(c, modelB, 'PPV', {
        title: 'Йога в красном платье',
        title_en: 'yoga red dress',
      })
      const gone = await newItem(c, modelA, 'SET', { title: 'Йога на пляже' })
      await c.query('UPDATE content_items SET deleted_at = now() WHERE id = $1', [gone.id])
      return { ppv: ppv.id, cus: cus.id, set: set.id }
    })
    const search = async (q: string) =>
      (
        await pool.query<{ item_id: string }>('SELECT item_id FROM catalog_search($1, $2)', [
          modelA,
          q,
        ])
      ).rows.map((row) => row.item_id)

    expect(await search('йоги')).toEqual([ids.ppv])
    expect(await search('dresses')).toEqual([ids.ppv])
    expect(await search('красное платье')).toEqual([ids.ppv])
    expect(await search('ник фана йога')).toEqual([ids.cus])
    expect(await search('13:03')).toEqual([ids.cus])
    expect(await search('зеркала')).toEqual([ids.set])
    expect(await search('каблук')).toEqual([ids.cus])
    expect(await search('пляж')).toEqual([])
    expect(await search('100%_')).toEqual([])
  })
})
