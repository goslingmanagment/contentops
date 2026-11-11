import { randomBytes, randomUUID } from 'node:crypto'
import { addDays, isoWeekOf, weekDates } from '@contentops/contracts/clock'
import type { NewPlanRow } from '@contentops/contracts/commands/plan'
import { IssuedTokenSchema } from '@contentops/contracts/domain/agents'
import { type PlanRow, PlanRowSchema, PlanWeekSchema } from '@contentops/contracts/domain/plan'
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
  workOutcome,
} from './testing'

/**
 * PLAN 5б, SPEC §7 «Публикация через Hub», §8, §11.1 on a fake Hub: «Подготовить» uploads only
 * what Hub lacks (a repeat uploads nothing), reuses the very same file from the page's vault,
 * shows Hub’s checks; an agent sends only free rows of a week the owner approved («Утвердить
 * неделю», 11.11.2026), once per approval; a person’s «Отправить» approves once;
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

/** «Утвердить неделю» of lora-1 with the versions of the rows as they are given. */
async function approveWeek(rows: readonly PlanRow[], as = owner) {
  const response = await call(server.app, {
    method: 'POST',
    url: `/api/v1/lora/plan/weeks/${isoWeekOf((rows[0] as PlanRow).date)}:approve`,
    as,
    key: newKey(),
    body: { account: 'lora-1', rows: rows.map((row) => ({ id: row.id, version: row.version })) },
  })
  if (as === owner) expect(response.statusCode, response.body).toBe(200)
  return response
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

  it('an agent sends a free row only after the owner approved its week, and once', async () => {
    const row = await put({ item_id: 'FYP-0801', surface: 'fyp', date: day(4), time: '03:00' })
    const after = await prepared(row.id, agent)
    expect(after.hub?.publication?.prepared.by.type).toBe('agent')
    expect(after.hub?.agent_send).toEqual({ allowed: false, reason: 'not_approved' })
    const approves = hub.calls('publications.approve').length
    const refused = await command(row.id, 'send', agent, { version: versionOf(after) })
    expect(refused.statusCode).toBe(403)
    expect(refused.json()).toMatchObject({
      code: 'forbidden',
      details: { reason: 'not_approved' },
      message: expect.stringContaining('не утверждал владелец'),
    })
    expect(hub.calls('publications.approve').length).toBe(approves)

    const approved = await approveWeek([after])
    expect(approved.json().results).toEqual([{ id: row.id, ok: true, code: null }])
    const stamped = await rowOf(row.id, agent)
    // The stamp changes no version.
    expect(stamped.version).toBe(after.version)
    expect(stamped.approval).toMatchObject({ by: { name: 'Дмитрий' }, current: true })
    expect(stamped.hub?.agent_send).toEqual({ allowed: true, reason: null })
    const queued = await command(row.id, 'send', agent, { version: versionOf(after) })
    expect(queued.statusCode, queued.body).toBe(202)
    const outcome = await runRow(row.id)
    expect(outcome.state, outcome.error_text ?? '').toBe('succeeded')
    expect(hub.calls('publications.approve').length).toBe(approves + 1)
    const sentRow = await rowOf(row.id)
    expect(sentRow.hub?.publication?.sent?.by.type).toBe('agent')
    // The approval went on this send: the row needs the owner again.
    expect(sentRow.approval).toBeNull()
    expect(sentRow.hub?.agent_send).toEqual({ allowed: false, reason: 'spent' })
    const again = await command(row.id, 'send', agent, { version: versionOf(after) })
    expect(again.statusCode).toBe(403)
    expect(again.json().details).toEqual({ reason: 'spent' })
    expect(hub.calls('publications.approve').length).toBe(approves + 1)
  })

  it('a send work naming an agent without its token is refused by the work', async () => {
    const row = await put({ item_id: 'FYP-0801', surface: 'fyp', date: day(4), time: '04:00' })
    const after = await prepared(row.id, agent)
    await approveWeek([after])
    const approves = hub.calls('publications.approve').length
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
    expect(outcome).toMatchObject({ state: 'failed', error_code: 'agent_off' })
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

describe('«Подготовить 12» and «Отправить 12»', () => {
  async function batch(verb: 'prepare' | 'send', body: unknown, as = diana.session) {
    return call(server.app, {
      method: 'POST',
      url: `/api/v1/lora/plan/rows:${verb}`,
      as,
      key: newKey(),
      body,
    })
  }

  it('each row on its own: a row Hub does not publish stays with its code, the rest go', async () => {
    const wall = await put({ item_id: 'SET-074', date: day(14), time: '19:00' })
    const paid = await put(
      { item_id: 'PPV-076', date: day(14), time: '20:00' },
      { price_mills: 9_000 },
    )
    const dm = await put({ item_id: 'PPV-076', surface: 'dm', date: day(14), time: '21:00' })
    const prepared = await batch('prepare', { row_ids: [wall.id, paid.id, dm.id, wall.id] })
    expect(prepared.statusCode, prepared.body).toBe(202)
    expect(prepared.json().results).toEqual([
      { id: wall.id, ok: true, code: null },
      { id: paid.id, ok: true, code: null },
      { id: dm.id, ok: false, code: 'publication_refused' },
    ])
    // One runner takes both works of the batch, one after the other.
    for (const row of [wall, paid]) {
      const done = await workOutcome(db, await lastWork(row.id))
      const outcome = done.state === 'succeeded' ? done : await runRow(row.id)
      expect(outcome.state, outcome.error_text ?? '').toBe('succeeded')
    }
    const ready = await rowOf(wall.id)
    const blocked = await rowOf(paid.id)
    expect(blocked.hub?.publication?.blocked).toBe(true)
    const rows = [ready, blocked].map((row) => ({ id: row.id, version: versionOf(row) }))

    // An agent sends nothing the owner did not approve, a paid post never: each row its own.
    const approves = hub.calls('publications.approve').length
    const refused = await batch('send', { rows }, agent)
    expect(refused.statusCode, refused.body).toBe(202)
    expect(refused.json().results).toEqual([
      { id: ready.id, ok: false, code: 'forbidden' },
      { id: blocked.id, ok: false, code: 'forbidden' },
    ])
    expect(hub.calls('publications.approve').length).toBe(approves)

    const sentBatch = await batch('send', { rows })
    expect(sentBatch.statusCode, sentBatch.body).toBe(202)
    expect(sentBatch.json().results).toEqual([
      { id: ready.id, ok: true, code: null },
      { id: blocked.id, ok: false, code: 'publication_blocked' },
    ])
    const outcome = await runRow(ready.id)
    expect(outcome.state, outcome.error_text ?? '').toBe('succeeded')
    expect(hub.calls('publications.approve').length).toBe(approves + 1)
    expect((await rowOf(ready.id)).verdict.word).toBe('отправлено')
    expect((await rowOf(blocked.id)).hub?.publication?.state).toBe('draft')
  })
})

describe('a row that already went out', () => {
  it('offers neither «Подготовить» nor «Отправить» once its placement is confirmed', async () => {
    const row = await put({ item_id: 'SET-074', date: day(15), time: '19:00' })
    expect(row.hub?.can_prepare).toBe(true)
    // The placement of the row confirmed exactly (a pair a person confirmed), no KM mark.
    await withActorTx(
      db,
      { actor: SYSTEM_ACTOR('test'), action: 'test.confirm', requestId: randomUUID() },
      async (tx) => {
        const { rows } = await tx.execute<{ id: string }>(sql`
          INSERT INTO placements (model_id, account_id, surface_id, occurrence_kind, manual_key,
                                  item_id, item_type, plan_row_id, planned_at, occurred_at,
                                  occurred_source, surface_source, origin)
          SELECT r.model_id, r.account_id, r.surface_id, 'manual', ${`test:${row.id}`}, r.item_id,
                 i.type, r.id, r.slot_at, r.slot_at, 'km', 'plan', 'manual'
            FROM posting_plan_rows r JOIN content_items i ON i.model_id = r.model_id AND i.id = r.item_id
           WHERE r.id = ${row.id}::uuid
          RETURNING id`)
        await tx.execute(sql`
          INSERT INTO placement_evidence (model_id, placement_id, source, kind, strength, payload,
                                          dedup_key)
          VALUES (${lora1.modelId}::uuid, ${rows[0]?.id}::uuid, 'manual', 'manual_confirm', 'exact',
                  '{"basis": "inspected_pair"}'::jsonb, ${`manual:${randomUUID()}`})`)
      },
    )
    const out = await rowOf(row.id)
    expect(out.verdict.sign).toBe('done')
    expect(out.hub).toMatchObject({ can_prepare: false, can_send: false })
    const refused = await command(row.id, 'prepare')
    expect(refused.statusCode).toBe(422)
    expect(refused.json().message).toContain('уже вышла')
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

    // An agent's send of an approved free row waits for the switch the same way, then goes once.
    const free = await prepared(
      (await put({ item_id: 'SET-074', date: day(10), time: '22:00' })).id,
    )
    await approveWeek([free])
    const queuedSend = await command(free.id, 'send', agent, { version: versionOf(free) })
    expect(queuedSend.statusCode, queuedSend.body).toBe(202)
    await setPublish(lora1, false)
    const approves = hub.calls('publications.approve').length
    const waiting = await runHubWork(db, await lastWork(free.id), publish(), {
      kind: 'hub_publish',
      claim: false,
    })
    expect(waiting.paused_reason).toBe('switch_off:hub.publish')
    expect(hub.calls('publications.approve').length).toBe(approves)
    await setPublish(lora1, true)
    const went = await runRow(free.id)
    expect(went.state, went.error_text ?? '').toBe('succeeded')
    expect(hub.calls('publications.approve').length).toBe(approves + 1)
    const twice = await command(free.id, 'send', agent, { version: versionOf(free) })
    expect(twice.statusCode).toBe(403)
    expect(hub.calls('publications.approve').length).toBe(approves + 1)
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

describe('«Утвердить неделю» (decision of the owner 11.11.2026)', () => {
  /** A week of its own, far from the other tests: its column counts only these rows. */
  const far = weekDates(isoWeekOf(day(35)))
  const on = (index: number) => far[index] as string

  async function weekColumn() {
    const response = await call(server.app, {
      method: 'GET',
      url: `/api/v1/lora/plan?week=${isoWeekOf(on(0))}`,
      as: diana.session,
    })
    expect(response.statusCode, response.body).toBe(200)
    return PlanWeekSchema.parse(response.json()).columns.find(
      (column) => column.account === 'lora-1',
    )
  }

  async function revoke(as = owner) {
    return call(server.app, {
      method: 'POST',
      url: `/api/v1/lora/plan/weeks/${isoWeekOf(on(0))}:revoke-approval`,
      as,
      key: newKey(),
      body: { account: 'lora-1' },
    })
  }

  async function switchAgents(enabled: boolean) {
    const response = await call(server.app, {
      method: 'PATCH',
      url: '/api/v1/admin/integrations/agents',
      as: owner,
      key: newKey(),
      body: { switches: { enabled } },
    })
    expect(response.statusCode, response.body).toBe(200)
  }

  it('only the owner, a person: a manager and an agent of any role are refused', async () => {
    const row = await put({ item_id: 'SET-074', date: on(0), time: '19:00' })
    expect((await approveWeek([row], diana.session)).statusCode).toBe(403)
    expect((await approveWeek([row], agent)).statusCode).toBe(403)
    // An agent with the owner's role (the API never gives one; the database could hold it).
    const added = await call(server.app, {
      method: 'POST',
      url: '/api/v1/admin/agents',
      as: owner,
      key: newKey(),
      body: { name: 'Агент владельца', role: 'manager', models: ['lora'] },
    })
    const id = added.json().id as string
    const token = await call(server.app, {
      method: 'POST',
      url: `/api/v1/admin/agents/${id}/tokens`,
      as: owner,
      key: newKey(),
      body: { agent_id: id, expires_in_days: null },
    })
    await withActorTx(
      db,
      { actor: SYSTEM_ACTOR('test'), action: 'test.role', requestId: randomUUID() },
      (tx) => tx.execute(sql`UPDATE principals SET role = 'owner' WHERE id = ${id}::uuid`),
    )
    const ownerAgent = `Bearer ${IssuedTokenSchema.parse(token.json()).secret}`
    const refused = await approveWeek([row], ownerAgent)
    expect(refused.statusCode).toBe(403)
    expect(refused.json().message).toContain('только владелец')
    expect((await revoke(ownerAgent)).statusCode).toBe(403)
    expect((await revoke(diana.session)).statusCode).toBe(403)
    expect((await rowOf(row.id)).approval).toBeNull()
  })

  it('stamps the rows as the owner saw them: an edit voids it, a repeat picks it up', async () => {
    const set = await put({ item_id: 'SET-074', date: on(1), time: '19:00' })
    const fyp = await put({ item_id: 'FYP-0801', surface: 'fyp', date: on(2), time: '03:00' })
    const ppv = await put({ item_id: 'PPV-076', date: on(3), time: '20:00' })
    const other = await put({ item_id: 'SET-074', date: day(4), time: '23:00' })
    expect((await weekColumn())?.approval).toMatchObject({
      approved: 0,
      changed: 0,
      at: null,
    })
    const first = await approveWeek([set, { ...fyp, version: fyp.version + 5 }, other])
    expect(first.json().results).toEqual([
      { id: set.id, ok: true, code: null },
      { id: fyp.id, ok: false, code: 'version_mismatch' },
      // Another week: not this week's row.
      { id: other.id, ok: false, code: 'not_found' },
    ])
    const column = await weekColumn()
    expect(column?.approval).toMatchObject({ approved: 1, changed: 0, by: { name: 'Дмитрий' } })
    const unapproved = column?.approval?.unapproved ?? 0
    expect(unapproved).toBeGreaterThanOrEqual(2)

    const edited = await call(server.app, {
      method: 'PATCH',
      url: `/api/v1/lora/plan/rows/${set.id}`,
      as: diana.session,
      key: newKey(),
      ifMatch: set.version,
      body: { caption: 'Another fictional caption' },
    })
    expect(edited.statusCode, edited.body).toBe(200)
    const changed = PlanRowSchema.parse(edited.json())
    expect(changed.approval).toMatchObject({ version: set.version, current: false })
    expect(changed.hub?.agent_send?.reason).toBe('changed')
    expect((await weekColumn())?.approval).toMatchObject({ approved: 0, changed: 1, unapproved })

    const again = await approveWeek([changed, fyp, ppv])
    expect(again.json().results.every((result: { ok: boolean }) => result.ok)).toBe(true)
    expect((await weekColumn())?.approval).toMatchObject({
      approved: 3,
      changed: 0,
      unapproved: unapproved - 2,
    })
    // The journal names the rows and the versions the owner saw.
    const { rows: journal } = await db.execute<{ after: { Строки: unknown[] } }>(sql`
      SELECT after FROM action_log WHERE action = 'plan.approveWeek' AND entry_kind = 'action'
       ORDER BY id DESC LIMIT 1`)
    expect(journal[0]?.after.Строки).toEqual([
      { id: changed.id, version: changed.version },
      { id: fyp.id, version: fyp.version },
      { id: ppv.id, version: ppv.version },
    ])
  })

  it('a paid post, a PPV on the wall and a draft with Hub’s findings stay for a person', async () => {
    const ppv = await put({ item_id: 'PPV-076', date: on(4), time: '20:00' })
    const priced = await put(
      { item_id: 'SET-074', date: on(4), time: '21:00' },
      { price_mills: 9_000 },
    )
    const warned = await prepared(
      (await put({ item_id: 'SET-074', date: on(4), time: '22:00' })).id,
    )
    await approveWeek([ppv, priced, warned])
    expect((await rowOf(ppv.id)).hub?.agent_send?.reason).toBe('paid')
    expect((await rowOf(priced.id)).hub?.agent_send?.reason).toBe('paid')
    expect((await rowOf(warned.id)).hub?.agent_send).toEqual({ allowed: true, reason: null })
    // Hub warns about the draft (a file posted recently): an agent leaves it to a person.
    await withActorTx(
      db,
      { actor: SYSTEM_ACTOR('test'), action: 'test.checks', requestId: randomUUID() },
      (tx) =>
        tx.execute(sql`
          UPDATE posting_plan_rows
             SET hub_checks = '{"blocked": false, "findings": [{"code": "media_recently_posted", "severity": "warning", "media_key": null}]}'::jsonb
           WHERE id = ${warned.id}::uuid`),
    )
    const after = await rowOf(warned.id)
    expect(after.hub).toMatchObject({ can_send: true, agent_send: { reason: 'hub_findings' } })
    const approves = hub.calls('publications.approve').length
    for (const [row, reason] of [
      [ppv, 'paid'],
      [priced, 'paid'],
      [after, 'hub_findings'],
    ] as const) {
      const refused = await command(row.id, 'send', agent, { version: 1 })
      expect(refused.statusCode).toBe(403)
      expect(refused.json().details).toEqual({ reason })
    }
    expect(hub.calls('publications.approve').length).toBe(approves)
  })

  it('a revoked approval, an edited row or switched-off agents stop a queued agent send', async () => {
    const approves = hub.calls('publications.approve').length
    const queue = async (time: string) => {
      const row = await prepared((await put({ item_id: 'SET-074', date: on(5), time })).id)
      await approveWeek([row])
      const queued = await command(row.id, 'send', agent, { version: versionOf(row) })
      expect(queued.statusCode, queued.body).toBe(202)
      return row
    }

    const revoked = await queue('18:00')
    const answer = await revoke()
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.json().results).toContainEqual({ id: revoked.id, ok: true, code: null })
    expect(await runRow(revoked.id)).toMatchObject({
      state: 'failed',
      error_code: 'agent_not_approved',
    })
    expect((await rowOf(revoked.id)).approval).toBeNull()

    const edited = await queue('19:00')
    const patched = await call(server.app, {
      method: 'PATCH',
      url: `/api/v1/lora/plan/rows/${edited.id}`,
      as: diana.session,
      key: newKey(),
      ifMatch: edited.version,
      body: { note: 'fictional note' },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    expect((await runRow(edited.id)).state).toBe('failed')

    const switched = await queue('20:00')
    await switchAgents(false)
    try {
      expect(await runRow(switched.id)).toMatchObject({ state: 'failed', error_code: 'agent_off' })
    } finally {
      await switchAgents(true)
    }
    expect(hub.calls('publications.approve').length).toBe(approves)
    expect(publicationOf(switched).status).toBe('draft')
  })
})

describe('the last check before Hub approves', () => {
  /** A set whose first photo will turn out to hold a custom's bytes. */
  const COPY = randomBytes(32)
  const clean = { secondPerson: false }

  beforeAll(async () => {
    await createCatalogItems(db, 'lora', [
      { type: 'custom', number: 90, title: 'Заказ', ...clean, files: [{ role: 'master' }] },
      {
        type: 'set',
        number: 90,
        title: 'Пляж',
        ...clean,
        files: [
          { role: 'ed', selected: true, sha256: [COPY] },
          { role: 'ed', selected: true },
        ],
      },
      {
        type: 'set',
        number: 91,
        title: 'Сад',
        ...clean,
        files: [
          { role: 'ed', selected: true },
          { role: 'ed', selected: true },
        ],
      },
      {
        type: 'set',
        number: 92,
        title: 'Парк',
        ...clean,
        files: [
          { role: 'ed', selected: true },
          { role: 'ed', selected: true },
        ],
      },
    ])
  })

  async function queuedSend(row: PlanRow, as = diana.session) {
    const queued = await command(row.id, 'send', as, { version: versionOf(row) })
    expect(queued.statusCode, queued.body).toBe(202)
  }

  it('a provenance link added after queueing: the work refuses, Hub approves nothing', async () => {
    const row = await prepared((await put({ item_id: 'SET-091', date: day(50), time: '19:00' })).id)
    await queuedSend(row)
    // The link changes no row version: only the work's own check sees it.
    const linked = await call(server.app, {
      method: 'POST',
      url: '/api/v1/lora/i/SET-091/links',
      as: owner,
      key: newKey(),
      body: { relation: 'made_from', direction: 'out', item_id: 'CUS-090' },
    })
    expect(linked.statusCode, linked.body).toBe(201)
    const approves = hub.calls('publications.approve').length
    const outcome = await runRow(row.id)
    expect(outcome).toMatchObject({ state: 'failed', error_code: 'from_custom' })
    expect(outcome.error_text).toContain('Из кастома CUS-090')
    expect(hub.calls('publications.approve').length).toBe(approves)
    expect(publicationOf(row).status).toBe('draft')
  })

  it('a custom’s file removed from the live set still goes with the sealed row: refused', async () => {
    const row = await prepared((await put({ item_id: 'SET-090', date: day(51), time: '19:00' })).id)
    await queuedSend(row)
    // The photo turns out to be a custom's (its bytes arrive as CUS-091) and leaves the live set.
    await createCatalogItems(db, 'lora', [
      {
        type: 'custom',
        number: 91,
        title: 'Ещё заказ',
        ...clean,
        files: [{ role: 'master', sha256: [COPY] }],
      },
    ])
    const item = await call(server.app, { method: 'GET', url: '/api/v1/lora/i/SET-090', as: owner })
    const removed = await call(server.app, {
      method: 'POST',
      url: '/api/v1/lora/i/SET-090/files:remove',
      as: owner,
      key: newKey(),
      ifMatch: item.json().version,
      body: { keys: ['ed01'] },
    })
    expect(removed.statusCode, removed.body).toBe(200)
    // The live object is clean again: a new free wall row of it is taken.
    expect(
      (await put({ item_id: 'SET-090', date: day(51), time: '21:00' })).manifest,
    ).not.toBeNull()
    const approves = hub.calls('publications.approve').length
    const outcome = await runRow(row.id)
    expect(outcome).toMatchObject({ state: 'failed', error_code: 'from_custom' })
    expect(outcome.error_text).toContain('Из кастома CUS-091')
    // The route says the same to a person who tries again.
    const again = await command(row.id, 'send', diana.session, { version: versionOf(row) })
    expect(again.statusCode).toBe(422)
    expect(again.json().message).toContain('Из кастома CUS-091 — на стену только платным постом')
    expect(hub.calls('publications.approve').length).toBe(approves)
  })

  it('a Hub draft edited to a paid post: the agent is refused, a person sends as before', async () => {
    const row = await prepared(
      (await put({ item_id: 'SET-092', date: day(52), time: '19:00' })).id,
      agent,
    )
    await approveWeek([row])
    const approves = hub.calls('publications.approve').length
    await queuedSend(row, agent)
    // Someone makes the draft a paid post in Hub, under the same content version.
    const draft = publicationOf(row)
    draft.kind = 'paid_post'
    draft.priceMills = 9_000
    expect(await runRow(row.id)).toMatchObject({ state: 'failed', error_code: 'agent_paid' })
    expect(hub.calls('publications.approve').length).toBe(approves)

    // Hub's version moves with the edit: the status read takes it and marks the draft.
    draft.version += 1
    draft.updatedAt = new Date().toISOString()
    await statuses(lora1)
    const edited = await rowOf(row.id, agent)
    expect(edited.hub?.agent_send).toEqual({ allowed: false, reason: 'changed' })
    const refused = await command(row.id, 'send', agent, { version: versionOf(edited) })
    expect(refused.statusCode).toBe(403)
    expect(refused.json().details).toEqual({ reason: 'changed' })
    // Preparing it again does not make Hub's edit the row's content for the agent.
    expect((await prepared(row.id, agent)).hub?.agent_send?.reason).toBe('changed')

    // A person sees Hub's draft and sends it, as before (the page's price range is set).
    hub.setPriceRange('page-a', { min: 1_000, max: 100_000 })
    try {
      const person = await rowOf(row.id)
      expect(person.hub?.can_send).toBe(true)
      await queuedSend(person)
      const outcome = await runRow(row.id)
      expect(outcome.state, outcome.error_text ?? '').toBe('succeeded')
      expect(hub.calls('publications.approve').length).toBe(approves + 1)
    } finally {
      hub.setPriceRange('page-a', null)
    }
  })

  it('the agent’s grant taken away or its role lowered after queueing: refused', async () => {
    const added = await call(server.app, {
      method: 'POST',
      url: '/api/v1/admin/agents',
      as: owner,
      key: newKey(),
      body: { name: 'Неделя', role: 'manager', models: ['lora'] },
    })
    const id = added.json().id as string
    const token = await call(server.app, {
      method: 'POST',
      url: `/api/v1/admin/agents/${id}/tokens`,
      as: owner,
      key: newKey(),
      body: { agent_id: id, expires_in_days: null },
    })
    const weekAgent = `Bearer ${IssuedTokenSchema.parse(token.json()).secret}`
    let version = added.json().version as number
    const update = async (change: Record<string, unknown>) => {
      const response = await call(server.app, {
        method: 'PATCH',
        url: `/api/v1/admin/agents/${id}`,
        as: owner,
        key: newKey(),
        ifMatch: version,
        body: change,
      })
      expect(response.statusCode, response.body).toBe(200)
      version = response.json().version
    }
    const queue = async (time: string) => {
      const row = await prepared(
        (await put({ item_id: 'SET-092', date: day(53), time })).id,
        weekAgent,
      )
      await approveWeek([row])
      await queuedSend(row, weekAgent)
      return row
    }
    const approves = hub.calls('publications.approve').length

    const ungranted = await queue('18:00')
    await update({ models: ['ari'] })
    expect(await runRow(ungranted.id)).toMatchObject({ state: 'failed', error_code: 'agent_off' })

    await update({ models: ['lora'] })
    const lowered = await queue('20:00')
    await update({ role: 'reader' })
    expect(await runRow(lowered.id)).toMatchObject({ state: 'failed', error_code: 'agent_off' })
    expect(hub.calls('publications.approve').length).toBe(approves)
  })
})
