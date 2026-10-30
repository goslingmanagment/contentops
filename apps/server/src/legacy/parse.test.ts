import { randomUUID } from 'node:crypto'
import { type Db, enqueueWork, SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { type LegacyListingEntry, PARSER_VERSION, parseLegacyName } from '@contentops/legacy'
import { FIXTURE_DISK, FIXTURE_REGISTRY } from '@contentops/legacy/fixture'
import { fakeBytes } from '@contentops/sources/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { issueNumber } from '../catalog/numbers'
import { type IntakeHarness, intakeHarness, LORA_ROOT, setSwitch } from '../intake/testing'
import { createLogger } from '../logger'
import { tempStore } from '../media/testing'
import { buildServer } from '../server'
import { call, newKey, signIn } from '../testing/server'
import type { ImportReport } from './parse'
import { freezeDisk, plantDisk, rerunParse, runImport, runQueued, zipOf } from './testing'

/**
 * Stage 3 (PLAN «Готово, когда», SPEC §6.3–6.4): the metadata pass over a frozen snapshot of a
 * fictional old disk in the shapes of the real one, through the real `scan:freeze`.
 */

const ctx = (label: string) => ({
  actor: SYSTEM_ACTOR('test'),
  action: label,
  requestId: randomUUID(),
})

/** The number a type would issue now; the transaction rolls back, nothing is spent. */
async function wouldIssue(db: Db, modelId: string, type: 'PPV' | 'SET' | 'SXT') {
  const rollback = new Error('rollback')
  let outcome: number | string = ''
  await withActorTx(db, ctx('test.issue'), async (tx) => {
    try {
      outcome = await issueNumber(tx, modelId, type)
    } catch (error) {
      outcome = (error as { code?: string }).code ?? String(error)
    }
    throw rollback
  }).catch((error: unknown) => {
    if (error !== rollback) throw error
  })
  return outcome
}

async function numberClaims(db: Db) {
  const { rows } = await db.execute<{
    type: string
    claimed: number
    decision: string
    assigned: number | null
    name: string
    registry: boolean
    decided_by: string | null
  }>(sql`
    SELECT n.type, n.claimed_number AS claimed, n.decision, n.assigned_number AS assigned,
           o.current_name AS name, c.claim_kind = 'registry_row' AS registry, n.decided_by
      FROM legacy_number_claims n
      JOIN legacy_claims c ON c.model_id = n.model_id AND c.id = n.claim_id
      JOIN source_objects o ON o.model_id = n.model_id AND o.id = n.source_object_id
     WHERE c.resolution <> 'ignored'
     ORDER BY n.type, n.claimed_number, o.current_name`)
  return rows
}

const folder = (rows: Awaited<ReturnType<typeof numberClaims>>, part: string) =>
  rows.find((row) => !row.registry && row.name.includes(part))

async function counters(db: Db) {
  const { rows } = await db.execute<{
    type: string
    next_number: number
    reserved: boolean
    work: string | null
  }>(sql`
    SELECT type, next_number, legacy_reserved_at IS NOT NULL AS reserved,
           legacy_reserved_work_id AS work
      FROM id_counters ORDER BY type`)
  return Object.fromEntries(rows.map((row) => [row.type, row]))
}

async function cases(db: Db, kind?: string) {
  const { rows } = await db.execute<{
    kind: string
    dedup_key: string
    state: string
    title: string
    path: string | null
  }>(sql`
    SELECT kind, dedup_key, state, details ->> 'title' AS title, details ->> 'path' AS path
      FROM review_cases WHERE ${kind ?? null}::text IS NULL OR kind = ${kind ?? null}
     ORDER BY kind, dedup_key`)
  return rows
}

/** Rows that a pass could change: everything but the work rows and their journal. */
async function footprint(db: Db) {
  const { rows } = await db.execute(sql`SELECT
    (SELECT count(*) FROM legacy_claims)::int AS claims,
    (SELECT count(*) FROM legacy_claims WHERE resolution = 'ignored')::int AS ignored,
    (SELECT count(*) FROM legacy_number_claims)::int AS numbers,
    (SELECT count(*) FROM review_cases)::int AS cases,
    (SELECT count(*) FROM source_objects)::int AS objects,
    (SELECT string_agg(type || ':' || next_number || ':' || updated_at, ',' ORDER BY type)
       FROM id_counters) AS counters,
    (SELECT count(*) FROM action_log
      WHERE entry_kind = 'change' AND subject_kind <> 'work_operations')::int AS changes`)
  return rows[0]
}

/** Types with legacy numbers wait for the pass, as bootstrap leaves them for a real model. */
async function legacyTypes(db: Db, modelId: string, types: string[]) {
  await withActorTx(db, ctx('test.legacy'), (tx) =>
    tx.execute(sql`
      UPDATE id_counters SET legacy_reserved_at = NULL
       WHERE model_id = ${modelId}::uuid AND type = ANY (${sql.param(types)}::text[])`),
  )
}

describe('the metadata pass over the fictional disk', () => {
  let h: IntakeHarness
  let app: ReturnType<typeof buildServer>
  let owner: string
  let ownerId: string
  let dryRun: ImportReport

  beforeAll(async () => {
    h = await intakeHarness()
    await setSwitch(h.db, 'ydisk.scan', h.modelId, true)
    await legacyTypes(h.db, h.modelId, ['PPV', 'SET', 'SXT'])
    const { rows } = await h.db.execute<{ id: string }>(
      sql`SELECT id FROM principals WHERE login = 'owner'`,
    )
    ownerId = (rows[0] as { id: string }).id
    plantDisk(h.yandex.tree, LORA_ROOT, FIXTURE_DISK, {
      // One sexting folder named inside the archive: SXT-011 has a source, SXT-010 none.
      '5. Sextings/sexting feb.zip': await zipOf({
        'feb/sexting_011_mesh_dress_14.02.25/1.jpg': fakeBytes(900, 'sxt-11-1'),
        'feb/sexting_011_mesh_dress_14.02.25/2.jpg': fakeBytes(900, 'sxt-11-2'),
      }),
    })
    const frozen = await freezeDisk(h, '2026-11-02')
    expect(frozen.state).toBe('succeeded')
    const store = await tempStore('legacy')
    app = buildServer({
      db: h.db,
      publicUrl: 'http://localhost:5173',
      secrets: { hub: false },
      sourceEnv: {},
      logger: createLogger({ level: 'silent' }),
      storage: store.roots,
    })
    await app.ready()
    owner = await signIn(app, 'owner', 'owner-password')
  }, 60_000)
  afterAll(async () => {
    await app?.close()
    await h?.close()
  })

  it('accept gives no PPV number before the pass: the counter is not reserved', async () => {
    expect(await wouldIssue(h.db, h.modelId, 'PPV')).toBe('number_not_issued')
  })

  it('the dry run reports collisions, the typo, the reserve and labels, and writes nothing', async () => {
    const inputs = await call(app, {
      method: 'PUT',
      url: '/api/v1/lora/legacy/inputs',
      as: owner,
      key: newKey(),
      body: { registry: FIXTURE_REGISTRY },
    })
    expect(inputs.json()).toEqual({ registry_rows: 12, vault_albums: 0 })
    const before = await footprint(h.db)
    const started = await call(app, {
      method: 'POST',
      url: '/api/v1/lora/legacy:plan',
      as: owner,
      key: newKey(),
    })
    expect(started.statusCode).toBe(202)
    const { operation_id: id, status_url: url } = started.json()
    expect((await runQueued(h.db, id)).state).toBe('succeeded')
    const operation = (await call(app, { method: 'GET', url, as: owner })).json()
    expect(operation).toMatchObject({ kind: 'legacy_plan', state: 'done' })
    const run = { report: operation.report }
    dryRun = run.report as unknown as ImportReport
    expect(dryRun.mode).toBe('plan')
    expect(dryRun.registry_rows).toBe(12)
    expect(dryRun.collisions.map((c) => `${c.type}-${c.number}:${c.resolution}`)).toEqual([
      'PPV-23:earliest_keeps',
      'PPV-32:earliest_keeps',
    ])
    expect(dryRun.typos).toEqual([
      expect.objectContaining({ claimedNumber: 66, registryNumber: 67 }),
    ])
    expect(dryRun.reserve.find((r) => r.type === 'PPV')).toMatchObject({ maxClaimed: 72, next: 73 })
    expect(dryRun.sextings.map((s) => `${s.number}:${s.status}`)).toEqual(['10:hole', '11:reserve'])
    expect(dryRun.labels.map((l) => l.label)).toContain('used3')
    expect(dryRun.unparsed.map((u) => u.path)).toEqual([
      '2. FYP/Posted/August 2025 (posted)/posted/al_used_all).MOV',
    ])
    expect(dryRun.smmFolders).toHaveLength(2)
    expect(dryRun.oldFormat.map((f) => f.folder)).toEqual(['FYP', 'PPV', 'Sets'])
    expect(await footprint(h.db)).toEqual(before)
    expect((await counters(h.db)).PPV).toMatchObject({ next_number: 1, reserved: false })
  })

  it('an old version of the rules left open claims and a decision of a person', async () => {
    // What a pass of rules version 0 would have written: an open claim, a decided number.
    await withActorTx(h.db, ctx('test.old-rules'), async (tx) => {
      const { work } = await enqueueWork(tx, {
        modelId: h.modelId,
        kind: 'import_parse',
        workKey: 'import:parse:old',
        dataset: 'parse',
      })
      // It ran long ago: no runner takes it again.
      await tx.execute(sql`
        UPDATE work_operations SET state = 'succeeded', started_at = now(), finished_at = now()
         WHERE id = ${work.id}::uuid`)
      const { rows } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM source_objects WHERE current_name = '[PPV-032]_tweed_suit_05.11.2025'`)
      const tweed = (rows[0] as { id: string }).id
      const { rows: claims } = await tx.execute<{ id: string; kind: string }>(sql`
        INSERT INTO legacy_claims (model_id, source_object_id, parser_version, claim_key,
                                   raw_fragment, claim_kind, payload, parse_work_id)
        SELECT ${h.modelId}::uuid, ${tweed}::uuid, 'legacy-names@0', k.key, k.fragment, k.kind,
               '{}'::jsonb, ${work.id}::uuid
          FROM (VALUES (${keyOf('[PPV-032]_tweed_suit_05.11.2025', 'number')}, '[PPV-032]', 'number'),
                       ('gone:unknown:0', 'tweed', 'unknown')) AS k(key, fragment, kind)
        RETURNING id, claim_kind AS kind`)
      const numberClaim = claims.find((c) => c.kind === 'number') as { id: string }
      await tx.execute(sql`
        INSERT INTO legacy_number_claims (model_id, type, claimed_number, source_object_id,
                                          claim_id, decision, decided_at, decided_by)
        VALUES (${h.modelId}::uuid, 'PPV', 32, ${tweed}::uuid, ${numberClaim.id}::uuid, 'unclear',
                now(), ${ownerId}::uuid)`)
    })
  })

  let parse: ImportReport
  it('the pass writes claims, number claims with §6.4 decisions and cases, then reserves', async () => {
    const run = await runImport(h.db, h.modelId, 'parse')
    expect(run.state).toBe('succeeded')
    parse = run.report as unknown as ImportReport
    expect(parse.written?.claims_new).toBeGreaterThan(150)

    const numbers = await numberClaims(h.db)
    // 023: bodyart-like paint_body is the earliest and keeps it, ribbon_play gets a new one.
    expect(folder(numbers, 'paint_body')).toMatchObject({ decision: 'keep', assigned: 23 })
    expect(folder(numbers, 'ribbon_play')).toMatchObject({ decision: 'renumber', assigned: null })
    // 032: three folders, the earliest keeps; tweed carries the person's «неясно» of rules 0.
    expect(folder(numbers, 'cocoa_cup')).toMatchObject({ decision: 'keep', assigned: 32 })
    expect(folder(numbers, 'pumpkin_night')).toMatchObject({ decision: 'renumber' })
    expect(folder(numbers, 'tweed_suit')).toMatchObject({
      decision: 'unclear',
      decided_by: ownerId,
    })
    // 066 → 067: the shimmer-like folder is a typo, the registry number wins; 066 stays.
    expect(folder(numbers, 'glitter_Teasing')).toMatchObject({
      claimed: 66,
      decision: 'typo',
      assigned: 67,
    })
    expect(folder(numbers, 'rope_stretch')).toMatchObject({ decision: 'keep', assigned: 66 })
    // 070–072 are on the disk only and keep their numbers.
    for (const n of [70, 71, 72]) {
      expect(numbers.filter((row) => row.claimed === n)).toEqual([
        expect.objectContaining({ decision: 'keep', assigned: n, registry: false }),
      ])
    }
    // Every registry row is a number claim of its own.
    expect(numbers.filter((row) => row.registry)).toHaveLength(12)
    // SXT-011 named inside the archive is kept; SXT-010 has no source and stays a hole.
    expect(numbers.filter((row) => row.type === 'SXT').map((row) => row.claimed)).toEqual([
      1, 2, 9, 11, 12,
    ])

    const c = await counters(h.db)
    expect(c.PPV).toMatchObject({ next_number: 73, reserved: true, work: run.id })
    expect(c.SET).toMatchObject({ next_number: 3, reserved: true })
    expect(c.SXT).toMatchObject({ next_number: 13, reserved: true })
    // Types already reserved by bootstrap keep their mark and their work (none).
    expect(c.CUS).toMatchObject({ next_number: 1, reserved: true, work: null })

    expect((await cases(h.db, 'number_hole')).map((row) => [row.dedup_key, row.state])).toEqual([
      ['hole:SXT-010', 'open'],
    ])
    expect((await cases(h.db, 'legacy_unparsed')).map((row) => row.path)).toEqual([
      '2. FYP/Posted/August 2025 (posted)/posted/al_used_all).MOV',
    ])
    expect((await cases(h.db, 'smm_folder')).map((row) => row.path).sort()).toEqual([
      '9. SMM/Twitter/zenpromo june/photos',
      '9. SMM/YT/Mirko/декабрь - ASMR - 6 видео /1 video',
    ])
    const shorts = await cases(h.db, 'merge_split')
    expect(shorts.map((row) => row.title)).toContain('Сырьё из 1 файла · 28.07')
  })

  it('an unreadable archive is incomplete input: its case is open and the pass went through', async () => {
    const unreadable = await cases(h.db, 'unreadable_input')
    expect(unreadable.map((row) => row.title)).toEqual(['Архив не читается', 'Архив не читается'])
    expect(
      parse.archives
        .filter((a) => a.incomplete)
        .map((a) => a.path)
        .sort(),
    ).toEqual(['Bea FYP — монтаж (КМ) — 2026-08-18.zip', 'archive-2025-11-04_01-02-03.zip'])
  })

  it('the open claims of the old rules are ignored, with the successor where there is one', async () => {
    const { rows } = await h.db.execute<{
      fragment: string
      resolution: string
      successor: string | null
    }>(sql`
      SELECT old.raw_fragment AS fragment, old.resolution, succ.parser_version AS successor
        FROM legacy_claims old
        LEFT JOIN legacy_claims succ ON succ.model_id = old.model_id AND succ.id = old.superseded_by_id
       WHERE old.parser_version = 'legacy-names@0' ORDER BY old.raw_fragment`)
    expect(rows).toEqual([
      { fragment: '[PPV-032]', resolution: 'ignored', successor: PARSER_VERSION },
      { fragment: 'tweed', resolution: 'ignored', successor: null },
    ])
  })

  it('accept issues numbers after the reserve: the next PPV is 073', async () => {
    expect(await wouldIssue(h.db, h.modelId, 'PPV')).toBe(73)
    expect(await wouldIssue(h.db, h.modelId, 'SXT')).toBe(13)
  })

  it('the same rules again find the same work, and a re-run changes no row', async () => {
    const before = await footprint(h.db)
    const again = await runImport(h.db, h.modelId, 'parse')
    expect(again.created).toBe(false)
    const rerun = await rerunParse(h.db, h.modelId)
    expect(rerun.state).toBe('succeeded')
    expect((rerun.report as unknown as ImportReport).written).toMatchObject({
      claims_new: 0,
      superseded: 0,
      number_claims_new: 0,
      cases_new: {},
    })
    expect(await footprint(h.db)).toEqual(before)
  })

  it('every write of the pass is in the journal with the work', async () => {
    const { rows } = await h.db.execute<{ subject_kind: string; n: number }>(sql`
      SELECT subject_kind, count(*)::int AS n FROM action_log
       WHERE action IN ('legacy.parse', 'legacy.reserve') AND work_id IS NOT NULL
       GROUP BY subject_kind ORDER BY subject_kind`)
    const kinds = Object.fromEntries(rows.map((row) => [row.subject_kind, row.n]))
    expect(kinds.legacy_claims).toBeGreaterThan(150)
    expect(kinds.legacy_number_claims).toBeGreaterThan(20)
    expect(kinds.review_cases).toBeGreaterThan(3)
    expect(kinds.work_operations).toBe(2)
  })
})

describe('a pass whose archive names both sextings', () => {
  let h: IntakeHarness
  beforeAll(async () => {
    h = await intakeHarness()
    await setSwitch(h.db, 'ydisk.scan', h.modelId, true)
    await legacyTypes(h.db, h.modelId, ['SXT'])
    const disk: LegacyListingEntry[] = FIXTURE_DISK.filter(
      (entry) => entry.path.startsWith('disk:/5. Sextings') && !entry.path.endsWith('.zip'),
    )
    plantDisk(h.yandex.tree, LORA_ROOT, disk)
    h.yandex.tree.addFile(
      `${LORA_ROOT}/5. Sextings/sexting feb.zip`,
      await zipOf({
        'sexting_010_lace_10.02.25/1.jpg': fakeBytes(500, 'sxt-10'),
        'sexting_011_mesh_14.02.25/1.jpg': fakeBytes(500, 'sxt-11'),
      }),
    )
    expect((await freezeDisk(h, '2026-11-03')).state).toBe('succeeded')
  }, 60_000)
  afterAll(async () => {
    await h?.close()
  })

  it('reserves SXT-010 and SXT-011 and opens no hole', async () => {
    const run = await runImport(h.db, h.modelId, 'parse')
    expect(run.state).toBe('succeeded')
    const report = run.report as unknown as ImportReport
    expect(report.sextings.map((s) => `${s.number}:${s.status}`)).toEqual([
      '10:reserve',
      '11:reserve',
    ])
    expect(await cases(h.db, 'number_hole')).toEqual([])
    expect((await counters(h.db)).SXT).toMatchObject({ next_number: 13, reserved: true })
  })
})

/** The claim key of a name's first fragment of a kind, as the parser makes it. */
function keyOf(name: string, kind: string): string {
  const claim = parseLegacyName(name, { isDir: true }).find((c) => c.kind === kind)
  if (!claim) throw new Error(`${name}: no ${kind}`)
  return claim.claim_key
}
