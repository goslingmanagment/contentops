import { randomUUID } from 'node:crypto'
import { addDays, isoWeekOf, weekDates, weekdayIndex } from '@contentops/contracts/clock'
import type { NewPlanRow } from '@contentops/contracts/commands/plan'
import { type Db, setJournalItem, type Tx, withActorTx } from '@contentops/db'
import { hash } from '@node-rs/argon2'
import { sql } from 'drizzle-orm'
import { journalActor } from '../commands'
import type { Actor, ModelScope } from '../context'
import { rowById } from '../plan/records'
import { loadState } from '../plan/state'
import {
  confirmMark,
  insertRow,
  isRefusal,
  logRow,
  resolveRow,
  ruleRefusal,
  setMark,
} from '../plan/writes'
import { FIXTURE_ACTOR } from './catalog-factory'

/**
 * A week of the plan for the dev stand (PLAN 4а «как увидеть»): the content manager Диана
 * (`diana`, the owner's dev password) posts on the Fansly pages, the norms of the pages ask
 * for a FYP and a wall post a day, a life in the vault on Tuesday and a PPV release on
 * Thursday; rows are put through the server's own commands — marked, confirmed, missed,
 * «в планировщике», a release on two pages — and some places of the norm are left empty.
 * PPV-074 gets «второй человек в кадре», PPV-066 stays unchecked (legacy). A model that
 * already has plan rows is left as it is. Never for a database with real content.
 */

interface Person {
  id: string
  name: string
  gender: 'f' | 'm'
  role: 'owner' | 'manager'
}

function actorOf(person: Person, model: string): Actor {
  return {
    type: 'person',
    id: person.id,
    role: person.role,
    models: [model],
    name: person.name,
    gender: person.gender,
    sessionId: null,
    tokenId: null,
  }
}

async function as<T>(db: Db, actor: Actor, action: string, run: (tx: Tx) => Promise<T>) {
  return withActorTx(db, { actor: journalActor(actor), action, requestId: randomUUID() }, run)
}

const NORM_FANSLY = {
  schema_version: 1,
  cells: [
    { kind: 'fyp', per_day: [1, 1, 1, 1, 1, 1, 1], time: '03:00' },
    { kind: 'wall', per_day: [1, 1, 1, 1, 1, 1, 1], time: '20:00' },
    { kind: 'life_vault', per_day: [0, 1, 0, 0, 0, 0, 0], time: null },
  ],
  release: { every_weeks: 1, weekday: 3, time: '20:00' },
}

const NORM_ONLYFANS = {
  schema_version: 1,
  cells: [
    { kind: 'wall', per_day: [1, 0, 1, 0, 1, 0, 0], time: '19:00' },
    { kind: 'life_vault', per_day: [0, 0, 0, 0, 0, 1, 0], time: null },
  ],
  release: { every_weeks: 2, weekday: 3, time: '21:00' },
}

function row(
  patch: Partial<NewPlanRow> & Pick<NewPlanRow, 'item_id' | 'account' | 'surface' | 'date'>,
): NewPlanRow {
  return {
    time: null,
    fyp_version: null,
    assignee: null,
    note: null,
    requires_new_upload: false,
    awaiting_montage: null,
    marked: null,
    ...patch,
  }
}

export async function seedPlan(
  db: Db,
  modelCode: string,
  password: string,
): Promise<{ rows: number; skipped: boolean }> {
  const { rows: models } = await db.execute<ModelScope & Record<string, unknown>>(sql`
    SELECT id, code, title AS name FROM models WHERE code = ${modelCode}`)
  const model = models[0]
  if (!model) throw new Error(`seed plan: no model ${modelCode}`)
  const { rows: existing } = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM posting_plan_rows WHERE model_id = ${model.id}::uuid`)
  if ((existing[0]?.n ?? 0) > 0) return { rows: 0, skipped: true }

  const { rows: owners } = await db.execute<Person & Record<string, unknown>>(sql`
    SELECT id, display_name AS name, coalesce(gender, 'm') AS gender, role FROM principals
     WHERE role = 'owner' AND kind = 'human' ORDER BY created_at LIMIT 1`)
  const owner = owners[0]
  if (!owner) throw new Error('seed plan: no owner')

  // People, norms and flags — as the owner sets them up in «Настройки».
  const fixture = await withActorTx(
    db,
    { actor: FIXTURE_ACTOR, action: 'fixtures.seed', requestId: randomUUID() },
    async (tx) => {
      await tx.execute(sql`
        INSERT INTO principals (kind, login, display_name, gender, role, password_hash)
        VALUES ('human', 'diana', 'Диана', 'f', 'manager', ${await hash(password)})
        ON CONFLICT (login) DO NOTHING`)
      const { rows } = await tx.execute<Person & Record<string, unknown>>(sql`
        SELECT id, display_name AS name, gender, role FROM principals WHERE login = 'diana'`)
      const diana = rows[0] as Person
      await tx.execute(sql`
        INSERT INTO principal_grants (model_id, principal_id, granted_by)
        SELECT ${model.id}::uuid, ${diana.id}::uuid, ${owner.id}::uuid
         WHERE NOT EXISTS (SELECT 1 FROM principal_grants
                            WHERE model_id = ${model.id}::uuid AND principal_id = ${diana.id}::uuid
                              AND revoked_at IS NULL)`)
      await tx.execute(sql`
        UPDATE accounts
           SET week_norm = CASE platform WHEN 'fansly' THEN ${JSON.stringify(NORM_FANSLY)}::jsonb
                                         ELSE ${JSON.stringify(NORM_ONLYFANS)}::jsonb END,
               default_assignee_id = CASE platform WHEN 'fansly' THEN ${diana.id}::uuid END,
               row_version = row_version + 1
         WHERE model_id = ${model.id}::uuid`)
      for (const [type, number, flag] of [
        ['PPV', 74, true],
        ['PPV', 66, null],
      ] as const) {
        await tx.execute(sql`
          UPDATE content_items SET has_second_person = ${flag}, row_version = row_version + 1
           WHERE model_id = ${model.id}::uuid AND type = ${type} AND number = ${number}`)
      }
      return { diana }
    },
  )
  const diana = actorOf(fixture.diana, model.code)
  const boss = actorOf(owner, model.code)

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })
  const week = weekDates(isoWeekOf(today))
  const yesterday = addDays(today, -1)
  const releaseDay =
    (week[3] as string) >= today ? (week[3] as string) : addDays(week[3] as string, 7)

  const put = async (
    actor: Actor,
    input: NewPlanRow,
    then?: (tx: Tx, id: string) => Promise<void>,
  ) =>
    as(db, actor, 'plan.createRows', async (tx) => {
      const state = await loadState(tx, model)
      const one = await resolveRow(tx, model, input)
      if (isRefusal(one)) throw new Error(`seed plan: ${input.item_id} ${one.text}`)
      const refusal = ruleRefusal(state, one)
      if (refusal) throw new Error(`seed plan: ${input.item_id} ${refusal.text}`)
      const id = await insertRow(tx, state, actor, one)
      const after = await loadState(tx, model)
      const created = after.rows.find((candidate) => candidate.id === id)
      if (created) await logRow(tx, after, created)
      return id
    }).then(async (id) => {
      if (then) await as(db, actor, 'plan.mark', (tx) => then(tx, id))
      return id
    })
  const confirm = (actor: Actor) => async (tx: Tx, id: string) => {
    const target = await rowById(tx, model, id, true)
    await setJournalItem(tx, target.item_id)
    await confirmMark(tx, model, target, actor, null)
  }
  const schedule = (actor: Actor) => async (tx: Tx, id: string) => {
    const target = await rowById(tx, model, id, true)
    await setMark(tx, model, target, actor, 'scheduled', null)
  }

  let count = 0
  const add = async (
    actor: Actor,
    input: NewPlanRow,
    then?: (tx: Tx, id: string) => Promise<void>,
  ) => {
    await put(actor, input, then)
    count += 1
  }

  // Yesterday: confirmed and missed.
  await add(
    diana,
    row({ item_id: 'SET-061', account: 'lora-1', surface: 'wall', date: yesterday, time: '20:00' }),
    confirm(diana),
  )
  await add(
    diana,
    row({ item_id: 'FYP-0402', account: 'lora-2', surface: 'fyp', date: yesterday, time: '03:00' }),
  )
  // Today: Diana's tasks on the Fansly pages and the owner's on OnlyFans.
  await add(
    diana,
    row({ item_id: 'FYP-0401', account: 'lora-1', surface: 'fyp', date: today, time: '03:00' }),
    confirm(diana),
  )
  await add(
    diana,
    row({
      item_id: 'FYP-0401',
      account: 'lora-2',
      surface: 'fyp',
      date: today,
      time: '03:00',
      fyp_version: { no: 1, level: 'soft' },
    }),
  )
  await add(
    diana,
    row({
      item_id: 'FYP-0401',
      account: 'lora-3',
      surface: 'fyp',
      date: today,
      time: '03:00',
      fyp_version: { no: 2, level: 'trim' },
    }),
    schedule(diana),
  )
  await add(
    diana,
    row({ item_id: 'SET-062', account: 'lora-1', surface: 'wall', date: today, time: '20:00' }),
  )
  await add(
    diana,
    row({ item_id: 'SET-063', account: 'lora-2', surface: 'wall', date: today, time: '20:00' }),
  )
  await add(diana, row({ item_id: 'LIFE-181', account: 'lora-2', surface: 'vault', date: today }))
  await add(
    boss,
    row({ item_id: 'PPV-070', account: 'lora-vip-of', surface: 'vault', date: today }),
  )
  await add(
    boss,
    row({ item_id: 'SET-064', account: 'lora-of', surface: 'wall', date: today, time: '19:00' }),
  )
  // The rest of the week: some places of the norm are filled, the others stay empty.
  for (const date of week) {
    if (date <= today) continue
    const weekday = weekdayIndex(date)
    if (weekday % 2 === 0) {
      await add(
        boss,
        row({
          item_id: `FYP-04${String(3 + weekday).padStart(2, '0')}`,
          account: 'lora-1',
          surface: 'fyp',
          date,
          time: '03:00',
        }),
      )
    }
    if (weekday !== 3) {
      await add(
        boss,
        row({
          item_id: `SET-06${5 + (weekday % 5)}`,
          account: 'lora-1',
          surface: 'wall',
          date,
          time: '20:00',
        }),
      )
    }
  }
  // A PPV release on two pages: wall, mass message, the story teaser, the vault the day before.
  await as(db, boss, 'plan.createRelease', async (tx) => {
    const state = await loadState(tx, model)
    for (const [account, cells] of [
      [
        'lora-1',
        [
          { surface: 'wall', date: releaseDay, time: '20:00' },
          { surface: 'dm', date: releaseDay, time: '20:10' },
          { surface: 'story', date: releaseDay, time: '20:05' },
          { surface: 'vault', date: addDays(releaseDay, -1), time: null },
        ],
      ],
      [
        'lora-vip-of',
        [
          { surface: 'wall', date: releaseDay, time: '21:00' },
          { surface: 'dm', date: releaseDay, time: '21:10' },
        ],
      ],
    ] as const) {
      const { rows } = await tx.execute<{ id: string; account_id: string; item_id: string }>(sql`
        INSERT INTO ppv_releases (model_id, account_id, item_id, release_date, created_by)
        SELECT ${model.id}::uuid, a.id, i.id, ${releaseDay}::date, ${boss.id}::uuid
          FROM accounts a, content_items i
         WHERE a.model_id = ${model.id}::uuid AND a.code = ${account}
           AND i.model_id = ${model.id}::uuid AND i.type = 'PPV' AND i.number = 73
        RETURNING id, account_id, item_id`)
      const release = rows[0]
      if (!release) throw new Error('seed plan: no release')
      for (const cell of cells) {
        const one = await resolveRow(
          tx,
          model,
          row({
            item_id: 'PPV-073',
            account,
            surface: cell.surface,
            date: cell.date,
            time: cell.time,
          }),
          release.id,
        )
        if (isRefusal(one) || ruleRefusal(state, one)) throw new Error('seed plan: release cell')
        await insertRow(tx, state, boss, one, { releaseId: release.id })
        count += 1
      }
    }
  })
  return { rows: count, skipped: false }
}
