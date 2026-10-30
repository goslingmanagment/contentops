import { randomBytes, randomUUID } from 'node:crypto'
import type pg from 'pg'

/**
 * Valid rows of every model table for the structural tests: a factory returns the column
 * values of one row in a model and inserts what the row depends on. `testing` names the FK
 * columns a test is about to override; the factory then fills them with valid targets of
 * the same model, so the row passes every CHECK and only the overridden FK can fail.
 */

export type Row = Record<string, unknown>
export type Factory = (
  client: pg.ClientBase,
  modelId: string,
  testing?: readonly string[],
  /** The table that will point at this row: a target of a type copy gets the right type. */
  forTable?: string,
) => Promise<Row>

let sequence = 0
/** A number unique within the test run: object numbers, ordinals. */
export function nextNumber(): number {
  sequence += 1
  return sequence
}

function tag(): string {
  return randomUUID().slice(0, 8)
}

/** Inserts a row and returns it as stored (`to_jsonb`: bytea comes back as `\x…`). */
export async function insert(client: pg.ClientBase, table: string, row: Row): Promise<Row> {
  const columns = Object.keys(row)
  const values = columns.map((column) => {
    const value = row[column]
    if (value === null || Buffer.isBuffer(value) || value instanceof Date) return value
    return typeof value === 'object' ? JSON.stringify(value) : value
  })
  const { rows } = await client.query(
    `INSERT INTO ${table} (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING to_jsonb(${table}.*) AS row`,
    values,
  )
  return rows[0].row
}

/** A factory row of `table` in the model, inserted. */
export async function make(
  client: pg.ClientBase,
  table: string,
  modelId: string,
  testing?: readonly string[],
): Promise<Row> {
  return insert(client, table, await factory(table)(client, modelId, testing))
}

export function factory(table: string): Factory {
  const build = FACTORIES[table]
  if (!build) throw new Error(`add a row factory for ${table}`)
  return build
}

/** The journal context of the system actor; without it every journaled write fails. */
export async function journalContext(client: pg.ClientBase, action = 'test'): Promise<void> {
  await client.query(
    `SELECT set_config('app.actor_type', 'system', true),
       set_config('app.actor_label', 'test', true), set_config('app.action', $1, true),
       set_config('app.request_id', $2, true)`,
    [action, randomUUID()],
  )
}

export async function newModel(client: pg.ClientBase): Promise<string> {
  const code = `m${randomUUID().slice(0, 8)}`
  const { rows } = await client.query(
    'INSERT INTO models (code, title, title_genitive) VALUES ($1, $1, $1) RETURNING id',
    [code],
  )
  return rows[0].id
}

export async function newPrincipal(client: pg.ClientBase): Promise<string> {
  const row = await insert(client, 'principals', {
    kind: 'agent',
    login: `agent-${tag()}`,
    display_name: 'агент',
    role: 'manager',
  })
  return row.id as string
}

/** A present blob with random bytes; returns its SHA-256. */
export async function newBlob(
  client: pg.ClientBase,
  mediaKind: 'video' | 'image' = 'image',
  byteSize = 1,
): Promise<Buffer> {
  const sha256 = randomBytes(32)
  const hex = sha256.toString('hex')
  await insert(client, 'blobs', {
    sha256,
    byte_size: byteSize,
    mime: mediaKind === 'video' ? 'video/mp4' : 'image/jpeg',
    ext: mediaKind === 'video' ? 'mp4' : 'jpg',
    media_kind: mediaKind,
    storage_key: `blobs/sha256/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`,
  })
  return sha256
}

/** A PPV bundle row of `content_items` (not inserted). */
function newPpv(modelId: string): Row {
  return {
    model_id: modelId,
    type: 'PPV',
    ppv_kind: 'bundle',
    number: nextNumber(),
    origin: 'manual',
    has_second_person: false,
  }
}

async function idOf(
  client: pg.ClientBase,
  table: string,
  modelId: string,
  testing?: readonly string[],
): Promise<string> {
  return (await make(client, table, modelId, testing)).id as string
}

export const FACTORIES: Record<string, Factory> = {
  accounts: async (_client, modelId) => {
    const code = `acc-${tag()}`
    return { model_id: modelId, code, platform: 'fansly', title: code, handle: code, position: 1 }
  },
  work_operations: async (_client, modelId) => ({
    model_id: modelId,
    kind: 'scan',
    work_key: `scan:${randomUUID()}`,
  }),
  surfaces: async (client, modelId) => ({
    model_id: modelId,
    account_id: await idOf(client, 'accounts', modelId),
    kind: 'wall',
  }),
  id_counters: async (client, modelId) => ({
    model_id: modelId,
    type: 'PPV',
    next_number: 1,
    legacy_reserved_work_id: await idOf(client, 'work_operations', modelId),
  }),
  policy_settings: async (client, modelId) => ({
    model_id: modelId,
    account_id: await idOf(client, 'accounts', modelId),
    key: 'hub.receive',
    value: true,
  }),
  promo_channels: async (_client, modelId) => ({
    model_id: modelId,
    code: `ch-${tag()}`,
    title: 'Канал',
  }),

  // 0002_bytes_sources
  sources: async (_client, modelId) => ({
    model_id: modelId,
    kind: 'dropbox',
    label: `Dropbox ${tag()}`,
    root_path: '',
    credentials_ref: 'DROPBOX_REFRESH_TOKEN',
  }),
  source_objects: async (client, modelId, testing = []) => {
    const row: Row = {
      model_id: modelId,
      source_id: await idOf(client, 'sources', modelId),
      resource_id: `id:${tag()}`,
      current_path: `/Lora/${tag()}.mov`,
      current_name: 'x.mov',
    }
    if (testing.includes('archive_revision_id')) {
      row.archive_revision_id = await idOf(client, 'source_revisions', modelId)
      row.archive_entry_no = 1
    }
    return row
  },
  source_paths: async (client, modelId) => ({
    model_id: modelId,
    source_object_id: await idOf(client, 'source_objects', modelId),
    path_raw: `/Lora/${tag()}.mov`,
    name: 'x.mov',
  }),
  source_revisions: async (client, modelId, testing = []) => {
    const row: Row = {
      model_id: modelId,
      source_object_id: await idOf(client, 'source_objects', modelId),
      sequence_no: 1,
      byte_size: 1,
    }
    // The snapshot pins a revision together with the path it saw.
    if (testing.includes('frozen_by_work_id')) {
      row.frozen_by_work_id = await idOf(client, 'work_operations', modelId)
      row.frozen_path = `/Lora/${tag()}.mov`
    }
    return row
  },

  // 0003_catalog
  inbox_groups: async (client, modelId, testing = []) => {
    const row: Row = {
      model_id: modelId,
      source_id: await idOf(client, 'sources', modelId),
      group_key: `folder:${tag()}`,
      grouping: 'folder',
    }
    if (testing.includes('custom_order_id')) {
      row.custom_order_id = await idOf(client, 'custom_orders', modelId)
    }
    return row
  },
  /** A CUS: an order delivery points at one through the type copy; a release needs a PPV; a
   * promo handoff a PRM. */
  content_items: async (client, modelId, testing = [], forTable) => {
    if (forTable === 'ppv_releases') return newPpv(modelId)
    if (forTable === 'promo_deliveries') testing = [...testing, 'promo_channel_id']
    const row: Row = { model_id: modelId, type: 'CUS', number: nextNumber(), origin: 'manual' }
    if (testing.includes('promo_channel_id') || testing.includes('default_contractor_id')) {
      row.type = 'PRM'
      row.promo_channel_id = await idOf(client, 'promo_channels', modelId)
    }
    if (testing.includes('default_contractor_id')) {
      row.default_contractor_id = await idOf(client, 'contractors', modelId)
    }
    if (testing.includes('merged_into_item_id')) row.deleted_at = new Date().toISOString()
    return row
  },
  /** The first version is not inserted: `asset_versions` makes the pair. */
  assets: async (client, modelId) => ({
    model_id: modelId,
    id: randomUUID(),
    created_in_item_id: await idOf(client, 'content_items', modelId),
    media_kind: 'image',
    current_version_id: randomUUID(),
  }),
  asset_versions: async (client, modelId) => {
    const asset = await make(client, 'assets', modelId)
    return {
      model_id: modelId,
      id: asset.current_version_id,
      asset_id: asset.id,
      version_no: 1,
      master_sha256: await newBlob(client),
    }
  },
  item_memberships: async (client, modelId, testing = []) => {
    if (testing.includes('pinned_version_id')) {
      // Only a reference in a PRM collection pins a version.
      const version = await make(client, 'asset_versions', modelId)
      return {
        model_id: modelId,
        item_id: await idOf(client, 'content_items', modelId, ['promo_channel_id']),
        item_type: 'PRM',
        asset_id: version.asset_id,
        variant_no: 0,
        kind: 'reference',
        role: 'pic',
        ordinal: 1,
        pinned_version_id: version.id,
      }
    }
    return {
      model_id: modelId,
      item_id: await idOf(client, 'content_items', modelId),
      item_type: 'CUS',
      asset_id: await idOf(client, 'assets', modelId),
      variant_no: 0,
      kind: 'owned',
      role: 'pic',
      ordinal: 1,
    }
  },
  asset_manifests: async (client, modelId) => ({
    model_id: modelId,
    purpose: 'download',
    origin_item_id: await idOf(client, 'content_items', modelId),
    entry_count: 1,
  }),
  asset_manifest_entries: async (client, modelId, testing = []) => {
    const version = await make(client, 'asset_versions', modelId)
    const row: Row = {
      model_id: modelId,
      manifest_id: await idOf(client, 'asset_manifests', modelId),
      position: 1,
      item_id: await idOf(client, 'content_items', modelId),
      asset_id: version.asset_id,
      asset_version_id: version.id,
      handle_snapshot: 'SET-001/raw01',
    }
    if (testing.includes('membership_id')) {
      row.membership_id = await idOf(client, 'item_memberships', modelId)
    }
    return row
  },
  aliases: async (client, modelId, testing = []) => {
    const row: Row = { model_id: modelId, kind: 'legacy_name', value_raw: `old ${tag()}.mov` }
    if (testing.includes('asset_id')) row.asset_id = await idOf(client, 'assets', modelId)
    else row.item_id = await idOf(client, 'content_items', modelId)
    if (testing.includes('source_object_id')) {
      row.source_object_id = await idOf(client, 'source_objects', modelId)
    }
    return row
  },
  provenance: async (client, modelId, testing = []) => {
    const row: Row = { model_id: modelId, relation: 'processed_from' }
    for (const end of ['child', 'parent']) {
      if (testing.includes(`${end}_version_id`)) {
        row[`${end}_version_id`] = await idOf(client, 'asset_versions', modelId)
      } else {
        row[`${end}_item_id`] = await idOf(client, 'content_items', modelId)
      }
    }
    if (testing.includes('voided_by_id'))
      row.voided_by_id = await idOf(client, 'provenance', modelId)
    return row
  },
  item_tags: async (client, modelId) => ({
    model_id: modelId,
    item_id: await idOf(client, 'content_items', modelId),
    tag_id: (await insert(client, 'tags', { slug: `tag-${tag()}`, label_ru: 'тег' })).id,
    source: 'human',
  }),
  chronology_entries: async (client, modelId) => ({
    model_id: modelId,
    item_id: await idOf(client, 'content_items', modelId),
    asset_version_id: await idOf(client, 'asset_versions', modelId),
    at_ms: 0,
    text: 'начало',
    source: 'human',
  }),
  platform_texts: async (client, modelId, testing = []) => ({
    model_id: modelId,
    item_id: await idOf(client, 'content_items', modelId),
    platform: 'fansly',
    account_id: testing.includes('account_id') ? await idOf(client, 'accounts', modelId) : null,
    locale: 'en',
    source: 'human',
  }),
  web_uploads: async (client, modelId, testing = []) => ({
    model_id: modelId,
    upload_id: tag(),
    principal_id: await newPrincipal(client),
    client_filename: 'edit.mp4',
    declared_kind: 'other',
    size_expected: 1,
    tmp_key: `inbox/web/${tag()}`,
    ...(testing.includes('plan_row_id')
      ? { plan_row_id: await idOf(client, 'posting_plan_rows', modelId) }
      : {}),
  }),
  inbox_drafts: async (client, modelId, testing = []) => {
    const row: Row = {
      model_id: modelId,
      group_id: await idOf(client, 'inbox_groups', modelId),
      origin: 'disk_scan',
    }
    if (testing.includes('web_upload_id')) {
      row.web_upload_id = await idOf(client, 'web_uploads', modelId)
    } else if (testing.includes('from_version_id')) {
      row.from_version_id = await idOf(client, 'asset_versions', modelId)
    } else {
      row.source_revision_id = await idOf(client, 'source_revisions', modelId)
    }
    return row
  },
  annotation_fields: async (client, modelId, testing = []) => {
    const targets: Record<string, string> = {
      version_id: 'asset_versions',
      group_id: 'inbox_groups',
      draft_id: 'inbox_drafts',
      item_id: 'content_items',
    }
    const column = Object.keys(targets).find((name) => testing.includes(name)) ?? 'item_id'
    return {
      model_id: modelId,
      field: 'title',
      [column]: await idOf(client, targets[column] ?? '', modelId),
    }
  },
  inbox_draft_candidates: async (client, modelId, testing = []) => {
    const row: Row = {
      model_id: modelId,
      draft_id: await idOf(client, 'inbox_drafts', modelId),
      kind: 'existing_item',
    }
    if (testing.includes('order_id')) {
      row.kind = 'order'
      row.order_id = await idOf(client, 'custom_orders', modelId)
    }
    return row
  },
  review_cases: async (_client, modelId) => ({
    model_id: modelId,
    kind: 'legacy_unparsed',
    dedup_key: tag(),
  }),
  download_receipts: async (client, modelId, testing = []) => ({
    model_id: modelId,
    principal_id: await newPrincipal(client),
    kind: 'master',
    manifest_id: await idOf(client, 'asset_manifests', modelId),
    meta_stripped: true,
    entry_count: 1,
    ...(testing.includes('plan_row_id')
      ? { plan_row_id: await idOf(client, 'posting_plan_rows', modelId) }
      : {}),
  }),
  download_receipt_entries: async (client, modelId) => {
    const version = await make(client, 'asset_versions', modelId)
    return {
      model_id: modelId,
      receipt_id: await idOf(client, 'download_receipts', modelId),
      position: 1,
      asset_id: version.asset_id,
      asset_version_id: version.id,
      issued_master: true,
      file_name: 'SET-001_raw01.jpg',
      output_sha256: randomBytes(32),
      byte_size: 1,
    }
  },

  // 0004_orders
  custom_orders: async (client, modelId, testing = []) => ({
    model_id: modelId,
    account_id: testing.includes('account_id') ? await idOf(client, 'accounts', modelId) : null,
    tg_chat: '-100',
    tg_topic: 3,
    tg_message_id: nextNumber(),
    card_author: 'автор',
    card_at: new Date().toISOString(),
    brief: 'ТЗ',
    ordered_duration_raw: '10 минут',
    expects_video: true,
    expects_photos: false,
  }),
  custom_order_messages: async (client, modelId) => ({
    model_id: modelId,
    order_id: await idOf(client, 'custom_orders', modelId),
    tg_ref: `tg:-100/3/${nextNumber()}`,
    kind: 'note',
    message_at: new Date().toISOString(),
    author: 'автор',
    excerpt: 'текст',
  }),
  /** A delivery of the video part; with `retracts_id` — a retraction of one. */
  custom_order_deliveries: async (client, modelId, testing = []) => {
    const orderId = await idOf(client, 'custom_orders', modelId)
    const delivery: Row = {
      model_id: modelId,
      order_id: orderId,
      part: 'video',
      item_id: await idOf(client, 'content_items', modelId),
      manifest_id: await idOf(client, 'asset_manifests', modelId),
      delivered_at: new Date().toISOString(),
      basis: { reply: true },
    }
    if (testing.includes('draft_id'))
      delivery.draft_id = await idOf(client, 'inbox_drafts', modelId)
    if (!testing.includes('retracts_id')) return delivery
    const retracted = await insert(client, 'custom_order_deliveries', delivery)
    return {
      model_id: modelId,
      order_id: orderId,
      retracts_id: retracted.id,
      retract_reason: 'не тот заказ',
    }
  },
  /** An open revision; with `fixed_delivery_id` — bound to a delivery of its order. */
  custom_order_revisions: async (client, modelId, testing = []) => {
    const fixed = testing.includes('fixed_delivery_id')
      ? await make(client, 'custom_order_deliveries', modelId)
      : null
    return {
      model_id: modelId,
      order_id: fixed ? fixed.order_id : await idOf(client, 'custom_orders', modelId),
      requirement: 'без музыки',
      request_tg_ref: `tg:-100/3/${nextNumber()}`,
      requested_at: new Date().toISOString(),
      fixed_delivery_id: fixed ? fixed.id : null,
    }
  },

  // 0005_legacy_placements
  /** A pending claim; with a `resolved_*` column — resolved to that one target. */
  legacy_claims: async (client, modelId, testing = []) => {
    const row: Row = {
      model_id: modelId,
      source_object_id: await idOf(client, 'source_objects', modelId),
      parser_version: 'v1',
      claim_key: `name:${tag()}:0`,
      raw_fragment: 'used2',
      claim_kind: 'used',
      parse_work_id: await idOf(client, 'work_operations', modelId),
    }
    if (testing.includes('source_revision_id')) {
      row.source_revision_id = await idOf(client, 'source_revisions', modelId)
    }
    if (testing.includes('superseded_by_id')) {
      row.resolution = 'ignored'
      row.superseded_by_id = await idOf(client, 'legacy_claims', modelId)
      return row
    }
    const targets: Record<string, string> = {
      resolved_item_id: 'content_items',
      resolved_alias_id: 'aliases',
      resolved_evidence_id: 'placement_evidence',
      resolved_order_id: 'custom_orders',
    }
    const target = Object.keys(targets).find((column) => testing.includes(column))
    if (target) {
      row[target] = await idOf(client, targets[target] ?? '', modelId)
    } else if (testing.includes('resolved_version_id') || testing.includes('resolved_asset_id')) {
      const version = await make(client, 'asset_versions', modelId)
      row.resolved_asset_id = version.asset_id
      row.resolved_version_id = version.id
    } else {
      return row
    }
    row.resolution = 'resolved'
    row.resolved_at = new Date().toISOString()
    return row
  },
  legacy_number_claims: async (client, modelId, testing = []) => {
    const row: Row = {
      model_id: modelId,
      type: 'PPV',
      claimed_number: 32,
      source_object_id: await idOf(client, 'source_objects', modelId),
      claim_id: await idOf(client, 'legacy_claims', modelId),
    }
    if (testing.includes('registry_claim_id')) {
      row.registry_claim_id = await idOf(client, 'legacy_claims', modelId)
    }
    if (testing.includes('target_item_id')) {
      row.target_item_id = await idOf(client, 'content_items', modelId)
    }
    return row
  },
  /** A manual placement of a CUS on a Fansly wall; with `plan_row_id` — of a plan row. */
  placements: async (client, modelId, testing = []) => {
    const surface = await make(client, 'surfaces', modelId)
    const row: Row = {
      model_id: modelId,
      account_id: surface.account_id,
      surface_id: surface.id,
      occurrence_kind: 'manual',
      manual_key: `test:${tag()}`,
      item_id: await idOf(client, 'content_items', modelId),
      item_type: 'CUS',
      occurred_at: new Date().toISOString(),
      occurred_source: 'km',
      surface_source: 'km',
      origin: 'manual',
    }
    if (testing.includes('plan_row_id')) {
      row.plan_row_id = await idOf(client, 'posting_plan_rows', modelId)
    }
    return row
  },
  placement_assets: async (client, modelId, testing = []) => {
    const version = await make(client, 'asset_versions', modelId)
    const row: Row = {
      model_id: modelId,
      placement_id: await idOf(client, 'placements', modelId),
      asset_id: version.asset_id,
      asset_version_id: version.id,
      position: 1,
    }
    if (testing.includes('receipt_entry_id')) {
      row.receipt_entry_id = await idOf(client, 'download_receipt_entries', modelId)
      row.match_strength = 'exact'
    }
    return row
  },
  /** A manual confirmation; with `corrects_id` — its retraction, on the same placement. */
  placement_evidence: async (client, modelId, testing = []) => {
    const placementId = await idOf(client, 'placements', modelId)
    const row: Row = {
      model_id: modelId,
      placement_id: placementId,
      source: 'manual',
      kind: 'manual_confirm',
      strength: 'exact',
      payload: { basis: 'execution_report' },
      dedup_key: `manual:${tag()}`,
    }
    if (testing.includes('matched_version_id') || testing.includes('matched_asset_id')) {
      const version = await make(client, 'asset_versions', modelId)
      row.matched_asset_id = version.asset_id
      row.matched_version_id = version.id
    }
    if (testing.includes('legacy_claim_id')) {
      Object.assign(row, {
        source: 'import',
        kind: 'legacy_claim',
        strength: 'claim',
        legacy_claim_id: await idOf(client, 'legacy_claims', modelId),
      })
    }
    if (testing.includes('corrects_id')) {
      const confirmed = await insert(client, 'placement_evidence', { ...row, dedup_key: tag() })
      Object.assign(row, { kind: 'retract', strength: null, corrects_id: confirmed.id })
    }
    return row
  },

  // 0006_plan
  ppv_releases: async (client, modelId) => ({
    model_id: modelId,
    account_id: await idOf(client, 'accounts', modelId),
    item_id: (await insert(client, 'content_items', newPpv(modelId))).id,
    release_date: '2026-09-24',
  }),
  /**
   * A row of a CUS on a Fansly wall with its composition; the testing columns add a mark, a
   * release (the release's page and object), a montage wait or an assignee.
   */
  posting_plan_rows: async (client, modelId, testing = []) => {
    const row: Row = {
      model_id: modelId,
      slot_date: '2026-09-22',
      slot_time: '20:00',
      manifest_id: await idOf(client, 'asset_manifests', modelId),
    }
    if (testing.includes('release_id')) {
      const release = await make(client, 'ppv_releases', modelId)
      const surface = await insert(client, 'surfaces', {
        model_id: modelId,
        account_id: release.account_id,
        kind: 'wall',
      })
      Object.assign(row, {
        item_id: release.item_id,
        account_id: release.account_id,
        surface_id: surface.id,
        release_id: release.id,
        release_surface_kind: 'wall',
      })
    } else {
      const surface = await make(client, 'surfaces', modelId)
      Object.assign(row, {
        item_id: await idOf(client, 'content_items', modelId),
        account_id: surface.account_id,
        surface_id: surface.id,
      })
    }
    if (testing.includes('marked_manifest_id')) {
      Object.assign(row, {
        marked_at: new Date().toISOString(),
        marked_by: await newPrincipal(client),
        mark_kind: 'posted',
        marked_manifest_id: row.manifest_id,
      })
    }
    if (testing.includes('input_manifest_id')) {
      row.expected_type = 'FYP'
      row.input_manifest_id = await idOf(client, 'asset_manifests', modelId)
  // 0005_promo
  contractors: async (client, modelId, testing = []) => ({
    model_id: modelId,
    name: `подрядчик ${tag()}`,
    format: 'upload',
    channel_id: testing.includes('channel_id')
      ? await idOf(client, 'promo_channels', modelId)
      : null,
  }),
  /** A handoff being prepared; with `receipt_id` — prepared; with `corrects_id` — a redo. */
  promo_deliveries: async (client, modelId, testing = []) => {
    const pkg = await make(client, 'content_items', modelId, ['promo_channel_id'])
    const row: Row = {
      model_id: modelId,
      package_item_id: pkg.id,
      channel_id: pkg.promo_channel_id,
      contractor_id: await idOf(client, 'contractors', modelId),
      format: 'upload',
      manifest_id: await idOf(client, 'asset_manifests', modelId),
      state: 'preparing',
      prepared_at: new Date().toISOString(),
      prepared_by: await newPrincipal(client),
    }
    if (testing.includes('receipt_id')) {
      row.state = 'prepared'
      row.receipt_id = await idOf(client, 'download_receipts', modelId)
    }
    if (testing.includes('corrects_id')) {
      const first = await insert(client, 'promo_deliveries', {
        ...row,
        state: 'preparing',
        receipt_id: null,
      })
      row.manifest_id = await idOf(client, 'asset_manifests', modelId)
      row.corrects_id = first.id
    }
    return row
  },
}
