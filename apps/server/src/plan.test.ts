import { randomUUID } from 'node:crypto'
import { addDays, isoWeekOf } from '@contentops/contracts/clock'
import type { NewPlanRow } from '@contentops/contracts/commands/plan'
import {
  PlanDaySchema,
  type PlanRow,
  PlanRowSchema,
  PlanWeekSchema,
} from '@contentops/contracts/domain/plan'
import { withClient } from '@contentops/db/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { systemTx } from './media/testing'
import { sealWaitingVersionRows } from './plan/composition'
import { createCatalogItems } from './testing/catalog-factory'
import {
  addPerson,
  call,
  newKey,
  OWNER,
  signIn,
  type TestServer,
  testServer,
} from './testing/server'

/**
 * The plan on the server (PLAN 4а, SPEC §4, §5, §7): the rules the prototype computed in the
 * mock and the browser, now with tests here — the surface table, the second person on OnlyFans
 * (with the question of an unchecked legacy object), «уже в плане», «слишком рано» by the
 * threshold, two posts in one time, releases counted once, marks, «Отметить и подтвердить» and
 * its retraction, «пропущено» with and without time, the 6-second delete, the batch dry run,
 * «Уже залито», «Ещё не залито», the downloads with the row suffix, counters, rights.
 */

let server: TestServer
let owner: string
let diana: { id: string; session: string }
let nikita: { id: string; session: string }
let reader: { id: string; session: string }

const TODAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })
const day = (offset: number) => addDays(TODAY, offset)

beforeAll(async () => {
  server = await testServer()
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  diana = await addPerson(server.app, owner, {
    name: 'Диана',
    login: 'diana',
    role: 'manager',
    models: ['lora'],
  })
  nikita = await addPerson(server.app, owner, {
    name: 'Никита',
    login: 'nikita',
    role: 'manager',
    models: ['lora'],
  })
  reader = await addPerson(server.app, owner, {
    name: 'Чтение',
    login: 'reader',
    role: 'reader',
    models: ['lora'],
  })
  await createCatalogItems(server.db, 'lora', [
    {
      type: 'ppv',
      number: 73,
      title: 'Вечеринка',
      ppvKind: 'bundle',
      secondPerson: false,
      files: [
        { role: 'master', durationS: 804 },
        { role: 'teaser' },
        { role: 'pic' },
        { role: 'pic' },
      ],
    },
    {
      type: 'ppv',
      number: 74,
      title: 'Вдвоём',
      ppvKind: 'dm',
      secondPerson: true,
      files: [{ role: 'master' }, { role: 'pic' }],
    },
    {
      type: 'ppv',
      number: 32,
      title: 'Старое',
      ppvKind: 'dm',
      secondPerson: null,
      files: [{ role: 'master' }, { role: 'pic' }],
    },
    {
      type: 'ppv',
      number: 76,
      title: 'Нейлон',
      ppvKind: 'bundle',
      secondPerson: false,
      files: [{ role: 'master' }, { role: 'pic' }],
    },
    {
      type: 'set',
      number: 74,
      title: 'Кружево',
      secondPerson: false,
      files: [
        { role: 'raw' },
        { role: 'raw' },
        { role: 'ed', selected: true },
        { role: 'ed', selected: true },
      ],
    },
    { type: 'set', number: 73, title: 'Чулки', secondPerson: false, files: [{ role: 'raw' }] },
    {
      type: 'fyp',
      number: 801,
      title: 'Зеркало',
      secondPerson: false,
      files: [{ role: 'master' }, { role: 'master', variant: 1, uniqLevel: 'soft' }],
    },
    {
      type: 'life',
      number: 191,
      title: 'Завтрак',
      secondPerson: false,
      files: [
        { role: 'pic', lifeUse: 'chats' },
        { role: 'pic', lifeUse: 'both' },
      ],
    },
    { type: 'custom', number: 181, title: 'Кастом', files: [{ role: 'master' }] },
    {
      type: 'sexting',
      number: 12,
      title: 'Секстинг',
      secondPerson: false,
      files: [{ role: 'pic' }, { role: 'clip' }],
    },
  ])
  // Diana posts on Fansly 1 by default; the norm wants a FYP every day and a release weekly.
  const norm = await call(server.app, {
    method: 'GET',
    url: '/api/v1/lora/accounts/lora-1/week-norm',
    as: owner,
  })
  const { account: _account, version, ...body } = norm.json()
  const updated = await call(server.app, {
    method: 'PUT',
    url: '/api/v1/lora/accounts/lora-1/week-norm',
    as: owner,
    key: newKey(),
    ifMatch: version,
    body: {
      ...body,
      cells: body.cells.map((cell: { kind: string }) =>
        cell.kind === 'fyp' ? { ...cell, per_day: [1, 1, 1, 1, 1, 1, 1], time: '03:00' } : cell,
      ),
      release: { every_weeks: 1, weekday: 3, time: '20:00' },
      usual_assignee: diana.id,
    },
  })
  expect(updated.statusCode).toBe(200)
})
afterAll(() => server.close())

function row(patch: Partial<NewPlanRow>): NewPlanRow {
  return {
    item_id: 'SET-074',
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

async function send(
  as: string,
  method: 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  url: string,
  body?: unknown,
  ifMatch?: number,
) {
  return call(server.app, { method, url: `/api/v1/lora${url}`, as, key: newKey(), body, ifMatch })
}

async function put(as: string, rows: NewPlanRow[]): Promise<PlanRow[]> {
  const response = await send(as, 'POST', '/plan/rows', { rows })
  expect(response.statusCode, response.body).toBe(201)
  return response.json().rows.map((one: unknown) => PlanRowSchema.parse(one))
}

async function check(input: NewPlanRow, as = diana.session) {
  const response = await send(as, 'POST', '/plan/rows:check', input)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

async function planDay(date: string, as = owner, query = '') {
  const response = await call(server.app, {
    method: 'GET',
    url: `/api/v1/lora/plan?date=${date}${query}`,
    as,
  })
  expect(response.statusCode, response.body).toBe(200)
  return PlanDaySchema.parse(response.json())
}

describe('putting rows: the hard rules (SPEC §7)', () => {
  it('puts a set on the wall with its sealed frames and the row name suffix', async () => {
    const [created] = await put(diana.session, [row({ item_id: 'SET-073', date: day(5) })])
    expect(created).toMatchObject({
      account: 'lora-1',
      surface: 'wall',
      assignee: { id: diana.id, name: 'Диана' },
      verdict: { level: 'planned', word: 'в плане' },
      mark_button: 'mark_confirm',
      created_by: { name: 'Диана' },
    })
    expect(created?.manifest?.files).toEqual([
      expect.objectContaining({
        key: 'platform',
        label: 'Фото 1 шт., по порядку',
        download_name: expect.stringMatching(new RegExp(`__lora-1_${day(5)}_2000\\.jpg$`)),
      }),
    ])
  })

  it('refuses a type off its surfaces, a custom, a FYP on OnlyFans and a story without a release', async () => {
    const cases: [Partial<NewPlanRow>, string][] = [
      [{ item_id: 'SET-074', surface: 'vault' }, 'сет в vault не ставится'],
      [{ item_id: 'CUS-181', surface: 'vault' }, 'кастом в план не ставится — он выходит как PPV'],
      [{ item_id: 'FYP-0801', surface: 'fyp', account: 'lora-of' }, 'фупов на OnlyFans нет'],
      [{ item_id: 'PPV-073', surface: 'story' }, 'сториз ставится только тизером выпуска PPV'],
      [{ item_id: 'SET-074', surface: 'dm' }, 'сет в рассылку не ставится'],
    ]
    for (const [patch, text] of cases) {
      const response = await send(diana.session, 'POST', '/plan/rows', { rows: [row(patch)] })
      expect(response.statusCode).toBe(201)
      expect(response.json()).toMatchObject({
        created: false,
        rejected: [{ index: 0, code: 'invalid_request', text }],
      })
      expect((await check(row(patch))).blocked).toBe(true)
    }
  })

  it('second person never on OnlyFans; the batch is all or nothing; Fansly takes it', async () => {
    const response = await send(diana.session, 'POST', '/plan/rows', {
      rows: [
        row({ item_id: 'PPV-074', account: 'lora-1', surface: 'vault' }),
        row({ item_id: 'PPV-074', account: 'lora-of', surface: 'vault' }),
      ],
    })
    expect(response.json()).toMatchObject({
      created: false,
      rows: [],
      rejected: [
        { index: 1, code: 'second_person_onlyfans', text: 'нельзя: второй человек в кадре' },
      ],
    })
    const line = await check(row({ item_id: 'PPV-074', account: 'lora-of', surface: 'vault' }))
    expect(line).toMatchObject({ blocked: true, text: 'Нельзя: второй человек в кадре' })
    await put(diana.session, [
      row({ item_id: 'PPV-074', account: 'lora-1', surface: 'vault', date: day(6) }),
    ])
  })

  it('asks once about an unchecked legacy object on OnlyFans; an answer opens the page', async () => {
    const input = row({ item_id: 'PPV-032', account: 'lora-of', surface: 'vault', date: day(3) })
    const line = await check(input)
    expect(line).toMatchObject({
      blocked: true,
      question: { kind: 'second_person', item_id: 'PPV-032' },
    })
    const refused = await send(diana.session, 'POST', '/plan/rows', { rows: [input] })
    expect(refused.json().rejected[0].code).toBe('second_person_onlyfans')
    // An agent or a person answers «Нет» with the object's flag.
    const detail = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/i/PPV-032',
      as: diana.session,
    })
    const answered = await send(
      diana.session,
      'PATCH',
      '/i/PPV-032/flags',
      { second_person: false },
      detail.json().version,
    )
    expect(answered.statusCode, answered.body).toBe(200)
    expect((await check(input)).blocked).toBe(false)
    await put(diana.session, [input])
  })

  it('a late flag needs consent and cancels the open OnlyFans rows (SPEC §7)', async () => {
    const detail = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/i/PPV-032',
      as: owner,
    })
    const refused = await send(
      owner,
      'PATCH',
      '/i/PPV-032/flags',
      { second_person: true },
      detail.json().version,
    )
    expect(refused.statusCode).toBe(422)
    expect(refused.json()).toMatchObject({ code: 'second_person_onlyfans', details: { rows: 1 } })
    const done = await send(
      owner,
      'PATCH',
      '/i/PPV-032/flags',
      { second_person: true, cancel_onlyfans_rows: true },
      detail.json().version,
    )
    expect(done.statusCode, done.body).toBe(200)
    const view = await planDay(day(3), owner, '&cancelled=1')
    const cancelled = view.rows.find((one) => one.manifest?.item_id === 'PPV-032')
    expect(cancelled?.cancelled).toMatchObject({ reason: 'second_person' })
    expect(cancelled?.verdict.level).toBe('cancelled')
  })
})

describe('the check line and warnings (DESIGN §4.13)', () => {
  it('«уже в плане» first, on the same page and place; another place is no repeat', async () => {
    await put(diana.session, [row({ item_id: 'SET-074', date: day(2), time: '20:00' })])
    const line = await check(row({ item_id: 'SET-074', date: day(4) }))
    expect(line.warnings[0]).toMatchObject({ kind: 'already_planned', date: day(2) })
    expect(line.tone).toBe('attention')
    const otherPage = await check(row({ item_id: 'SET-074', account: 'lora-of', date: day(4) }))
    expect(otherPage.warnings.map((w: { kind: string }) => w.kind)).not.toContain('already_planned')
  })

  it('two posts in one time and posts closer than two tolerances', async () => {
    const same = await check(row({ item_id: 'PPV-073', date: day(2), time: '20:00' }))
    expect(same.warnings.map((w: { text: string }) => w.text)).toContain(
      'в 20:00 на Fansly 1 уже стоит SET-074 — два поста в одно время',
    )
    const close = await check(row({ item_id: 'PPV-073', date: day(2), time: '20:40' }))
    expect(close.warnings.map((w: { kind: string }) => w.kind)).toContain('too_close')
  })

  it('without the threshold says so in grey; «слишком рано» counts manual confirmations, not marks', async () => {
    const before = await check(row({ item_id: 'PPV-076', date: day(1) }))
    expect(before).toMatchObject({ tone: 'muted', text: 'Порог «слишком рано» не задан' })
    const threshold = await call(server.app, {
      method: 'PUT',
      url: '/api/v1/admin/thresholds',
      as: owner,
      key: newKey(),
      ifMatch: 1,
      body: { key: 'too_early_days', scope: 'all', scope_value: null, value: 14 },
    })
    expect(threshold.statusCode, threshold.body).toBe(200)
    const [past] = await put(owner, [row({ item_id: 'PPV-076', date: day(-3), time: '19:00' })])
    // A plain mark is not a placement of the exact level: no «слишком рано» yet.
    const marked = await send(owner, 'POST', `/plan/rows/${past?.id}:mark`, {
      kind: 'posted',
      stated_occurred_at: null,
    })
    expect(marked.statusCode, marked.body).toBe(200)
    expect((await check(row({ item_id: 'PPV-076', date: day(1) }))).warnings[0]?.kind).not.toBe(
      'too_early',
    )
    await send(owner, 'POST', `/plan/rows/${past?.id}:unmark`)
    const confirmed = await send(owner, 'POST', `/plan/rows/${past?.id}:mark-confirm`, {
      stated_occurred_at: null,
    })
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    const line = await check(row({ item_id: 'PPV-076', date: day(1) }))
    expect(line.warnings[0]).toMatchObject({ kind: 'too_early', account: 'lora-1' })
    expect(line.text).toMatch(/^Слишком рано: на Fansly 1 было /)
    // The vault never counts.
    const vault = await check(row({ item_id: 'PPV-076', surface: 'vault', date: day(1) }))
    expect(vault.warnings.map((w: { kind: string }) => w.kind)).not.toContain('too_early')
  })

  it('the batch preview carries every warning and creates nothing', async () => {
    const before = await planDay(day(4))
    const response = await send(diana.session, 'POST', '/plan/rows?dry_run=1', {
      rows: [row({ item_id: 'SET-074', date: day(4) })],
    })
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json()).toMatchObject({ created: false, rejected: [] })
    expect(response.json().rows[0].warnings[0].kind).toBe('already_planned')
    expect((await planDay(day(4))).rows).toHaveLength(before.rows.length)
  })
})

describe('marks, confirmations and retractions (SPEC §5, §7)', () => {
  it('«Отметить и подтвердить» writes the mark and a manual exact confirmation; «Снять» retracts it', async () => {
    const [created] = await put(diana.session, [
      row({ item_id: 'LIFE-191', surface: 'vault', date: TODAY, time: null }),
    ])
    const confirmed = await send(diana.session, 'POST', `/plan/rows/${created?.id}:mark-confirm`, {
      stated_occurred_at: null,
    })
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    expect(confirmed.json().verdict).toMatchObject({
      sign: 'done',
      word: 'подтверждено',
      detail: 'вручную, Диана',
      reason: 'Отчёт о выполнении',
    })
    const evidence = async () =>
      (
        await server.db.execute<{ kind: string; strength: string | null; corrects: boolean }>(sql`
          SELECT e.kind, e.strength, e.corrects_id IS NOT NULL AS corrects
            FROM placement_evidence e JOIN placements p ON p.id = e.placement_id
           WHERE p.plan_row_id = ${created?.id}::uuid ORDER BY e.recorded_at, e.id`)
      ).rows
    expect(await evidence()).toEqual([
      { kind: 'manual_confirm', strength: 'exact', corrects: false },
    ])
    // Another manager cannot take Diana's mark off; the owner can.
    const foreign = await send(nikita.session, 'POST', `/plan/rows/${created?.id}:unmark`)
    expect(foreign.statusCode).toBe(403)
    const unmarked = await send(owner, 'POST', `/plan/rows/${created?.id}:unmark`)
    expect(unmarked.statusCode, unmarked.body).toBe(200)
    expect(unmarked.json().mark).toBeNull()
    expect(unmarked.json().verdict.level).toBe('planned')
    expect(await evidence()).toEqual([
      { kind: 'manual_confirm', strength: 'exact', corrects: false },
      { kind: 'retract', strength: null, corrects: true },
    ])
  })

  it('Fansly stories and mass messages take «Отметить» with the time, not a confirmation', async () => {
    const release = await send(owner, 'POST', '/plan/releases', {
      item_id: 'PPV-073',
      cells: [
        { account: 'lora-1', surface: 'wall', date: day(2), time: '20:00' },
        { account: 'lora-1', surface: 'story', date: day(2), time: '20:05' },
        { account: 'lora-1', surface: 'dm', date: day(2), time: '20:10' },
      ],
    })
    expect(release.statusCode, release.body).toBe(201)
    const story = release.json().rows.find((one: PlanRow) => one.surface === 'story') as PlanRow
    expect(story.mark_button).toBe('mark')
    expect(story.manifest?.files.map((file) => file.key)).toEqual(['teaser'])
    const refused = await send(diana.session, 'POST', `/plan/rows/${story.id}:mark-confirm`, {
      stated_occurred_at: null,
    })
    expect(refused.statusCode).toBe(400)
    const scheduled = await send(diana.session, 'POST', `/plan/rows/${story.id}:mark`, {
      kind: 'scheduled',
      stated_occurred_at: null,
    })
    expect(scheduled.statusCode).toBe(400)
    const at = new Date().toISOString()
    const marked = await send(diana.session, 'POST', `/plan/rows/${story.id}:mark`, {
      kind: 'posted',
      stated_occurred_at: at,
    })
    expect(marked.statusCode, marked.body).toBe(200)
    expect(marked.json()).toMatchObject({
      mark: { kind: 'posted', stated_occurred_at: at, by: { name: 'Диана' } },
      verdict: { level: 'marked_manual', word: 'отмечено', detail: 'учёт вручную' },
    })
  })

  it('a marked row is not cancelled; a cancelled one gets its reason after', async () => {
    const [created] = await put(diana.session, [row({ item_id: 'SET-074', date: day(9) })])
    await send(diana.session, 'POST', `/plan/rows/${created?.id}:mark`, {
      kind: 'scheduled',
      stated_occurred_at: null,
    })
    const refused = await send(diana.session, 'POST', `/plan/rows/${created?.id}:cancel`, {
      reason: null,
    })
    expect(refused.json().code).toBe('row_marked')
    await send(diana.session, 'POST', `/plan/rows/${created?.id}:unmark`)
    const cancelled = await send(diana.session, 'POST', `/plan/rows/${created?.id}:cancel`, {
      reason: null,
    })
    expect(cancelled.json().verdict.level).toBe('cancelled')
    const reason = await send(diana.session, 'POST', `/plan/rows/${created?.id}:cancel`, {
      reason: 'late',
    })
    expect(reason.json().cancelled).toMatchObject({ reason: 'late' })
    const again = await send(diana.session, 'POST', `/plan/rows/${created?.id}:mark`, {
      kind: 'posted',
      stated_occurred_at: null,
    })
    expect(again.json().code).toBe('row_cancelled')
  })

  it('a batch mark answers per row', async () => {
    const rows = await put(owner, [
      row({ item_id: 'SET-073', date: day(10) }),
      row({ item_id: 'FYP-0801', surface: 'fyp', date: day(10), time: '03:00' }),
    ])
    const response = await send(diana.session, 'POST', '/plan/rows:mark', {
      row_ids: [...rows.map((one) => one.id), '00000000-0000-0000-0000-000000000000'],
      kind: 'scheduled',
    })
    expect(response.json().results).toEqual([
      { id: rows[0]?.id, ok: true, code: null },
      { id: rows[1]?.id, ok: true, code: null },
      { id: '00000000-0000-0000-0000-000000000000', ok: false, code: 'not_found' },
    ])
  })
})

describe('«пропущено» (SPEC §5)', () => {
  it('a row with a time is missed once the slot passed; without a time — at the end of its local day', async () => {
    const rows = await put(owner, [
      row({ item_id: 'SET-073', date: day(-1), time: '10:00' }),
      row({ item_id: 'SET-073', account: 'lora-of', date: day(-1), time: null }),
      row({ item_id: 'SET-074', account: 'lora-of', date: TODAY, time: null }),
      row({ item_id: 'SET-073', account: 'lora-of', date: TODAY, time: '00:00' }),
    ])
    expect(rows.map((one) => one.verdict.level)).toEqual(['missed', 'missed', 'planned', 'missed'])
    // «в планировщике» closes the step: not missed.
    const scheduled = await send(owner, 'POST', `/plan/rows/${rows[0]?.id}:mark`, {
      kind: 'scheduled',
      stated_occurred_at: null,
    })
    expect(scheduled.json().verdict.level).toBe('scheduled')
  })
})

describe('the 6-second delete (SPEC §5)', () => {
  it('the author deletes a fresh row; others, old, marked or downloaded rows are only cancelled', async () => {
    const [fresh] = await put(diana.session, [row({ item_id: 'SET-073', date: day(11) })])
    expect((await send(nikita.session, 'DELETE', `/plan/rows/${fresh?.id}`)).json().code).toBe(
      'undo_expired',
    )
    expect((await send(diana.session, 'DELETE', `/plan/rows/${fresh?.id}`)).statusCode).toBe(200)
    const gone = await call(server.app, {
      method: 'GET',
      url: `/api/v1/lora/plan/rows/${fresh?.id}`,
      as: diana.session,
    })
    expect(gone.statusCode).toBe(404)
    const [old] = await put(diana.session, [row({ item_id: 'SET-073', date: day(12) })])
    // Ten seconds later: the migration role moves the creation time back past the window.
    await withClient(server.database.url('migrate'), async (admin) => {
      await admin.query('BEGIN')
      await admin.query('ALTER TABLE posting_plan_rows DISABLE TRIGGER USER')
      await admin.query(
        "UPDATE posting_plan_rows SET created_at = now() - interval '10 seconds' WHERE id = $1",
        [old?.id],
      )
      await admin.query('ALTER TABLE posting_plan_rows ENABLE TRIGGER USER')
      await admin.query('COMMIT')
    })
    expect((await send(diana.session, 'DELETE', `/plan/rows/${old?.id}`)).json().code).toBe(
      'undo_expired',
    )
    const [marked] = await put(diana.session, [
      row({ item_id: 'SET-073', date: day(13), marked: 'posted' }),
    ])
    expect((await send(diana.session, 'DELETE', `/plan/rows/${marked?.id}`)).json().code).toBe(
      'undo_expired',
    )
    const [downloaded] = await put(diana.session, [
      row({ item_id: 'PPV-076', surface: 'vault', date: day(13), time: null }),
    ])
    const download = await send(diana.session, 'POST', '/i/PPV-076/downloads', {
      kind: 'photos',
      strip_metadata: false,
      account: 'lora-1',
      plan_row: downloaded?.id,
    })
    expect(download.statusCode, download.body).toBe(200)
    expect(download.json().file_name).toMatch(
      new RegExp(`^PPV-076_.*_pic01__lora-1_${day(13)}\\.jpg$`),
    )
    expect((await send(diana.session, 'DELETE', `/plan/rows/${downloaded?.id}`)).json().code).toBe(
      'undo_expired',
    )
    const again = await call(server.app, {
      method: 'GET',
      url: `/api/v1/lora/plan/rows/${downloaded?.id}`,
      as: diana.session,
    })
    expect(again.json().downloaded).toMatchObject({ by: 'Диана', meta_stripped: false })
  })
})

describe('releases, the norm and the week (SPEC §4, §7)', () => {
  it('one command for several pages makes one release per page, counted once against the norm', async () => {
    const week = isoWeekOf(day(14))
    const viewWeek = async () => {
      const response = await call(server.app, {
        method: 'GET',
        url: `/api/v1/lora/plan?week=${week}`,
        as: owner,
      })
      expect(response.statusCode, response.body).toBe(200)
      return PlanWeekSchema.parse(response.json())
    }
    const before = await viewWeek()
    expect(
      before.gaps.filter((gap) => gap.kind === 'release' && gap.account === 'lora-1'),
    ).toHaveLength(1)
    const fyps = before.rows.filter((one) => one.account === 'lora-1' && one.surface === 'fyp')
    expect(
      before.gaps.filter((gap) => gap.kind === 'fyp' && gap.account === 'lora-1'),
    ).toHaveLength(7 - fyps.length)
    const releaseDay = before.gaps.find((gap) => gap.kind === 'release')?.date as string
    const response = await send(owner, 'POST', '/plan/releases', {
      item_id: 'PPV-076',
      cells: [
        { account: 'lora-1', surface: 'wall', date: releaseDay, time: '20:00' },
        { account: 'lora-1', surface: 'dm', date: releaseDay, time: '20:10' },
        { account: 'lora-1', surface: 'vault', date: addDays(releaseDay, -1), time: null },
        { account: 'lora-of', surface: 'wall', date: releaseDay, time: '21:00' },
      ],
    })
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json().releases).toHaveLength(2)
    expect(response.json().release).toMatchObject({ item_id: 'PPV-076', accounts: 2 })
    const after = await viewWeek()
    expect(
      after.gaps.filter((gap) => gap.kind === 'release' && gap.account === 'lora-1'),
    ).toHaveLength(0)
    expect(after.releases.map((release) => release.date)).toContain(releaseDay)
    expect(after.columns.find((column) => column.account === 'lora-1')?.norm_hint).toContain(
      'Выпуск PPV',
    )
  })
})

describe('«Ещё не залито», «Уже залито» and the page summaries (SPEC §7)', () => {
  it('«Уже залито» puts marked rows; the object leaves «Ещё не залито» of that page only', async () => {
    const list = async (account: string) =>
      (
        await call(server.app, {
          method: 'GET',
          url: `/api/v1/lora/not-uploaded?account=${account}`,
          as: diana.session,
        })
      ).json()
    const ids = (page: { groups: { type: string; item_ids: string[] }[] }, type: string) =>
      page.groups.find((group) => group.type === type)?.item_ids ?? []
    const before = await list('lora-1')
    expect(ids(before, 'sexting')).toContain('SXT-012')
    // Already in this page's plan: hidden and counted apart.
    expect(ids(before, 'ppv')).not.toContain('PPV-074')
    expect(before.planned_hidden).toBeGreaterThan(0)
    const marked = await send(diana.session, 'POST', '/not-uploaded:mark', {
      account: 'lora-1',
      items: ['SXT-012', 'PPV-999'],
    })
    expect(marked.json().results).toEqual([
      { id: 'SXT-012', ok: true, code: null },
      { id: 'PPV-999', ok: false, code: 'not_found' },
    ])
    expect(ids(await list('lora-1'), 'sexting')).not.toContain('SXT-012')
    expect(ids(await list('lora-of'), 'sexting')).toContain('SXT-012')
    const summaries = (
      await call(server.app, { method: 'GET', url: '/api/v1/lora/index/pages', as: owner })
    ).json()
    const entry = summaries.entries.find(
      (one: { item_id: string; account: string }) =>
        one.item_id === 'SXT-012' && one.account === 'lora-1',
    )
    expect(entry).toMatchObject({ placed_on: ['vault'], word: 'отмечено' })
  })
})

describe('tasks, counters and rights', () => {
  it('«Мои» are the rows Diana posts by the page; the counter counts the steps of today', async () => {
    const mine = await planDay(TODAY, diana.session, '&mine=1')
    expect(mine.rows.every((one) => one.assignee?.id === diana.id)).toBe(true)
    expect(mine.rows.length).toBeGreaterThan(0)
    const nikitas = await planDay(TODAY, nikita.session, '&mine=1')
    expect(nikitas.rows).toHaveLength(0)
    const counters = (
      await call(server.app, { method: 'GET', url: '/api/v1/admin/counters', as: diana.session })
    ).json()
    const lora = counters.models.find((one: { model: string }) => one.model === 'lora')
    expect(lora.plan).toBeGreaterThan(0)
  })

  it('a reader reads the plan but does not plan', async () => {
    expect((await planDay(TODAY, reader.session)).date).toBe(TODAY)
    const refused = await send(reader.session, 'POST', '/plan/rows', { rows: [row({})] })
    expect(refused.statusCode).toBe(403)
  })
})

describe('end to end: the owner and an agent plan, the KM downloads, marks and confirms (PLAN 4а)', () => {
  it('runs the cycle through the API and leaves it in the journal', async () => {
    // The agent prepares the plan by API, with the same checks as a person.
    const on = await call(server.app, {
      method: 'PATCH',
      url: '/api/v1/admin/integrations/agents',
      as: owner,
      key: newKey(),
      body: { switches: { enabled: true } },
    })
    expect(on.statusCode, on.body).toBe(200)
    const agent = await call(server.app, {
      method: 'POST',
      url: '/api/v1/admin/agents',
      as: owner,
      key: newKey(),
      body: { name: 'План', role: 'manager', models: ['lora'] },
    })
    expect(agent.statusCode, agent.body).toBe(201)
    const issued = await call(server.app, {
      method: 'POST',
      url: `/api/v1/admin/agents/${agent.json().id}/tokens`,
      as: owner,
      key: newKey(),
      body: { agent_id: agent.json().id, expires_in_days: null },
    })
    const token = `Bearer ${issued.json().secret}`
    const target = day(20)
    const plan = [
      row({ item_id: 'LIFE-191', surface: 'vault', date: target, time: null }),
      row({
        item_id: 'FYP-0801',
        surface: 'fyp',
        date: target,
        time: '03:00',
        fyp_version: { no: 1, level: 'soft' },
      }),
    ]
    const preview = await call(server.app, {
      method: 'POST',
      url: '/api/v1/lora/plan/rows?dry_run=1',
      as: token,
      key: newKey(),
      body: { rows: plan },
    })
    expect(preview.json()).toMatchObject({ created: false, rejected: [] })
    const noKey = await call(server.app, {
      method: 'POST',
      url: '/api/v1/lora/plan/rows',
      as: token,
      body: { rows: plan },
    })
    expect(noKey.statusCode).toBe(400)
    const created = await call(server.app, {
      method: 'POST',
      url: '/api/v1/lora/plan/rows',
      as: token,
      key: newKey(),
      body: { rows: plan },
    })
    expect(created.statusCode, created.body).toBe(201)
    const [life, fyp] = created.json().rows as PlanRow[]
    expect(life?.created_by).toMatchObject({ type: 'agent', name: 'План' })
    expect(fyp?.manifest?.fyp_version).toEqual({ no: 1, level: 'soft' })
    expect(fyp?.manifest?.files[0]?.download_name).toMatch(
      new RegExp(`^FYP-0801_.*_master_u1__lora-1_${target}_0300\\.mp4$`),
    )
    // The owner sees the agent's rows with the author; the KM gets them as tasks.
    const tasks = await planDay(target, diana.session, '&mine=1')
    expect(tasks.rows.map((one) => one.manifest?.item_id)).toEqual(['LIFE-191', 'FYP-0801'])
    // The KM downloads the files of the row with the page and date in the name.
    const download = await send(diana.session, 'POST', '/i/LIFE-191/downloads', {
      kind: 'platform',
      strip_metadata: false,
      account: 'lora-1',
      plan_row: life?.id,
    })
    expect(download.statusCode, download.body).toBe(200)
    // «Отметить и подтвердить»: the mark and the manual confirmation.
    const confirmed = await send(diana.session, 'POST', `/plan/rows/${life?.id}:mark-confirm`, {
      stated_occurred_at: null,
    })
    expect(confirmed.json()).toMatchObject({
      mark: { kind: 'posted', by: { name: 'Диана' } },
      verdict: { word: 'подтверждено', detail: 'вручную, Диана' },
    })
    // The journal tells it in words.
    const journal = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/journal?item=LIFE-191',
      as: owner,
    })
    const phrases = journal.json().items.map((event: { phrase: string }) => event.phrase)
    expect(phrases).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^План поставил в план LIFE-191 · Fansly 1 · vault /),
        expect.stringMatching(/^Диана подтвердила вручную LIFE-191 · Fansly 1 · vault /),
      ]),
    )
  })
})

describe('«Версии для Fansly 2, 3»: a version not built yet (SPEC §4, §9.3)', () => {
  it('the row waits for `uN`; uniq_render builds it and the row gets its composition', async () => {
    const [waiting] = await put(owner, [
      row({
        item_id: 'FYP-0801',
        surface: 'fyp',
        date: day(21),
        time: '03:00',
        fyp_version: { no: 2, level: 'mirror' },
      }),
    ])
    expect(waiting?.manifest).toMatchObject({ fyp_version: { no: 2, level: 'soft' }, files: [] })
    expect(waiting?.copy).toEqual({ state: 'building', progress: 0 })
    const { rows: works } = await server.db.execute<{ work_key: string }>(sql`
      SELECT work_key FROM work_operations WHERE kind = 'uniq_render'`)
    expect(works.map((work) => work.work_key)).toEqual([expect.stringMatching(/:mirror:2$/)])
    // What the worker commits: the asset `u2` of the FYP, then the waiting rows are sealed.
    const sealed = await systemTx(server.db, async (tx) => {
      const { rows } = await tx.execute<{ model_id: string; item_id: string; master: Buffer }>(sql`
        SELECT i.model_id, i.id AS item_id, v.master_sha256 AS master
          FROM content_items i
          JOIN item_memberships m ON m.model_id = i.model_id AND m.item_id = i.id AND m.variant_no = 0
          JOIN assets a ON a.model_id = m.model_id AND a.id = m.asset_id
          JOIN asset_versions v ON v.model_id = a.model_id AND v.id = a.current_version_id
         WHERE i.type = 'FYP' AND i.number = 801`)
      const fyp = rows[0] as { model_id: string; item_id: string; master: Buffer }
      const asset = randomUUID()
      const version = randomUUID()
      await tx.execute(sql`
        INSERT INTO assets (model_id, id, created_in_item_id, media_kind, current_version_id,
                            variant_kind, variant_no, uniq_level)
        VALUES (${fyp.model_id}::uuid, ${asset}::uuid, ${fyp.item_id}::uuid, 'video', ${version}::uuid,
                'uniq', 2, 'mirror')`)
      await tx.execute(sql`
        INSERT INTO asset_versions (model_id, id, asset_id, version_no, master_sha256)
        VALUES (${fyp.model_id}::uuid, ${version}::uuid, ${asset}::uuid, 1, ${fyp.master})`)
      await tx.execute(sql`
        INSERT INTO item_memberships (model_id, item_id, item_type, asset_id, variant_no, kind, role)
        VALUES (${fyp.model_id}::uuid, ${fyp.item_id}::uuid, 'FYP', ${asset}::uuid, 2, 'owned', 'master')`)
      return sealWaitingVersionRows(tx, fyp.model_id, fyp.item_id, 2)
    })
    expect(sealed).toBe(1)
    const after = await call(server.app, {
      method: 'GET',
      url: `/api/v1/lora/plan/rows/${waiting?.id}`,
      as: owner,
    })
    expect(after.json().manifest).toMatchObject({
      fyp_version: { no: 2, level: 'mirror' },
      files: [{ key: 'platform', download_name: expect.stringMatching(/_master_u2__lora-1_/) }],
    })
  })
})
