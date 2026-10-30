import { randomUUID } from 'node:crypto'
import { addDays } from '@contentops/contracts/clock'
import type { NewPlanRow } from '@contentops/contracts/commands/plan'
import { IssuedTokenSchema } from '@contentops/contracts/domain/agents'
import { type PlanRow, PlanRowSchema } from '@contentops/contracts/domain/plan'
import { type Db, enqueueWork, resumeSwitch, SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { type FakeHub, fakeRow, startFakeHub } from '@contentops/hub/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCatalogItems } from '../testing/catalog-factory'
import {
  addPerson,
  call,
  newKey,
  OWNER,
  signIn,
  type TestServer,
  testServer,
} from '../testing/server'
import { hubPublishHandler, publicationStreams } from './publish'
import type { PublishMedia } from './publish-media'
import { hubSyncHandler } from './sync'
import {
  fakeClient,
  type PageIds,
  pageIds,
  post,
  runHubWork,
  setHubPage,
  setReceive,
  syncOnce,
} from './testing'

/**
 * PLAN 5б, SPEC §7 «Публикация через Hub», §8, §11.1 on a fake Hub: «Подготовить» uploads only
 * what Hub lacks (a repeat uploads nothing), reuses the very same file from the page's vault,
 * shows Hub's checks; an agent prepares but never sends, a person's «Отправить» approves once;
 * the own cancel before the hand-off and the owner-only after it; the statuses of the feed
 * mapped onto the row, «не удалось проверить — решает владелец в Hub» included; the exact
 * placement from `platformPostRef` without matching; the switch with a pending work; OnlyFans
 * only from its vault; a mass message by hand; a price post held until the price ranges exist.
 * Nothing here reaches a real Hub: every name, ref and caption is fictional.
 */

let server: TestServer
let db: Db
let hub: FakeHub
let owner: string
let diana: { id: string; session: string }
let agent: string
let agentId: string
let lora1: PageIds
let loraOf: PageIds

const TODAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })
const day = (offset: number) => addDays(TODAY, offset)

/** Bytes «for the platform» of a file version; a version in `building` is not built yet. */
const building = new Set<string>()
const mediaCalls: string[] = []
const media: PublishMedia = {
  async bytes(_db, { file }) {
    mediaCalls.push(file.version_id)
    if (building.has(file.version_id)) {
      building.delete(file.version_id)
      return 'building'
    }
    const bytes = Buffer.from(`fictional platform bytes of ${file.version_id}`)
    const { createHash } = await import('node:crypto')
    return {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      width: file.width,
      height: file.height,
      durationMs: file.duration_ms === null ? null : Number(file.duration_ms),
      open: () => new Blob([bytes]).stream() as ReadableStream<Uint8Array>,
      release: async () => {},
    }
  },
}

const publishOptions = () => ({ client: () => fakeClient(hub).client, media, waitMs: 20 })
const publish = () => hubPublishHandler(publishOptions())

beforeAll(async () => {
  server = await testServer({ secrets: { hub: true } })
  db = server.db
  hub = await startFakeHub()
  hub.setNow(new Date())
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  diana = await addPerson(server.app, owner, {
    name: 'Диана',
    login: 'diana',
    role: 'manager',
    models: ['lora'],
  })
  lora1 = await pageIds(db, 'lora-1')
  loraOf = await pageIds(db, 'lora-of')
  await setHubPage(db, 'lora-1', 'page-a')
  await setHubPage(db, 'lora-of', 'page-b')
  await setPublish(lora1, true)
  await setPublish(loraOf, true)
  await setReceive(db, lora1, true)
  await setReceive(db, loraOf, true)
  await createCatalogItems(db, 'lora', [
    {
      type: 'ppv',
      number: 73,
      title: 'Вечеринка',
      ppvKind: 'bundle',
      secondPerson: false,
      files: [{ role: 'master', durationS: 804 }, { role: 'teaser' }, { role: 'pic' }],
    },
    {
      type: 'ppv',
      number: 76,
      title: 'Нейлон',
      ppvKind: 'bundle',
      secondPerson: false,
      files: [{ role: 'master', durationS: 410 }, { role: 'teaser' }],
    },
    {
      type: 'set',
      number: 74,
      title: 'Кружево',
      secondPerson: false,
      files: [
        { role: 'ed', selected: true },
        { role: 'ed', selected: true },
      ],
    },
    {
      type: 'fyp',
      number: 801,
      title: 'Зеркало',
      secondPerson: false,
      files: [{ role: 'master', durationS: 9 }],
    },
  ])
  // The agent of the plan: it prepares, it never sends.
  await call(server.app, {
    method: 'PATCH',
    url: '/api/v1/admin/integrations/agents',
    as: owner,
    key: newKey(),
    body: { switches: { enabled: true } },
  })
  const added = await call(server.app, {
    method: 'POST',
    url: '/api/v1/admin/agents',
    as: owner,
    key: newKey(),
    body: { name: 'Планировщик', role: 'manager', models: ['lora'] },
  })
  agentId = added.json().id
  const token = await call(server.app, {
    method: 'POST',
    url: `/api/v1/admin/agents/${agentId}/tokens`,
    as: owner,
    key: newKey(),
    body: { agent_id: agentId, expires_in_days: null },
  })
  agent = `Bearer ${IssuedTokenSchema.parse(token.json()).secret}`
})
afterAll(async () => {
  await hub?.close()
  await server?.close()
})

async function setPublish(page: PageIds, on: boolean): Promise<void> {
  await withActorTx(
    db,
    { actor: SYSTEM_ACTOR('test'), action: 'test.switch', requestId: randomUUID() },
    async (tx) => {
      await tx.execute(sql`
        INSERT INTO policy_settings (model_id, account_id, key, value)
        VALUES (${page.modelId}::uuid, ${page.accountId}::uuid, 'hub.publish', ${JSON.stringify(on)}::jsonb)
        ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE SET value = excluded.value`)
      if (on) await resumeSwitch(tx, 'hub.publish')
    },
  )
}

function newRow(patch: Partial<NewPlanRow>): NewPlanRow {
  return {
    item_id: 'PPV-073',
    account: 'lora-1',
    surface: 'wall',
    date: day(2),
    time: '20:00',
    fyp_version: null,
    assignee: null,
    note: null,
    requires_new_upload: false,
    awaiting_montage: null,
    marked: null,
    ...patch,
  }
}

async function put(row: Partial<NewPlanRow>, fields: Record<string, unknown> = {}) {
  const response = await call(server.app, {
    method: 'POST',
    url: '/api/v1/lora/plan/rows',
    as: diana.session,
    key: newKey(),
    body: { rows: [newRow(row)] },
  })
  expect(response.statusCode, response.body).toBe(201)
  const created = PlanRowSchema.parse(response.json().rows[0])
  if (Object.keys(fields).length === 0) return created
  const patched = await call(server.app, {
    method: 'PATCH',
    url: `/api/v1/lora/plan/rows/${created.id}`,
    as: diana.session,
    key: newKey(),
    ifMatch: created.version,
    body: fields,
  })
  expect(patched.statusCode, patched.body).toBe(200)
  return PlanRowSchema.parse(patched.json())
}

async function rowOf(id: string, as = diana.session): Promise<PlanRow> {
  const response = await call(server.app, {
    method: 'GET',
    url: `/api/v1/lora/plan/rows/${id}`,
    as,
  })
  expect(response.statusCode, response.body).toBe(200)
  return PlanRowSchema.parse(response.json())
}

async function command(row: string, verb: string, as = diana.session, body?: unknown) {
  return call(server.app, {
    method: 'POST',
    url: `/api/v1/lora/plan/rows/${row}:${verb}`,
    as,
    key: newKey(),
    ...(body === undefined ? {} : { body }),
  })
}

async function lastWork(rowId: string): Promise<string> {
  const { rows } = await db.execute<{ id: string }>(sql`
    SELECT id FROM work_operations WHERE kind = 'hub_publish' AND scope = ${`row:${rowId}`}
     ORDER BY created_at DESC LIMIT 1`)
  const id = rows[0]?.id
  if (!id) throw new Error(`no work of row ${rowId}`)
  return id
}

const runRow = async (rowId: string) =>
  runHubWork(db, await lastWork(rowId), publish(), { kind: 'hub_publish' })

/** «Подготовить» through the route and the work, the row as it answers then. */
async function prepared(rowId: string, as = diana.session): Promise<PlanRow> {
  const response = await command(rowId, 'prepare', as)
  expect(response.statusCode, response.body).toBe(202)
  expect(PlanRowSchema.parse(response.json()).hub?.pending).toBe('prepare')
  const outcome = await runRow(rowId)
  expect(outcome.state, outcome.error_text ?? '').toBe('succeeded')
  return rowOf(rowId)
}

/** «Отправить» by Диана with the version of the draft she sees. */
async function sent(row: PlanRow): Promise<PlanRow> {
  const response = await command(row.id, 'send', diana.session, { version: versionOf(row) })
  expect(response.statusCode, response.body).toBe(202)
  const outcome = await runRow(row.id)
  expect(outcome.state, outcome.error_text ?? '').toBe('succeeded')
  return rowOf(row.id)
}

function versionOf(row: PlanRow): number {
  const version = row.hub?.publication?.version
  if (!version) throw new Error('the row has no draft')
  return version
}

/** A PPV release with its story cell: stories are put only as the teaser of a release. */
async function putStory(date: string, time: string): Promise<PlanRow> {
  const response = await call(server.app, {
    method: 'POST',
    url: '/api/v1/lora/plan/releases',
    as: diana.session,
    key: newKey(),
    body: {
      item_id: 'PPV-073',
      cells: [{ account: 'lora-1', surface: 'story', date, time }],
    },
  })
  expect(response.statusCode, response.body).toBe(201)
  return PlanRowSchema.parse(response.json().rows[0])
}

/** One 10-minute read of the statuses of a page. */
async function statuses(page: PageIds) {
  const { work } = await withActorTx(
    db,
    { actor: SYSTEM_ACTOR('test'), action: 'test.enqueue', requestId: randomUUID() },
    (tx) =>
      enqueueWork(tx, {
        modelId: page.modelId,
        kind: 'hub_publish',
        workKey: `hubpub:${page.accountId}@test-${randomUUID()}`,
        accountId: page.accountId,
        dataset: 'status',
        streamKey: `hubpub:${page.accountId}`,
      }),
  )
  const outcome = await runHubWork(db, work.id, publish(), { kind: 'hub_publish' })
  expect(outcome.state, outcome.error_text ?? '').toBe('succeeded')
  return outcome
}

function publicationOf(row: PlanRow) {
  const id = row.hub?.publication?.id
  if (!id) throw new Error('the row has no publication')
  return hub.publication(id)
}

describe('«Подготовить»', () => {
  it('uploads the platform copy under its download name and makes a draft from the row', async () => {
    const row = await put({}, { caption: 'Fictional caption', repost: false })
    expect(row.hub).toMatchObject({ enabled: true, manual: null, can_prepare: true })
    const uploads = hub.calls('publication-files').length
    const after = await prepared(row.id)
    expect(hub.calls('publication-files').length).toBe(uploads + 1)
    const upload = hub.calls('publication-files').at(-1)
    const name = upload?.query.get('name') ?? ''
    expect(name).toMatch(/^PPV-073_.*_master__lora-1_\d{4}-\d{2}-\d{2}_2000__13m24s\.mp4$/)
    const publication = publicationOf(after)
    expect(publication).toMatchObject({
      kind: 'subscriber_post',
      status: 'draft',
      text: 'Fictional caption',
      priceMills: null,
    })
    expect(publication.media.map((m) => m.source)).toEqual(['file'])
    expect(after.hub?.publication).toMatchObject({
      state: 'draft',
      kind: 'subscriber_post',
      blocked: false,
      stale: false,
      files: [{ name, source: 'upload' }],
    })
    expect(after.hub).toMatchObject({ can_send: true, pending: null, error: null })
    // The row waits for «Отправить»: still in the plan.
    expect(after.verdict.level).toBe('planned')
  })

  it('a repeat uploads nothing new and makes no second draft', async () => {
    const row = await put({ item_id: 'PPV-076', time: '21:00' })
    const first = await prepared(row.id)
    const uploads = hub.calls('publication-files').length
    const drafts = hub.calls('publications.create').length
    const again = await prepared(row.id)
    expect(hub.calls('publication-files').length).toBe(uploads)
    expect(hub.calls('publications.create').length).toBe(drafts)
    expect(again.hub?.publication?.id).toBe(first.hub?.publication?.id)
    // Hub answers the same bytes with the same file: the accounting is by SHA-256.
    const { rows } = await db.execute<{ files: { sha256: string; file_id: number }[] }>(sql`
      SELECT hub_files AS files FROM posting_plan_rows WHERE id = ${row.id}::uuid`)
    expect(rows[0]?.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[0]?.files[0]?.file_id).toBeGreaterThan(0)
  })

  it('a changed row makes a new draft and takes the old one off', async () => {
    const row = await put({ item_id: 'FYP-0801', surface: 'fyp', time: '03:00' })
    const first = await prepared(row.id)
    const changed = await call(server.app, {
      method: 'PATCH',
      url: `/api/v1/lora/plan/rows/${row.id}`,
      as: diana.session,
      key: newKey(),
      ifMatch: first.version,
      body: { caption: 'Another fictional caption' },
    })
    expect(changed.statusCode, changed.body).toBe(200)
    const stale = PlanRowSchema.parse(changed.json())
    expect(stale.hub?.publication?.stale).toBe(true)
    expect(stale.hub?.can_send).toBe(false)
    const refused = await command(row.id, 'send', diana.session, { version: 1 })
    expect(refused.statusCode).toBe(422)
    const again = await prepared(row.id)
    expect(again.hub?.publication?.id).not.toBe(first.hub?.publication?.id)
    expect(hub.publication(first.hub?.publication?.id as number).status).toBe('cancelled')
    expect(publicationOf(again)).toMatchObject({
      kind: 'fyp_post',
      text: 'Another fictional caption',
    })
  })

  it('waits for the platform copy while it is being built', async () => {
    const row = await put({ item_id: 'SET-074', time: '18:00' })
    const files = await db.execute<{ version_id: string }>(sql`
      SELECT e.asset_version_id AS version_id FROM asset_manifest_entries e
        JOIN posting_plan_rows r ON r.model_id = e.model_id AND r.manifest_id = e.manifest_id
       WHERE r.id = ${row.id}::uuid ORDER BY e.position LIMIT 1`)
    const first = files.rows[0]?.version_id as string
    building.add(first)
    const after = await prepared(row.id)
    expect(building.has(first)).toBe(false)
    expect(mediaCalls.filter((id) => id === first).length).toBeGreaterThanOrEqual(2)
    expect(after.hub?.publication?.files).toHaveLength(2)
    expect(publicationOf(after).media).toHaveLength(2)
  })

  it('takes the very same file from the page’s vault instead of uploading it', async () => {
    const row = await put({ item_id: 'PPV-076', surface: 'vault', date: day(3), time: '12:00' })
    const name = row.manifest?.files.find((file) => file.key === 'platform')?.download_name ?? ''
    // The same download name without the page suffix, the same frame and length.
    const bare = name.replace(/__lora-1_[^_]+_\d{4}/, '')
    const vaultRow = fakeRow('vault_media', 'album-v:member-v', {
      platform: 'fansly',
      vaultKind: 'creator',
      albumRef: 'album-v',
      albumTitle: 'PPV-076 Нейлон',
      lastFullWalkAt: new Date().toISOString(),
      fullWalkRef: 'walk-v',
      fullWalkObservedCount: 1,
      customFilename: bare,
      filename: bare,
      mimeType: 'video/mp4',
      mediaRef: 'media-vault-76',
      memberRef: 'member-v',
      durationMs: 410_200,
      originalWidth: 2160,
      originalHeight: 3840,
      firstObservedAt: new Date().toISOString(),
    })
    hub.put('vault_media', 'page-a', [vaultRow])
    const synced = await syncOnce(db, lora1, 'vault_media', {
      client: () => fakeClient(hub).client,
    })
    expect(synced.state, synced.error_text ?? '').toBe('succeeded')
    const uploads = hub.calls('publication-files').length
    const after = await prepared(row.id)
    expect(hub.calls('publication-files').length).toBe(uploads)
    const publication = publicationOf(after)
    expect(publication.kind).toBe('vault_album')
    expect(publication.text).toBe('PPV-076 Нейлон')
    expect(publication.media).toEqual([
      expect.objectContaining({ source: 'vault', mediaRef: 'media-vault-76' }),
    ])
    expect(after.hub?.publication?.files[0]?.source).toBe('vault')
    expect(after.hub?.publication?.checks).toEqual([])
  })
})

describe('checks and «Отправить»', () => {
  it('a price post is held with Hub’s check in words until the owner sets the price ranges', async () => {
    const row = await put(
      { item_id: 'PPV-073', date: day(4), time: '20:00' },
      { price_mills: 12_000 },
    )
    const after = await prepared(row.id)
    expect(publicationOf(after).kind).toBe('paid_post')
    // A paid PPV post shows its teaser before the purchase.
    expect(publicationOf(after).media.map((m) => m.role)).toEqual(['media', 'preview'])
    expect(after.hub?.publication?.blocked).toBe(true)
    expect(after.hub?.publication?.checks).toEqual([
      expect.objectContaining({
        code: 'price_range_not_set',
        severity: 'blocking',
        text: expect.stringContaining('вилка цен страницы не задана'),
      }),
    ])
    expect(after.hub?.can_send).toBe(false)
    const approves = hub.calls('publications.approve').length
    const refused = await command(row.id, 'send', diana.session, { version: versionOf(after) })
    expect(refused.statusCode).toBe(422)
    expect(refused.json()).toMatchObject({
      code: 'publication_blocked',
      message: expect.stringContaining('вилка цен'),
    })
    expect(hub.calls('publications.approve').length).toBe(approves)
  })

  it('an agent prepares but never sends — by the route and by the work', async () => {
    const row = await put({ item_id: 'FYP-0801', surface: 'fyp', date: day(4), time: '03:00' })
    const after = await prepared(row.id, agent)
    expect(after.hub?.publication?.prepared.by.type).toBe('agent')
    const approves = hub.calls('publications.approve').length
    const refused = await command(row.id, 'send', agent, { version: versionOf(after) })
    expect(refused.statusCode).toBe(403)
    expect(refused.json().message).toContain('только человек')
    // A send work naming the agent, queued around the route, is refused by the work too.
    const { work } = await withActorTx(
      db,
      { actor: SYSTEM_ACTOR('test'), action: 'test.enqueue', requestId: randomUUID() },
      (tx) =>
        enqueueWork(tx, {
          modelId: lora1.modelId,
          kind: 'hub_publish',
          workKey: `hubpub:${row.id}:send:test-${randomUUID()}`,
          accountId: lora1.accountId,
          dataset: 'send',
          scope: `row:${row.id}`,
          streamKey: `hubpub-row:${row.id}`,
          checkpoint: { rowId: row.id, principalId: agentId, version: versionOf(after) },
        }),
    )
    const outcome = await runHubWork(db, work.id, publish(), { kind: 'hub_publish' })
    expect(outcome).toMatchObject({ state: 'failed', error_code: 'agent_cannot_send' })
    expect(hub.calls('publications.approve').length).toBe(approves)
    expect(publicationOf(after).status).toBe('draft')
  })

  it('a person’s «Отправить» approves the version they saw, once', async () => {
    const row = await put({ item_id: 'SET-074', date: day(5), time: '19:00' })
    const draft = await prepared(row.id)
    const approves = hub.calls('publications.approve').length
    const stale = await command(row.id, 'send', diana.session, { version: 99 })
    expect(stale.statusCode).toBe(412)
    const after = await sent(draft)
    expect(hub.calls('publications.approve').length).toBe(approves + 1)
    expect(publicationOf(after).status).toBe('approved')
    expect(after.hub?.publication).toMatchObject({
      state: 'sent',
      sent: { by: { name: 'Диана' } },
    })
    expect(after.verdict).toMatchObject({ level: 'scheduled', word: 'отправлено' })
    expect(after.verdict.reason).toContain('Hub поставит в расписание за 7 дней до выхода')
    expect(after.hub).toMatchObject({ can_send: false, can_prepare: false, can_cancel: true })
    const again = await command(row.id, 'send', diana.session, { version: 1 })
    expect(again.statusCode).toBe(422)
    expect(hub.calls('publications.approve').length).toBe(approves + 1)
    // A sent row keeps its slot.
    const moved = await call(server.app, {
      method: 'POST',
      url: `/api/v1/lora/plan/rows/${row.id}:move`,
      as: diana.session,
      key: newKey(),
      ifMatch: after.version,
      body: { date: day(6), time: '19:00', account: 'lora-1' },
    })
    expect(moved.statusCode).toBe(422)
  })
})

describe('cancel', () => {
  it('ContentOps takes its own publication off before the hand-off', async () => {
    const row = await putStory(day(6), '12:00')
    const after = await sent(await prepared(row.id))
    expect(publicationOf(after).kind).toBe('story')
    const response = await command(row.id, 'cancel-publication')
    expect(response.statusCode, response.body).toBe(202)
    const outcome = await runRow(row.id)
    expect(outcome.state, outcome.error_text ?? '').toBe('succeeded')
    const cancelled = await rowOf(row.id)
    expect(publicationOf(cancelled).status).toBe('cancelled')
    expect(cancelled.hub?.publication?.state).toBe('cancelled')
    // The row is back in the plan: prepare again or post by hand.
    expect(cancelled.verdict.level).toBe('planned')
    expect(cancelled.hub?.can_prepare).toBe(true)
  })

  it('after the hand-off only the owner, in Hub — the route and the work say so', async () => {
    const row = await put({ item_id: 'SET-074', date: day(7), time: '19:00' })
    const after = await sent(await prepared(row.id))
    // Hub hands it over before ContentOps has read the status: the work hears the refusal.
    hub.handToPlatform(publicationOf(after).id)
    const queued = await command(row.id, 'cancel-publication')
    expect(queued.statusCode).toBe(202)
    const outcome = await runRow(row.id)
    expect(outcome).toMatchObject({ state: 'failed', error_code: 'publication_handed' })
    const failed = await rowOf(row.id)
    expect(failed.hub?.error).toContain('только владелец в Hub')
    // Once the status is read, the route refuses at once; so does «Отменить строку».
    await statuses(lora1)
    const scheduled = await rowOf(row.id)
    expect(scheduled.verdict.word).toBe('в расписании')
    expect(scheduled.hub?.can_cancel).toBe(false)
    const refused = await command(row.id, 'cancel-publication')
    expect(refused.statusCode).toBe(422)
    expect(refused.json()).toMatchObject({
      code: 'publication_handed',
      message: expect.stringContaining('только владелец в Hub'),
    })
    const rowCancel = await command(row.id, 'cancel', diana.session, { reason: null })
    expect(rowCancel.statusCode).toBe(422)
    expect(rowCancel.json().code).toBe('publication_handed')
  })
})

describe('statuses every 10 minutes', () => {
  it('maps Hub’s statuses onto the row, idempotently', async () => {
    const scheduledRow = await sent(
      await prepared((await put({ item_id: 'PPV-073', date: day(8), time: '20:00' })).id),
    )
    const unknownRow = await sent(
      await prepared((await put({ item_id: 'PPV-076', date: day(8), time: '21:00' })).id),
    )
    const failedRow = await sent(
      await prepared((await put({ item_id: 'SET-074', date: day(8), time: '22:00' })).id),
    )
    hub.handToPlatform(publicationOf(scheduledRow).id)
    hub.handToPlatform(publicationOf(unknownRow).id)
    hub.markUnknown(publicationOf(unknownRow).id)
    hub.handToPlatform(publicationOf(failedRow).id)
    hub.notPublish(publicationOf(failedRow).id, 'upload_failed')
    const streams = await publicationStreams(db, { configured: true })
    expect(streams.map((stream) => stream.streamKey)).toContain(`hubpub:${lora1.accountId}`)
    expect(streams[0]?.intervalMs).toBe(10 * 60_000)
    await statuses(lora1)
    const scheduled = await rowOf(scheduledRow.id)
    expect(scheduled.verdict).toMatchObject({ level: 'scheduled', word: 'в расписании' })
    expect(scheduled.verdict.reason).toContain('Hub поставил в расписание Fansly 1')
    expect(scheduled.hub?.statuses_at).not.toBeNull()
    const unknown = await rowOf(unknownRow.id)
    expect(unknown.verdict).toMatchObject({
      level: 'cannot_verify',
      word: 'не удалось проверить',
      detail: 'решает владелец в Hub',
    })
    const failed = await rowOf(failedRow.id)
    expect(failed.verdict).toMatchObject({
      level: 'not_published',
      sign: 'trouble',
      word: 'не вышло',
      detail: 'файл не загрузился',
    })
    // «Подготовить» заново after «не вышло».
    expect(failed.hub?.can_prepare).toBe(true)
    // The same feed again changes nothing: no journal rows for the rows.
    const journal = async () => {
      const { rows } = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM action_log
         WHERE subject_kind = 'posting_plan_rows'
           AND subject_id = ANY(${sql.param([scheduledRow.id, unknownRow.id, failedRow.id])}::uuid[])`)
      return rows[0]?.n ?? 0
    }
    const before = await journal()
    await statuses(lora1)
    expect(await journal()).toBe(before)
  })

  it('a published post is linked exactly through the publication, never matched', async () => {
    const row = await sent(
      await prepared(
        (await put({ item_id: 'FYP-0801', surface: 'fyp', date: day(9), time: '03:00' })).id,
      ),
    )
    const id = publicationOf(row).id
    hub.handToPlatform(id)
    hub.publish(id, 'post-pub-1')
    await statuses(lora1)
    const published = await rowOf(row.id)
    expect(published.verdict).toMatchObject({
      level: 'confirmed_exact',
      sign: 'done',
      word: 'вышло',
      detail: 'Hub',
    })
    expect(published.hub?.publication?.post_ref).toBe('post-pub-1')
    const placement = async () => {
      const { rows } = await db.execute<{
        id: string
        plan_row_id: string
        surface_source: string
        evidence: number
        assets: number
        skipped: boolean
      }>(sql`
        SELECT p.id, p.plan_row_id, p.surface_source,
               (SELECT count(*)::int FROM placement_evidence e
                 WHERE e.placement_id = p.id AND e.source = 'hub' AND e.strength = 'exact'
                   AND e.dedup_key = ${`publication:${id}`}) AS evidence,
               (SELECT count(*)::int FROM placement_assets a
                 WHERE a.placement_id = p.id AND a.match_strength = 'exact') AS assets,
               is_publication_post(p.model_id, p.account_id, p.external_post_ref) AS skipped
          FROM placements p WHERE p.external_post_ref = 'post-pub-1'`)
      return rows
    }
    // Hub has not shown the post yet: the placement is there, the evidence waits for it.
    expect(await placement()).toEqual([
      expect.objectContaining({
        plan_row_id: row.id,
        surface_source: 'hub',
        evidence: 0,
        assets: 1,
        skipped: true,
      }),
    ])
    hub.put('posts', 'page-a', [post('post-pub-1', new Date().toISOString(), '', 1)])
    const synced = await syncOnce(db, lora1, 'posts', { client: () => fakeClient(hub).client })
    expect(synced.state, synced.error_text ?? '').toBe('succeeded')
    await statuses(lora1)
    expect(await placement()).toEqual([expect.objectContaining({ evidence: 1, assets: 1 })])
    // Again: nothing new.
    await statuses(lora1)
    expect(await placement()).toEqual([expect.objectContaining({ evidence: 1 })])
  })
})

describe('the page and the platform', () => {
  it('«Публикация» off: the buttons go, a pending work waits, the row is posted by hand', async () => {
    const row = await put({ item_id: 'PPV-076', date: day(10), time: '20:00' })
    const queued = await command(row.id, 'prepare')
    expect(queued.statusCode).toBe(202)
    await setPublish(lora1, false)
    const calls = hub.requests.length
    const held = await runHubWork(db, await lastWork(row.id), publish(), {
      kind: 'hub_publish',
      claim: false,
    })
    expect(held.paused_reason).toBe('switch_off:hub.publish')
    expect(hub.requests.length).toBe(calls)
    const off = await rowOf(row.id)
    expect(off.hub).toMatchObject({ enabled: false, pending: 'prepare', can_prepare: false })
    expect(off.hub?.error).toContain('выключена')
    // The manual flow stays: the row is marked as before.
    expect(['mark', 'mark_confirm']).toContain(off.mark_button)
    const refused = await command(row.id, 'prepare')
    expect(refused.statusCode).toBe(422)
    expect(refused.json().message).toContain('выкладывают руками')
    const other = await put({ item_id: 'SET-074', date: day(10), time: '21:00' })
    expect(other.hub).toBeNull()
    await setPublish(lora1, true)
    const outcome = await runRow(row.id)
    expect(outcome.state, outcome.error_text ?? '').toBe('succeeded')
    expect(hub.requests.length).toBeGreaterThan(calls)
  })

  it('OnlyFans publishes only files already in its vault', async () => {
    const row = await put({ item_id: 'PPV-076', account: 'lora-of', date: day(11), time: '20:00' })
    const uploads = hub.calls('publication-files').length
    const queued = await command(row.id, 'prepare')
    expect(queued.statusCode, queued.body).toBe(202)
    const outcome = await runRow(row.id)
    expect(outcome).toMatchObject({ state: 'failed', error_code: 'onlyfans_vault_only' })
    expect((await rowOf(row.id)).hub?.error).toContain('только файлы, уже лежащие в vault')
    expect(hub.calls('publication-files').length).toBe(uploads)
    // The same file in the OnlyFans vault: it goes by reference, nothing is uploaded.
    const name = row.manifest?.files.find((file) => file.key === 'platform')?.download_name ?? ''
    hub.put('vault_media', 'page-b', [
      fakeRow('vault_media', 'of-album:of-member', {
        platform: 'onlyfans',
        vaultKind: 'creator',
        albumRef: 'of-album',
        albumTitle: 'Vault',
        customFilename: name,
        filename: name,
        mimeType: 'video/mp4',
        mediaRef: 'of-media-76',
        memberRef: 'of-member',
        durationMs: 410_000,
        firstObservedAt: new Date().toISOString(),
      }),
    ])
    const synced = await runHubWork(
      db,
      await (async () => {
        const { work } = await withActorTx(
          db,
          { actor: SYSTEM_ACTOR('test'), action: 'test.enqueue', requestId: randomUUID() },
          (tx) =>
            enqueueWork(tx, {
              modelId: loraOf.modelId,
              kind: 'hub_sync',
              workKey: `hub:${loraOf.accountId}:vault_media@test-${randomUUID()}`,
              accountId: loraOf.accountId,
              dataset: 'vault_media',
              streamKey: `hub:${loraOf.accountId}:vault_media`,
            }),
        )
        return work.id
      })(),
      hubSyncHandler({ client: () => fakeClient(hub).client }),
    )
    expect(synced.state, synced.error_text ?? '').toBe('succeeded')
    const after = await prepared(row.id)
    expect(hub.calls('publication-files').length).toBe(uploads)
    expect(publicationOf(after)).toMatchObject({ kind: 'subscriber_post', platform: 'onlyfans' })
    expect(publicationOf(after).media).toEqual([
      expect.objectContaining({ source: 'vault', mediaRef: 'of-media-76' }),
    ])
  })

  it('a mass message goes by hand only; OnlyFans has no FYP or vault through Hub', async () => {
    const row = await put({ item_id: 'PPV-076', surface: 'dm', date: day(12), time: '20:00' })
    expect(row.hub).toMatchObject({ manual: 'Рассылку Hub не отправляет — только вручную' })
    expect(row.hub?.can_prepare).toBe(false)
    const refused = await command(row.id, 'prepare')
    expect(refused.statusCode).toBe(422)
    expect(refused.json()).toMatchObject({
      code: 'publication_refused',
      message: 'Рассылку Hub не отправляет — только вручную',
    })
    const vault = await put({
      item_id: 'PPV-076',
      account: 'lora-of',
      surface: 'vault',
      date: day(12),
      time: '21:00',
    })
    expect(vault.hub?.manual).toContain('Vault OnlyFans')
  })

  it('the publication of a row reads as it stands', async () => {
    const row = await put({ item_id: 'SET-074', date: day(13), time: '19:00' })
    const response = await call(server.app, {
      method: 'GET',
      url: `/api/v1/lora/plan/rows/${row.id}/publication`,
      as: agent,
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ enabled: true, publication: null, can_prepare: true })
  })
})
