// Posts of the fake Agency Hub for `DEV_FAKE_HUB=1` (SPEC §12.0), made from the dev plan of Лора:
// a post found exactly by its download name (FYP proven by For You views), a wall row with two
// posts in its window («2 варианта»), one candidate for every other untouched row, OnlyFans
// pairs, a vault file in its album and a post nobody planned. It also switches receiving and
// matching on for the model, sets the thresholds of SPEC §7 and starts matching three days back,
// so the first hourly poll fills «План › Сверить» and the Hub states of the rows. Refs, names and
// captions are made up. Called by `dev-hub.ts` before it says `ready`.
import { randomBytes, randomUUID } from 'node:crypto'
import { createDb, createPool, enqueueWork, SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { type FakeHub, fakeRow } from '@contentops/hub/testing'
import { sql } from 'drizzle-orm'

export async function seedMatching(hub: FakeHub, databaseUrl: string): Promise<number> {
  const MODEL = process.env.DEV_HUB_MODEL ?? 'lora'
  const pool = createPool(databaseUrl, { max: 2, applicationName: 'dev-hub' })
  const db = createDb(pool)
  const DAY = 86_400_000
  const now = Date.now()

  const tx = <T>(fn: Parameters<typeof withActorTx<T>>[2]) =>
    withActorTx(db, { actor: SYSTEM_ACTOR('dev-hub'), action: 'dev.hub', requestId: randomUUID() }, fn)

  interface Page {
    model_id: string
    id: string
    code: string
    platform: 'fansly' | 'onlyfans'
  }

  const { rows: pages } = await db.execute<Page>(sql`
    SELECT a.model_id, a.id, a.code, a.platform FROM accounts a JOIN models m ON m.id = a.model_id
     WHERE m.code = ${MODEL} AND a.archived_at IS NULL ORDER BY a.position`)
  if (pages.length === 0) throw new Error(`no pages of ${MODEL}`)
  const modelId = (pages[0] as Page).model_id

  // Hub on for the model, matching started three days ago, the thresholds of the first day.
  await tx(async (t) => {
    for (const page of pages) {
      await t.execute(sql`UPDATE accounts SET hub_page_ref = ${page.code}, row_version = row_version + 1
                           WHERE id = ${page.id}::uuid AND hub_page_ref IS DISTINCT FROM ${page.code}`)
      await enqueueWork(t, {
        modelId,
        kind: 'hub_history',
        workKey: `history:${page.id}:first`,
        accountId: page.id,
        dataset: 'history',
        windowTo: new Date(now - 3 * DAY).toISOString(),
      })
    }
    const settings: [string, unknown, string | null][] = [
      ['hub.receive', true, modelId],
      ['hub.auto_match', true, modelId],
      ['hub_candidate_tolerance', 30, null],
      ['hub_exact_duration_ms', 200, null],
      ['hub_wait_window', 8, null],
      ['hub_not_out_window', 24, null],
      ['hub_vault_recheck', 7, null],
    ]
    for (const [key, value, model] of settings) {
      await t.execute(sql`
        INSERT INTO policy_settings (model_id, key, value)
        VALUES (${model}::uuid, ${key}, ${JSON.stringify(value)}::jsonb)
        ON CONFLICT ON CONSTRAINT policy_settings_scope DO NOTHING`)
    }
  })

  interface Row {
    id: string
    account: string
    platform: 'fansly' | 'onlyfans'
    surface: 'wall' | 'fyp' | 'vault'
    slot_at: string
    slot_date: string
    slot_time: string | null
    manifest_id: string
    marked: boolean
    type: string
    number: number
    title: string | null
  }

  interface File {
    asset_id: string
    version_id: string
    role: string
    ordinal: number | null
    media_kind: 'video' | 'image'
    duration_ms: number | null
    width: number | null
    height: number | null
  }

  const { rows: rows } = await db.execute<Row>(sql`
    SELECT r.id, a.code AS account, a.platform, s.kind AS surface, r.slot_at::text,
           r.slot_date::text, to_char(r.slot_time, 'HH24MI') AS slot_time, r.manifest_id,
           r.marked_at IS NOT NULL AS marked, i.type, i.number, i.title
      FROM posting_plan_rows r
      JOIN accounts a ON a.model_id = r.model_id AND a.id = r.account_id
      JOIN surfaces s ON s.model_id = r.model_id AND s.id = r.surface_id
      JOIN content_items i ON i.model_id = r.model_id AND i.id = r.item_id
     WHERE r.model_id = ${modelId}::uuid AND r.cancelled_at IS NULL AND r.manifest_id IS NOT NULL
       AND s.kind IN ('wall', 'fyp', 'vault')
       AND r.slot_date BETWEEN current_date - 2 AND current_date
     ORDER BY r.slot_at, a.position`)

  async function filesOf(manifest: string): Promise<File[]> {
    const { rows: files } = await db.execute<File>(sql`
      SELECT e.asset_id, e.asset_version_id AS version_id, coalesce(m.role, 'pic') AS role, m.ordinal,
             a.media_kind, v.duration_ms::int AS duration_ms, v.width, v.height
        FROM asset_manifest_entries e
        JOIN assets a ON a.model_id = e.model_id AND a.id = e.asset_id
        JOIN asset_versions v ON v.model_id = e.model_id AND v.id = e.asset_version_id
        LEFT JOIN item_memberships m ON m.model_id = e.model_id AND m.id = e.membership_id
       WHERE e.manifest_id = ${manifest}::uuid ORDER BY e.position`)
    return files.filter((file) => !['teaser', 'preview', 'thumb', 'cap'].includes(file.role))
  }

  const publicId = (row: Row) =>
    `${row.type}-${String(row.number).padStart(row.type === 'FYP' || row.type === 'RAW' ? 4 : 3, '0')}`

  type Fake = ReturnType<typeof fakeRow>
  const byPage = new Map<string, { posts: Fake[]; attachments: Fake[]; stats: Fake[]; vault: Fake[] }>()
  const own = (account: string) => {
    const found = byPage.get(account) ?? { posts: [], attachments: [], stats: [], vault: [] }
    byPage.set(account, found)
    return found
  }
  let serial = 0

  function post(row: Pick<Row, 'account' | 'platform'>, at: number, files: File[], options: { names?: (string | null)[]; caption?: string } = {}) {
    serial += 1
    const ref = `dev-${row.account}-${serial}`
    const publishedAt = new Date(at).toISOString()
    const page = own(row.account)
    page.posts.push(
      fakeRow('posts', ref, {
        platform: row.platform,
        postRef: ref,
        postText: options.caption ?? `Тестовая подпись ${serial}`,
        publishedAt,
        firstObservedAt: new Date(at + 2 * 3_600_000).toISOString(),
        lastObservedAt: new Date(at + 3 * 3_600_000).toISOString(),
        attachmentCount: files.length,
        fypFlags: row.platform === 'fansly' && files.every((file) => file.media_kind === 'image') ? 4 : 0,
        wallRefs: [],
      }),
    )
    for (const [index, file] of files.entries()) {
      const media = `${ref}-m${index}`
      page.attachments.push(
        fakeRow('post_attachments', `${ref}:${index}`, {
          platform: row.platform,
          postRef: ref,
          publishedAt,
          attachmentIndex: files.length > 1 ? 0 : index,
          memberIndex: files.length > 1 ? index : null,
          pos: index,
          contentType: files.length > 1 ? 2 : 1,
          contentRef: `content-${ref}`,
          role: 'main',
          mediaOfferRef: `offer-${media}`,
          mediaRef: media,
          linkState: 'resolved',
          filename: options.names?.[index] ?? null,
          mimeType: file.media_kind === 'video' ? 'video/mp4' : 'image/jpeg',
          durationMs: file.media_kind === 'video' ? (file.duration_ms ?? 9_000) + 40 : null,
          originalWidth: file.width,
          originalHeight: file.height,
        }),
      )
    }
    return ref
  }

  /** A download receipt as `media.download` writes it: the name and the shape of the issued file. */
  async function issue(row: Row, files: File[]): Promise<string[]> {
    const { rows: owner } = await db.execute<{ id: string }>(sql`
      SELECT id FROM principals WHERE kind = 'human' ORDER BY created_at LIMIT 1`)
    const names = files.map((file) => {
      const ord = file.ordinal ? String(file.ordinal).padStart(2, '0') : ''
      const ext = file.media_kind === 'video' ? 'mp4' : 'jpg'
      return `${publicId(row)}_${file.role}${ord}__${row.account}_${row.slot_date}${row.slot_time ? `_${row.slot_time}` : ''}.${ext}`
    })
    await tx(async (t) => {
      const { rows: receipt } = await t.execute<{ id: string }>(sql`
        INSERT INTO download_receipts (model_id, principal_id, kind, manifest_id, meta_stripped, entry_count, plan_row_id)
        VALUES (${modelId}::uuid, ${owner[0]?.id}::uuid, 'platform', ${row.manifest_id}::uuid, true, ${files.length}, ${row.id}::uuid)
        RETURNING id`)
      for (const [index, file] of files.entries()) {
        await t.execute(sql`
          INSERT INTO download_receipt_entries (model_id, receipt_id, position, asset_id, asset_version_id,
                                                issued_master, file_name, output_sha256, byte_size,
                                                duration_ms, width, height)
          VALUES (${modelId}::uuid, ${receipt[0]?.id}::uuid, ${index + 1}, ${file.asset_id}::uuid,
                  ${file.version_id}::uuid, true, ${names[index] as string}, ${randomBytes(32)}, 1000,
                  ${file.duration_ms}, ${file.width}, ${file.height})`)
      }
    })
    return names
  }

  // Untouched Fansly rows show Hub best: the first FYP is found exactly, the first wall row gets
  // two posts in its window («2 варианта»), the rest one candidate each.
  const fansly = rows.filter((row) => row.platform === 'fansly' && row.surface !== 'vault' && !row.marked)
  const exactRow = fansly.find((row) => row.surface === 'fyp')
  const variantRow = fansly.find((row) => row !== exactRow && row.surface === 'wall') ?? fansly.find((row) => row !== exactRow)
  for (const row of rows) {
    const files = await filesOf(row.manifest_id)
    if (files.length === 0) continue
    const slot = Date.parse(row.slot_at)
    if (row.surface === 'vault') {
      if (row.platform !== 'fansly') continue
      const file = files[0] as File
      const album = row.type === 'LIFE' ? 'Lifestyle' : `${publicId(row)} ${row.title ?? ''}`.trim()
      own(row.account).vault.push(
        fakeRow('vault_media', `${row.account}:alb-${row.id}:mem-1`, {
          platform: 'fansly',
          vaultKind: 'creator',
          albumRef: `alb-${row.id}`,
          albumTitle: album,
          lastFullWalkAt: new Date(now - 3_600_000).toISOString(),
          fullWalkRef: `walk-${row.id}`,
          fullWalkObservedCount: 1,
          filename: `dev-${row.id}.bin`,
          mimeType: file.media_kind === 'video' ? 'video/mp4' : 'image/jpeg',
          durationMs: file.media_kind === 'video' ? file.duration_ms : null,
          originalWidth: file.width,
          originalHeight: file.height,
          mediaRef: `vault-${row.id}`,
          mediaOfferRef: `offer-vault-${row.id}`,
          memberRef: 'mem-1',
          mediaType: file.media_kind === 'video' ? 2 : 1,
          firstObservedAt: new Date(slot + 3_600_000).toISOString(),
        }),
      )
      continue
    }
    if (row === exactRow) {
      // Found exactly: the issued name, its size and length; FYP proven by For You views.
      const names = await issue(row, files)
      const ref = post(row, slot + 6 * 60_000, files, { names })
      own(row.account).stats.push(
        fakeRow('creator_stats_media_daily', `offer-${ref}-m0:0`, {
          platform: 'fansly',
          mediaOfferId: `offer-${ref}-m0`,
          mediaId: `${ref}-m0`,
          source: 0,
          sourceLabel: 'For You',
          day: new Date(now).toISOString().slice(0, 10),
          views: 1_240,
          capturedAt: new Date(now).toISOString(),
        }),
      )
    } else if (row === variantRow) {
      post(row, slot + 2 * 60_000, files)
      post(row, slot + 17 * 60_000, files)
    } else {
      post(row, slot + 4 * 60_000, files)
    }
  }

  // A post nobody planned on the first Fansly page.
  const first = pages.find((page) => page.platform === 'fansly')
  if (first) {
    post(first, now - 5 * 3_600_000, [
      { asset_id: '', version_id: '', role: 'pic', ordinal: null, media_kind: 'image', duration_ms: null, width: 900, height: 1200 },
    ], { caption: 'Доброе утро ☀️' })
  }

  for (const [account, page] of byPage) {
    hub.put('posts', account, page.posts)
    hub.put('post_attachments', account, page.attachments)
    hub.put('creator_stats_media_daily', account, page.stats)
    hub.put('vault_media', account, page.vault)
  }
  await pool.end()
  return [...byPage.values()].reduce((n, page) => n + page.posts.length, 0)
}
