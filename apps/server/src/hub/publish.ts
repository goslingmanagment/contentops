import { vaultAlbumName } from '@contentops/contracts/vault-album'
import {
  type Db,
  enqueueWork,
  isSwitchOn,
  LeaseLostError,
  type PeriodicStream,
  type Queryable,
  RunnerStoppedError,
  SYSTEM_ACTOR,
  type Tx,
  values,
  type WorkContext,
  WorkDeferred,
  WorkError,
  type WorkHandler,
  type WorkRow,
  type WorkSuccess,
  withActorTx,
} from '@contentops/db'
import {
  type DraftInput,
  HUB_STATUS_POLL_INTERVAL_MS,
  type HubClient,
  type HubPublication,
  isHubError,
  type MediaKey,
  publicationChangesSince,
} from '@contentops/hub'
import { sql } from 'drizzle-orm'
import { itemTypeOfDb, publicIdOf } from '../catalog/ids'
import type { ModelScope } from '../context'
import { type Choice, type FileRow, issuedName, pickFiles } from '../media/downloads'
import { manifestFiles } from '../plan/composition'
import { type HubFile, type RowRecord, rowById } from '../plan/records'
import type { PublishMedia } from './publish-media'
import {
  draftFingerprint,
  draftKey,
  FINAL_STATUSES,
  fileKey,
  kindRule,
  ONLYFANS_VAULT_ONLY,
  replaceable,
  sameVaultFile,
  UPLOAD_KEEP_MS,
  type VaultMember,
  vaultKey,
} from './publish-rules'
import type { HubClientFactory } from './sync'

/**
 * Publication of plan rows through Hub (SPEC §7 «Публикация через Hub», §8, §8.1, §11.1;
 * PLAN 5б), work `hub_publish` of role `worker` in Hub's slot:
 *
 * - `prepare` — the files of the row that Hub lacks go up (the platform copy named by naming
 *   §5–6, accounted by SHA-256: a repeat uploads nothing the row already holds); the very same
 *   file already in the page's vault goes by reference; Hub makes the draft from the row's
 *   fields and returns its checks, kept on the row. A copy still being built is waited for.
 *   OnlyFans publishes only files already in its vault; a mass message only by hand.
 * - `send` — a person who saw the checks approves the draft of that version (an agent never
 *   sends: the route refuses it and the work checks the principal again).
 * - `cancel` — ContentOps' own publication, while Hub has not handed it to the platform; later
 *   only the owner in Hub.
 * - `status` — every 10 min per page with publications: Hub's feed of changes from the greatest
 *   `updatedAt` read minus an overlap, applied idempotently; a published row gets its placement
 *   and exact evidence through `platform_post_ref` / `vault_album_ref`, never by matching.
 *
 * The switch «Публикация» of the page is checked by the work gate before every attempt and
 * before every request: switched off, the work waits with `switch_off:hub.publish`.
 */

export interface HubPublishOptions {
  client: HubClientFactory
  media: PublishMedia
  /** How long a prepare waits for its platform copy before looking again (default 15 s). */
  waitMs?: number
}

interface Page {
  modelId: string
  accountId: string
  platform: values.Platform
  code: string
  hubPage: string | null
  model: ModelScope
}

async function pageOf(db: Queryable, accountId: string | null): Promise<Page | null> {
  if (!accountId) return null
  const { rows } = await db.execute<{
    model_id: string
    id: string
    platform: values.Platform
    code: string
    hub_page_ref: string | null
    model_code: string
    model_title: string
  }>(sql`
    SELECT a.model_id, a.id, a.platform, a.code, a.hub_page_ref, m.code AS model_code,
           m.title AS model_title
      FROM accounts a JOIN models m ON m.id = a.model_id
     WHERE a.id = ${accountId}::uuid`)
  const row = rows[0]
  if (!row) return null
  return {
    modelId: row.model_id,
    accountId: row.id,
    platform: row.platform,
    code: row.code,
    hubPage: row.hub_page_ref,
    model: { id: row.model_id, code: row.model_code, name: row.model_title },
  }
}

// ---------------------------------------------------------------------------
// Queueing (the routes, the row cancel)
// ---------------------------------------------------------------------------

/** What a row work carries: the row and who asked (the person who sends). */
export interface RowJob {
  rowId: string
  principalId: string | null
  /** `send`: the draft version whose checks the person saw. */
  version?: number
}

export const rowStreamKey = (rowId: string) => `hubpub-row:${rowId}`
export const pageStreamKey = (accountId: string) => `hubpub:${accountId}`

/**
 * Queues one work of a row inside the command's transaction. One at a time per row: a busy row
 * answers with the work already under way (`created: false`).
 */
export async function enqueueRowWork(
  tx: Tx,
  input: {
    modelId: string
    accountId: string
    op: 'prepare' | 'send' | 'cancel'
    job: RowJob
    requestId: string
  },
): Promise<{ work: WorkRow; created: boolean }> {
  return enqueueWork(tx, {
    modelId: input.modelId,
    kind: 'hub_publish',
    workKey: `hubpub:${input.job.rowId}:${input.op}:${input.requestId}`,
    accountId: input.accountId,
    dataset: input.op,
    scope: `row:${input.job.rowId}`,
    streamKey: rowStreamKey(input.job.rowId),
    // A person waits for the answer: ahead of the 10-minute reads.
    priority: input.op === 'send' ? 30 : 20,
    checkpoint: input.job,
  })
}

/**
 * Pages whose statuses are read every 10 min: Hub set up, «Публикация» on, and a publication
 * that may still change (or went out within two days: its post is still to reach the mirror).
 */
export async function publicationStreams(
  db: Db,
  options: { configured: boolean },
): Promise<PeriodicStream[]> {
  if (!options.configured) return []
  const { rows: pages } = await db.execute<{ model_id: string; account_id: string }>(sql`
    SELECT DISTINCT r.model_id, r.account_id
      FROM posting_plan_rows r
      JOIN accounts a ON a.model_id = r.model_id AND a.id = r.account_id
     WHERE r.hub_publication_id IS NOT NULL AND a.hub_page_ref IS NOT NULL
       AND a.archived_at IS NULL
       AND (r.hub_status <> ALL (${sql.param([...FINAL_STATUSES])}::text[])
            OR (r.hub_status = 'published' AND r.hub_status_at > now() - interval '2 days'))`)
  const streams: PeriodicStream[] = []
  for (const page of pages) {
    const scope = { modelId: page.model_id, accountId: page.account_id }
    if (!(await isSwitchOn(db, 'hub.publish', scope))) continue
    streams.push({
      streamKey: pageStreamKey(page.account_id),
      kind: 'hub_publish',
      modelId: page.model_id,
      accountId: page.account_id,
      dataset: 'status',
      intervalMs: HUB_STATUS_POLL_INTERVAL_MS,
      priority: 10,
    })
  }
  return streams
}

// ---------------------------------------------------------------------------
// The work
// ---------------------------------------------------------------------------

/** A refusal in words, final: the row shows it under its buttons. */
const refused = (code: string, text: string) => new WorkError('permanent', code, text)

function isControl(error: unknown): boolean {
  return (
    error instanceof WorkDeferred ||
    error instanceof LeaseLostError ||
    error instanceof RunnerStoppedError ||
    error instanceof WorkError
  )
}

/** Hub's answers as work outcomes, in words the row can show. */
function hubFailure(error: unknown): unknown {
  if (isControl(error) || !isHubError(error)) return error
  switch (error.kind) {
    case 'auth_rejected':
      return new WorkError('permanent', 'auth_rejected', 'Hub не принял ключ ContentOps', {
        cause: error,
      })
    case 'rate_limited':
      return new WorkError('transient', 'rate_limited', 'Hub просит подождать', {
        ...(error.retryAfterMs == null ? {} : { retryAfterMs: error.retryAfterMs }),
        cause: error,
      })
    case 'transient':
      return new WorkError('transient', 'hub_unavailable', 'Hub недоступен', { cause: error })
    case 'bad_response':
      return new WorkError('permanent', 'format_changed', 'Hub ответил не по договорённости', {
        cause: error,
      })
    case 'refused':
      return new WorkError(
        'permanent',
        'hub_refused',
        `Hub отказал: ${error.code ?? error.status}`,
        {
          cause: error,
        },
      )
  }
}

export function hubPublishHandler(options: HubPublishOptions): WorkHandler {
  return async (context) => {
    const { work, db } = context
    const op = values.hubPublishOps.find((name) => name === work.dataset)
    if (!op) throw refused('bad_stream', `нет операции ${work.dataset}`)
    const page = await pageOf(db, work.accountId)
    if (!page?.hubPage) throw refused('not_configured', 'Hub для страницы не настроен')
    const client = options.client()
    if (!client) throw refused('not_configured', 'Hub не настроен: нет ключа ContentOps')
    const run = new Run(context, client, { ...page, hubPage: page.hubPage }, options)
    try {
      switch (op) {
        case 'prepare':
          return await run.prepare()
        case 'send':
          return await run.send()
        case 'cancel':
          return await run.cancel()
        case 'status':
          return await run.status()
      }
    } catch (error) {
      throw hubFailure(error)
    }
  }
}

type HubPage = Page & { hubPage: string }

class Run {
  constructor(
    readonly context: WorkContext,
    readonly client: HubClient,
    readonly page: HubPage,
    readonly options: HubPublishOptions,
  ) {}

  get db(): Db {
    return this.context.db
  }

  get job(): RowJob {
    const job = this.context.work.checkpoint as RowJob | null
    if (!job?.rowId) throw refused('bad_work', 'у работы нет строки плана')
    return job
  }

  /** New requests stop as soon as «Публикация» of the page is off (SPEC §8). */
  async guard(): Promise<void> {
    const on = await isSwitchOn(this.db, 'hub.publish', {
      modelId: this.page.modelId,
      accountId: this.page.accountId,
    })
    if (!on) throw new WorkDeferred(0, 'публикация через Hub выключена для страницы')
  }

  async row(): Promise<RowRecord> {
    return rowById(this.db, this.page.model, this.job.rowId)
  }

  // --- prepare ---------------------------------------------------------------

  async prepare(): Promise<WorkSuccess> {
    const row = await this.row()
    const { page } = this
    if (row.cancelled_at) throw refused('row_cancelled', 'Строка отменена')
    if (row.marked_at) throw refused('row_marked', 'Строка уже отмечена: её выложили руками')
    if (!row.manifest_id || !row.item_id || !row.item_type || row.item_number === null) {
      throw refused('nothing_to_publish', 'Строка ждёт файл — публиковать нечего')
    }
    if (!row.slot_time) {
      throw refused('no_time', 'У строки нет времени: Hub публикует ко времени — задайте его')
    }
    const price = row.price_mills === null ? null : Number(row.price_mills)
    const rule = kindRule(page.platform, row.surface, price)
    if (rule.kind === null) throw refused('manual_only', rule.manual)
    if (!replaceable(row.hub_status)) {
      throw refused(
        'publication_sent',
        'Публикация уже отправлена в Hub: подготовить заново можно после отмены или «не вышло»',
      )
    }
    const item = {
      id: row.item_id,
      type: row.item_type,
      public_id: publicIdOf(row.item_type, row.item_number),
      title: row.item_title,
      title_en: row.item_title_en,
    }
    const files = await manifestFiles(this.db, page.modelId, row.manifest_id)
    const kind: 'platform' | 'teaser' = row.surface === 'story' ? 'teaser' : 'platform'
    const media = pickFiles(row.item_type, files, kind)
    if (media.length === 0) {
      throw refused('nothing_to_publish', 'В составе строки нет файла для площадки')
    }
    // A paid PPV post shows its teaser before the purchase.
    const previews =
      rule.kind === 'paid_post' && row.item_type === 'PPV' && media.length === 1
        ? pickFiles(row.item_type, files, 'teaser').slice(0, 1)
        : []
    const wanted: { choice: Choice; role: HubFile['role']; kind: 'platform' | 'teaser' }[] = [
      ...media.map((choice) => ({ choice, role: 'media' as const, kind })),
      ...previews.map((choice) => ({ choice, role: 'preview' as const, kind: 'teaser' as const })),
    ]
    const slot = { account: row.account, date: row.slot_date, time: row.slot_time }
    const members = await vaultMembers(this.db, page, item.public_id)
    const now = await dbNow(this.db)
    const resolved: (HubFile | null)[] = []
    const missing: { index: number; file: FileRow; name: string; role: HubFile['role'] }[] = []
    for (const [index, want] of wanted.entries()) {
      const file = want.choice.file
      const name = issuedName(
        { modelCode: page.model.code, item, kind: want.kind, slot },
        want.choice,
        true,
      )
      const inVault = sameVaultFile(
        {
          name,
          duration_ms: file.duration_ms === null ? null : Number(file.duration_ms),
          frames: await framesOf(this.db, file),
        },
        members,
      )
      if (inVault) {
        resolved.push({
          version_id: file.version_id,
          name,
          role: want.role,
          sha256: null,
          bytes: null,
          file_id: null,
          vault_media_ref: inVault.media_ref,
          uploaded_at: null,
        })
        continue
      }
      if (page.platform === 'onlyfans') {
        throw refused('onlyfans_vault_only', `${ONLYFANS_VAULT_ONLY}: файла «${name}» там нет`)
      }
      const kept = row.hub_files.find(
        (held) =>
          held.version_id === file.version_id &&
          held.name === name &&
          held.role === want.role &&
          held.file_id !== null &&
          held.uploaded_at !== null &&
          now.getTime() - Date.parse(held.uploaded_at) < UPLOAD_KEEP_MS,
      )
      if (kept) {
        resolved.push(kept)
        continue
      }
      resolved.push(null)
      missing.push({ index, file, name, role: want.role })
    }

    // Bytes first: while a copy for the platform is being built, the work waits for it.
    const ready: {
      index: number
      name: string
      role: HubFile['role']
      file: FileRow
      bytes: Awaited<ReturnType<PublishMedia['bytes']>>
    }[] = []
    let building = false
    for (const one of missing) {
      const bytes = await this.options.media.bytes(this.db, {
        modelId: page.modelId,
        rowId: row.id,
        position: one.index + 1,
        file: one.file,
      })
      if (bytes === 'building') building = true
      ready.push({ ...one, bytes })
    }
    if (building) {
      for (const one of ready) if (one.bytes !== 'building') await one.bytes.release()
      throw new WorkDeferred(this.options.waitMs ?? 15_000, 'ждёт копию для платформы')
    }
    let uploaded = 0
    let known = 0
    for (const one of ready) {
      const bytes = one.bytes
      if (bytes === 'building') continue
      try {
        await this.guard()
        const answer = await this.client.uploadPublicationFile(page.hubPage, {
          name: one.name,
          open: bytes.open,
          size: bytes.size,
          sha256: bytes.sha256,
          signal: this.context.signal,
        })
        if (answer.created) uploaded += 1
        else known += 1
        resolved[one.index] = {
          version_id: one.file.version_id,
          name: one.name,
          role: one.role,
          sha256: bytes.sha256,
          bytes: bytes.size,
          file_id: answer.file.id,
          vault_media_ref: null,
          uploaded_at: now.toISOString(),
        }
      } finally {
        await bytes.release()
      }
      await this.context.checkpoint({
        progress: { num: uploaded + known, den: ready.length, note: 'файлы в Hub' },
      })
    }
    const held = resolved.filter((file): file is HubFile => file !== null)
    const keyOf = (file: HubFile): MediaKey =>
      file.vault_media_ref ? vaultKey(file.vault_media_ref) : fileKey(file.file_id as number)
    const entry = { id: item.public_id, title: item.title ?? '', type: itemTypeOfDb(row.item_type) }
    const tiers = page.platform === 'fansly' ? (row.tier_refs ?? []) : []
    const draft: Omit<DraftInput, 'idempotencyKey'> = {
      kind: rule.kind,
      publishAt: row.slot_at,
      ...(rule.kind === 'vault_album'
        ? { albumName: row.album_name ?? vaultAlbumName(entry) }
        : { caption: row.caption ?? '' }),
      media: held.filter((file) => file.role === 'media').map(keyOf),
      previews: held.filter((file) => file.role === 'preview').map(keyOf),
      ...(tiers.length > 0 && rule.kind !== 'vault_album'
        ? { audience: { kind: 'tiers' as const, tierRefs: tiers } }
        : {}),
      priceMills: rule.kind === 'paid_post' ? price : null,
      repost: row.repost,
    }
    const fingerprint = draftFingerprint(draft)

    let publication: HubPublication
    await this.guard()
    if (
      row.hub_publication_id !== null &&
      row.hub_status === 'draft' &&
      row.hub_content_hash === fingerprint
    ) {
      // The same draft: Hub's checks are read again, nothing is made twice.
      publication = await this.client.getPublication(row.hub_publication_id, this.context.signal)
    } else {
      if (row.hub_publication_id !== null && row.hub_status === 'draft') {
        // The row changed: the old draft goes before the new one is made.
        await this.client
          .cancel(row.hub_publication_id, this.context.signal)
          .catch((error: unknown) => {
            if (!isHubError(error, 'refused')) throw error
          })
      }
      // The key names the publication this one follows: the same content after a cancel, «не
      // вышло» or a replaced draft is a new draft, while a retry of this work replays it.
      const previous = row.hub_publication_id
      publication = await this.client.createDraft(
        page.hubPage,
        { ...draft, idempotencyKey: draftKey(row.id, previous, fingerprint) },
        this.context.signal,
      )
    }
    const preparedBy = this.job.principalId
    const rowVersion = row.row_version
    return {
      report: {
        row_id: row.id,
        publication_id: publication.id,
        status: publication.status,
        uploaded,
        already_in_hub: known,
        from_vault: held.filter((file) => file.vault_media_ref).length,
        kept: held.length - uploaded - known - held.filter((file) => file.vault_media_ref).length,
        blocked: publication.blocked,
      },
      commit: async (tx) => {
        await tx.execute(sql`
          UPDATE posting_plan_rows SET
            hub_publication_id = ${publication.id}, hub_kind = ${rule.kind},
            hub_status = ${publication.status}, hub_status_reason = ${publication.statusReason},
            hub_status_at = ${publication.statusChangedAt ?? publication.updatedAt}::timestamptz,
            hub_updated_at = ${publication.updatedAt}::timestamptz,
            hub_version = ${publication.version}, hub_checks = ${checksJson(publication)}::jsonb,
            hub_files = ${JSON.stringify(held)}::jsonb, hub_content_hash = ${fingerprint},
            hub_prepared_at = now(), hub_prepared_by = ${preparedBy}::uuid,
            hub_prepared_version = ${rowVersion}, hub_sent_at = NULL, hub_sent_by = NULL,
            platform_post_ref = NULL, vault_album_ref = NULL
           WHERE model_id = ${page.modelId}::uuid AND id = ${row.id}::uuid`)
      },
    }
  }

  // --- send ------------------------------------------------------------------

  async send(): Promise<WorkSuccess> {
    const job = this.job
    const row = await this.row()
    if (!job.principalId || !(await isPerson(this.db, job.principalId))) {
      throw refused('agent_cannot_send', 'Отправить может только человек')
    }
    if (row.cancelled_at) throw refused('row_cancelled', 'Строка отменена')
    if (row.hub_publication_id === null || row.hub_version === null) {
      throw refused('not_prepared', 'Сначала «Подготовить»')
    }
    const id = row.hub_publication_id
    if (row.hub_status !== 'draft') {
      if (row.hub_sent_at && row.hub_status !== 'cancelled') return { report: { already: true } }
      throw refused('not_draft', 'Черновика нет — подготовьте заново')
    }
    if (row.hub_prepared_version !== null && row.row_version > row.hub_prepared_version) {
      throw refused('draft_stale', 'Строку изменили после «Подготовить» — подготовьте заново')
    }
    if (job.version !== undefined && job.version !== row.hub_version) {
      throw refused('version_changed', 'Черновик изменился — посмотрите проверки и отправьте снова')
    }
    await this.guard()
    // The person saw these checks: Hub's are read again, a change is shown before anything goes.
    const checks = await this.client.getPublication(id, this.context.signal)
    const changed = checks.version !== row.hub_version || checks.blocked
    if (changed || checks.status !== 'draft') {
      const failure =
        checks.status !== 'draft'
          ? refused('not_draft', `Черновика в Hub больше нет (${checks.status})`)
          : checks.blocked
            ? refused('publication_blocked', 'Hub не пропускает черновик: смотрите проверки')
            : refused('version_changed', 'Черновик в Hub изменился — посмотрите проверки снова')
      await this.save(checks)
      throw failure
    }
    await this.guard()
    const [result] = await this.client.approve(
      [{ id, version: row.hub_version }],
      this.context.signal,
    )
    if (!result) throw refused('hub_refused', 'Hub не ответил на утверждение')
    if (!result.approved) {
      if (result.publication) await this.save(result.publication)
      throw refused(
        result.reason === 'blocking_findings' ? 'publication_blocked' : 'approve_refused',
        result.reason === 'blocking_findings'
          ? 'Hub не пропускает черновик: смотрите проверки'
          : result.reason === 'version_conflict'
            ? 'Черновик в Hub изменился — посмотрите проверки снова'
            : `Hub не утвердил: ${result.reason ?? 'без причины'}`,
      )
    }
    const publication = result.publication ?? (await this.client.getPublication(id))
    const sentBy = job.principalId
    return {
      report: { row_id: row.id, publication_id: id, status: publication.status },
      commit: async (tx) => {
        await applyPublication(tx, this.page, row.id, publication, { force: true })
        await tx.execute(sql`
          UPDATE posting_plan_rows SET hub_sent_at = now(), hub_sent_by = ${sentBy}::uuid
           WHERE model_id = ${this.page.modelId}::uuid AND id = ${row.id}::uuid
             AND hub_sent_at IS NULL`)
      },
    }
  }

  /** Keeps what Hub just said about the row's publication, outside the work's finish. */
  private async save(publication: HubPublication): Promise<void> {
    const { work } = this.context
    await withActorTx(
      this.db,
      {
        actor: SYSTEM_ACTOR('hub'),
        action: 'hub.publish.checks',
        requestId: `work:${work.id}:${work.fenceGeneration}:checks`,
        workId: work.id,
      },
      (tx) => applyPublication(tx, this.page, this.job.rowId, publication, { force: true }),
    )
  }

  // --- cancel ----------------------------------------------------------------

  async cancel(): Promise<WorkSuccess> {
    const row = await this.row()
    if (row.hub_publication_id === null) return { report: { nothing: true } }
    const id = row.hub_publication_id
    if (row.hub_status === 'cancelled') return { report: { already: true } }
    await this.guard()
    let publication: HubPublication
    try {
      publication = await this.client.cancel(id, this.context.signal)
    } catch (error) {
      if (isHubError(error, 'refused', 'publication_handed_to_platform')) {
        throw refused(
          'publication_handed',
          'Hub уже передал публикацию в расписание площадки — снять её может только владелец в Hub',
        )
      }
      if (isHubError(error, 'refused', 'publication_not_editable')) {
        throw refused('publication_not_editable', 'Эту публикацию Hub уже не отменяет')
      }
      throw error
    }
    return {
      report: { row_id: row.id, publication_id: id, status: publication.status },
      commit: async (tx) => {
        await applyPublication(tx, this.page, row.id, publication, { force: true })
      },
    }
  }

  // --- status ----------------------------------------------------------------

  async status(): Promise<WorkSuccess> {
    const { page } = this
    const startedAt = await dbNow(this.db)
    const { rows: state } = await this.db.execute<{ watermark_at: string | null }>(sql`
      SELECT watermark_at::text FROM hub_sync_state
       WHERE model_id = ${page.modelId}::uuid AND account_id = ${page.accountId}::uuid
         AND dataset = 'publications' AND scope = 'page'`)
    const since = publicationChangesSince(state[0]?.watermark_at ?? null)
    const seen: HubPublication[] = []
    let greatest: string | null = state[0]?.watermark_at ?? null
    await this.guard()
    for await (const answer of this.client.changesSince(since, { signal: this.context.signal })) {
      for (const publication of answer.publications) {
        seen.push(publication)
        if (greatest === null || Date.parse(publication.updatedAt) > Date.parse(greatest)) {
          greatest = publication.updatedAt
        }
      }
      await this.guard()
    }
    const workId = this.context.work.id
    return {
      report: {
        since: since?.toISOString() ?? null,
        read: seen.length,
        started_at: startedAt.toISOString(),
      },
      commit: async (tx) => {
        for (const publication of seen) {
          if (publication.pageLabel && publication.pageLabel !== page.hubPage) continue
          const rowId = await rowOfPublication(tx, page, publication.id)
          if (!rowId) continue
          await applyPublication(tx, page, rowId, publication)
        }
        await linkPublished(tx, page)
        await tx.execute(sql`
          INSERT INTO hub_sync_state AS s (
            model_id, account_id, dataset, scope, watermark_at, last_success_at, hub_succeeded_at,
            last_work_id, available, unavailable_reason, last_error
          ) VALUES (
            ${page.modelId}::uuid, ${page.accountId}::uuid, 'publications', 'page',
            ${greatest}::timestamptz, ${startedAt.toISOString()}::timestamptz,
            ${startedAt.toISOString()}::timestamptz, ${workId}::uuid, true, NULL, NULL
          )
          ON CONFLICT (model_id, account_id, dataset, scope) DO UPDATE
             SET watermark_at = greatest(s.watermark_at, excluded.watermark_at),
                 last_success_at = excluded.last_success_at,
                 hub_succeeded_at = excluded.hub_succeeded_at,
                 last_work_id = excluded.last_work_id, available = true,
                 unavailable_reason = NULL, last_error = NULL, updated_at = now(),
                 row_version = s.row_version + 1`)
      },
    }
  }
}

async function dbNow(db: Queryable): Promise<Date> {
  const { rows } = await db.execute<{ now: string }>(sql`SELECT now()::text AS now`)
  return new Date((rows[0] as { now: string }).now)
}

async function isPerson(db: Queryable, principalId: string): Promise<boolean> {
  const { rows } = await db.execute<{ kind: string }>(sql`
    SELECT kind FROM principals WHERE id = ${principalId}::uuid AND disabled_at IS NULL`)
  return rows[0]?.kind === 'human'
}

/** Frames the platform may see of a file: the master's, and the built copy's when smaller. */
async function framesOf(
  db: Queryable,
  file: FileRow,
): Promise<{ width: number; height: number }[]> {
  const frames: { width: number; height: number }[] = []
  if (file.width !== null && file.height !== null)
    frames.push({ width: file.width, height: file.height })
  if (file.media_kind === 'video') {
    const { rows } = await db.execute<{ width: number | null; height: number | null }>(sql`
      SELECT a.width, a.height FROM rendition_generations g
        JOIN rendition_artifacts a ON a.generation_id = g.id AND a.name = 'platform.mp4'
       WHERE g.master_sha256 = ${file.master} AND g.kind = 'platform' AND g.state = 'ready'`)
    for (const row of rows) {
      if (row.width !== null && row.height !== null)
        frames.push({ width: row.width, height: row.height })
    }
  }
  return frames
}

/** Vault members of the page whose name starts with the object's ID (naming §5). */
async function vaultMembers(db: Queryable, page: Page, publicId: string): Promise<VaultMember[]> {
  const prefix = `${publicId.toLowerCase()}%`
  const { rows } = await db.execute<VaultMember & Record<string, unknown>>(sql`
    SELECT media_ref, custom_filename, filename, duration_ms::float8 AS duration_ms, orig_width,
           orig_height
      FROM hub_vault_media
     WHERE model_id = ${page.modelId}::uuid AND account_id = ${page.accountId}::uuid
       AND missing_since IS NULL AND media_ref IS NOT NULL
       AND (lower(custom_filename) LIKE ${prefix} OR lower(filename) LIKE ${prefix})`)
  return rows
}

function checksJson(publication: HubPublication): string {
  return JSON.stringify({
    blocked: publication.blocked,
    findings: publication.findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      media_key: finding.mediaKey,
    })),
  })
}

async function rowOfPublication(tx: Tx, page: Page, publicationId: number): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM posting_plan_rows
     WHERE model_id = ${page.modelId}::uuid AND account_id = ${page.accountId}::uuid
       AND hub_publication_id = ${publicationId}`)
  return rows[0]?.id ?? null
}

/**
 * Writes what Hub says about a row's publication; a feed row older than the one kept changes
 * nothing, the same one again writes nothing (the read is idempotent). `true` — it changed.
 */
export async function applyPublication(
  tx: Tx,
  page: Page,
  rowId: string,
  publication: HubPublication,
  options: { force?: boolean } = {},
): Promise<boolean> {
  const { rows } = await tx.execute<{
    hub_publication_id: string | null
    hub_kind: string | null
    hub_status: string | null
    hub_updated_at: string | null
    hub_version: number | null
  }>(sql`
    SELECT hub_publication_id::text, hub_kind, hub_status, hub_updated_at::text, hub_version
      FROM posting_plan_rows
     WHERE model_id = ${page.modelId}::uuid AND id = ${rowId}::uuid
     FOR UPDATE`)
  const row = rows[0]
  if (!row || Number(row.hub_publication_id) !== publication.id) return false
  const kept = row.hub_updated_at ? Date.parse(row.hub_updated_at) : Number.NEGATIVE_INFINITY
  const came = Date.parse(publication.updatedAt)
  if (came < kept) return false
  if (
    !options.force &&
    came === kept &&
    row.hub_status === publication.status &&
    row.hub_version === publication.version
  ) {
    return false
  }
  const album = row.hub_kind === 'vault_album'
  await tx.execute(sql`
    UPDATE posting_plan_rows SET
      hub_status = ${publication.status}, hub_status_reason = ${publication.statusReason},
      hub_status_at = ${publication.statusChangedAt ?? publication.updatedAt}::timestamptz,
      hub_updated_at = ${publication.updatedAt}::timestamptz, hub_version = ${publication.version},
      hub_checks = CASE WHEN ${publication.status} = 'draft' THEN ${checksJson(publication)}::jsonb
                        ELSE hub_checks END,
      platform_post_ref = ${album ? null : publication.platformPostRef},
      vault_album_ref = ${album ? (publication.vaultAlbumRef ?? publication.platformPostRef) : null}
     WHERE model_id = ${page.modelId}::uuid AND id = ${rowId}::uuid`)
  if (publication.status === 'published') await linkPublished(tx, page, rowId)
  return true
}

// ---------------------------------------------------------------------------
// The exact link: row → publication → post (SPEC §7)
// ---------------------------------------------------------------------------

interface PublishedRow extends Record<string, unknown> {
  id: string
  item_id: string | null
  item_type: string | null
  surface_id: string
  manifest_id: string | null
  slot_at: string
  hub_publication_id: string
  hub_kind: string
  hub_status_at: string | null
  hub_files: HubFile[]
  hub_sent_by: string | null
  platform_post_ref: string | null
  vault_album_ref: string | null
}

/**
 * The placement of every published row of the page that has none yet, and its exact `hub`
 * evidence once the mirror holds the post (or a member of the album): an observation is what
 * evidence points at. Repeats write nothing. Returns how many rows got something new.
 */
export async function linkPublished(tx: Tx, page: Page, onlyRow?: string): Promise<number> {
  const { rows } = await tx.execute<PublishedRow>(sql`
    SELECT r.id, r.item_id, i.type AS item_type, r.surface_id, r.manifest_id, r.slot_at::text,
           r.hub_publication_id::text, r.hub_kind, r.hub_status_at::text, r.hub_files,
           r.hub_sent_by, r.platform_post_ref, r.vault_album_ref
      FROM posting_plan_rows r
      LEFT JOIN content_items i ON i.model_id = r.model_id AND i.id = r.item_id
     WHERE r.model_id = ${page.modelId}::uuid AND r.account_id = ${page.accountId}::uuid
       AND r.hub_status = 'published'
       AND (r.platform_post_ref IS NOT NULL OR r.vault_album_ref IS NOT NULL)
       ${onlyRow ? sql`AND r.id = ${onlyRow}::uuid` : sql``}
       AND NOT EXISTS (
         SELECT 1 FROM placement_evidence e
           JOIN placements p ON p.model_id = e.model_id AND p.id = e.placement_id
          WHERE p.model_id = r.model_id AND p.plan_row_id = r.id
            AND e.dedup_key = 'publication:' || r.hub_publication_id::text)`)
  let touched = 0
  for (const row of rows) {
    if (await linkRow(tx, page, row)) touched += 1
  }
  return touched
}

async function linkRow(tx: Tx, page: Page, row: PublishedRow): Promise<boolean> {
  const dedup = `publication:${row.hub_publication_id}`
  let changed = false
  // The observation the evidence points at, and when it went out.
  let observation: {
    id: string
    at: string | null
    caption: string | null
    media: string | null
  } | null = null
  if (row.platform_post_ref) {
    const { rows } = await tx.execute<{
      id: string
      at: string | null
      caption: string | null
    }>(sql`
      SELECT current_observation_id AS id, published_at::text AS at, caption FROM hub_posts
       WHERE model_id = ${page.modelId}::uuid AND account_id = ${page.accountId}::uuid
         AND post_ref = ${row.platform_post_ref}`)
    observation = rows[0] ? { ...rows[0], media: null } : null
  } else if (row.vault_album_ref) {
    const refs = row.hub_files.flatMap((file) =>
      file.vault_media_ref ? [file.vault_media_ref] : [],
    )
    const names = row.hub_files.map((file) => file.name.replace(/\.[^.]+$/, '').toLowerCase())
    const { rows } = await tx.execute<{
      id: string
      at: string | null
      media_ref: string | null
    }>(sql`
      SELECT m.current_observation_id AS id, m.membership_at::text AS at, m.media_ref
        FROM hub_vault_media m
        JOIN hub_vault_albums al ON al.model_id = m.model_id AND al.id = m.album_id
       WHERE m.model_id = ${page.modelId}::uuid AND m.account_id = ${page.accountId}::uuid
         AND al.album_ref = ${row.vault_album_ref} AND m.missing_since IS NULL
       ORDER BY (m.media_ref = ANY(${sql.param(refs)}::text[])
                 OR lower(regexp_replace(coalesce(m.custom_filename, m.filename, ''), '\\.[^.]+$', ''))
                    = ANY(${sql.param(names)}::text[])) DESC,
                m.membership_at, m.id
       LIMIT 1`)
    observation = rows[0]
      ? { id: rows[0].id, at: rows[0].at, caption: null, media: rows[0].media_ref }
      : null
  }

  // One placement of the publication: by its post, or (an album) by the publication itself.
  const manualKey = row.platform_post_ref ? null : dedup
  const { rows: existing } = await tx.execute<{ id: string; plan_row_id: string | null }>(sql`
    SELECT id, plan_row_id FROM placements
     WHERE model_id = ${page.modelId}::uuid AND surface_id = ${row.surface_id}::uuid
       AND ${
         row.platform_post_ref
           ? sql`external_post_ref = ${row.platform_post_ref}`
           : sql`manual_key = ${manualKey}`
       }`)
  let placementId = existing[0]?.id
  const occurredAt = observation?.at ?? row.hub_status_at ?? row.slot_at
  if (!placementId) {
    const { rows: inserted } = await tx.execute<{ id: string }>(sql`
      INSERT INTO placements (
        model_id, account_id, surface_id, occurrence_kind, external_post_ref, external_album_ref,
        manual_key, item_id, item_type, plan_row_id, planned_at, occurred_at, occurred_source,
        surface_source, caption, origin, created_by
      ) VALUES (
        ${page.modelId}::uuid, ${page.accountId}::uuid, ${row.surface_id}::uuid,
        ${row.platform_post_ref ? 'post' : 'vault_member'}, ${row.platform_post_ref},
        ${row.vault_album_ref}, ${manualKey}, ${row.item_id}::uuid, ${row.item_type},
        ${row.id}::uuid, ${row.slot_at}::timestamptz, ${occurredAt}::timestamptz, 'hub', 'hub',
        ${observation?.caption ?? null}, 'plan', ${row.hub_sent_by}::uuid
      )
      RETURNING id`)
    placementId = inserted[0]?.id as string
    changed = true
    // The files of the row, exact: they went out through the publication.
    const versions = row.hub_files.filter((file) => file.role === 'media')
    for (const [index, file] of versions.entries()) {
      await tx.execute(sql`
        INSERT INTO placement_assets (model_id, placement_id, asset_id, asset_version_id, position,
                                      match_strength, matched_media_ref, bound_by)
        SELECT ${page.modelId}::uuid, ${placementId}::uuid, v.asset_id, v.id, ${index + 1},
               'exact', ${file.vault_media_ref}, ${row.hub_sent_by}::uuid
          FROM asset_versions v
         WHERE v.model_id = ${page.modelId}::uuid AND v.id = ${file.version_id}::uuid
        ON CONFLICT DO NOTHING`)
    }
  } else if (existing[0]?.plan_row_id === null) {
    // Found by the poll before the publication said so: it is this row's.
    await tx.execute(sql`
      UPDATE placements SET plan_row_id = ${row.id}::uuid,
             item_id = coalesce(item_id, ${row.item_id}::uuid),
             item_type = coalesce(item_type, ${row.item_type}), out_of_catalog = false,
             row_version = row_version + 1
       WHERE model_id = ${page.modelId}::uuid AND id = ${placementId}::uuid`)
    changed = true
  }
  if (observation?.id) {
    const { rowCount } = await tx.execute(sql`
      INSERT INTO placement_evidence (model_id, placement_id, source, kind, strength,
                                      hub_observation_id, external_ref, payload, event_at, dedup_key)
      VALUES (${page.modelId}::uuid, ${placementId}::uuid, 'hub', 'observed', 'exact',
              ${observation.id}::uuid, ${row.platform_post_ref ?? row.vault_album_ref},
              ${JSON.stringify({ via: 'publication', publication_id: Number(row.hub_publication_id), media_ref: observation.media })}::jsonb,
              ${observation.at}::timestamptz, ${dedup})
      ON CONFLICT DO NOTHING`)
    if ((rowCount ?? 0) > 0) changed = true
  }
  return changed
}
