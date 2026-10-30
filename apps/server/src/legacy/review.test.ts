import { randomUUID } from 'node:crypto'
import type { Dispute, LegacyReview } from '@contentops/contracts/domain/legacy'
import { bootstrap, type Db, SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { FIXTURE_DISK, FIXTURE_REGISTRY } from '@contentops/legacy/fixture'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type IntakeHarness,
  intakeBootstrap,
  intakeHarness,
  LORA_ROOT,
  setSwitch,
} from '../intake/testing'
import { createLogger } from '../logger'
import { tempStore } from '../media/testing'
import { buildServer } from '../server'
import { createCatalogItems } from '../testing/catalog-factory'
import { call, newKey, signIn } from '../testing/server'
import { materializeClaims } from './materialize'
import { freezeDisk, plantDisk, runImport } from './testing'

/**
 * «Разбор старого» on the server (DESIGN §4.9, SPEC §6.3–6.4): labels → pages with examples,
 * number decisions, the cases of the pass, and the claims of confirmed labels becoming
 * placements with evidence `import`.
 */

let h: IntakeHarness
let app: ReturnType<typeof buildServer>
let owner: string

const ctx = () => ({ actor: SYSTEM_ACTOR('test'), action: 'test.fixture', requestId: randomUUID() })

/** Fictional extras of the disk: a posted set with its photos. */
const EXTRA = [
  {
    path: 'disk:/4. Sets/Posted sets/set_на_подоконнике_11.07.25(used_all)/IMG_5001.JPG',
    isDir: false,
    size: 800,
  },
  {
    path: 'disk:/4. Sets/Posted sets/set_на_подоконнике_11.07.25(used_all)/IMG_5002.JPG',
    isDir: false,
    size: 800,
  },
]

async function review(): Promise<LegacyReview> {
  const response = await call(app, { method: 'GET', url: '/api/v1/lora/legacy', as: owner })
  expect(response.statusCode).toBe(200)
  return response.json()
}

async function resolve(dispute: string, body: Record<string, unknown>) {
  return call(app, {
    method: 'POST',
    url: `/api/v1/lora/legacy/disputes/${encodeURIComponent(dispute)}:resolve`,
    as: owner,
    key: newKey(),
    body,
  })
}

const byTitle = (r: LegacyReview, part: string) =>
  r.disputes.find((d) => d.title.includes(part)) as Dispute

async function objectId(db: Db, name: string): Promise<string> {
  const { rows } = await db.execute<{ id: string }>(sql`
    SELECT id FROM source_objects WHERE current_name = ${name} AND NOT is_dir`)
  const row = rows[0]
  if (!row) throw new Error(`no object ${name}`)
  return row.id
}

/** An object of the catalog whose files came from these source objects (as acceptance links). */
async function acceptAs(
  db: Db,
  spec: Parameters<typeof createCatalogItems>[2][number],
  names: readonly string[],
) {
  const [item] = await createCatalogItems(db, 'lora', [spec])
  if (!item) throw new Error('no item')
  const files = [...item.files.values()]
  await withActorTx(db, ctx(), async (tx) => {
    for (const [index, name] of names.entries()) {
      const file = files[index] ?? files[0]
      if (!file) throw new Error('no file')
      const id = await objectId(db, name)
      await tx.execute(sql`
        INSERT INTO aliases (model_id, kind, value_raw, asset_id, source_object_id)
        SELECT model_id, 'legacy_path', current_path, ${file.assetId}::uuid, id
          FROM source_objects WHERE id = ${id}::uuid`)
    }
  })
  return item
}

async function placements(db: Db) {
  const { rows } = await db.execute<{
    item: string
    account: string
    surface: string
    occurred: string | null
    precision: string
    files: number
    evidence: string
  }>(sql`
    SELECT i.type || '-' || i.number AS item, a.code AS account, s.kind AS surface,
           to_char(p.occurred_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS occurred,
           p.event_precision AS precision,
           (SELECT count(*)::int FROM placement_assets x
             WHERE x.model_id = p.model_id AND x.placement_id = p.id) AS files,
           (SELECT string_agg(e.source || '/' || e.kind || '/' || e.strength, ',')
              FROM placement_evidence e
             WHERE e.model_id = p.model_id AND e.placement_id = p.id) AS evidence
      FROM placements p
      JOIN accounts a ON a.model_id = p.model_id AND a.id = p.account_id
      JOIN surfaces s ON s.model_id = p.model_id AND s.id = p.surface_id
      JOIN content_items i ON i.model_id = p.model_id AND i.id = p.item_id
     ORDER BY 1, 2, 4`)
  return rows
}

beforeAll(async () => {
  h = await intakeHarness()
  // Three Fansly pages and OnlyFans, as Лора has them; another model whose archive is parked.
  const config = intakeBootstrap()
  const lora = config.models[0] as (typeof config.models)[number]
  lora.accounts = [
    { code: 'lora-1', platform: 'fansly', title: 'Fansly 1', handle: 'LoraVie' },
    { code: 'lora-2', platform: 'fansly', title: 'Fansly 2', handle: 'LoraViex' },
    { code: 'lora-3', platform: 'fansly', title: 'Fansly 3', handle: 'LoraViexx' },
    { code: 'lora-of', platform: 'onlyfans', title: 'OF Free', handle: 'loravie' },
  ]
  await bootstrap(
    h.db,
    {
      ...config,
      models: [
        lora,
        {
          code: 'bea',
          title: 'Bea',
          title_genitive: 'Bea',
          accounts: [],
          id_counters: lora.id_counters,
        },
      ],
    },
    { env: { CONTENTOPS_OWNER_PASSWORD: 'owner-password' } },
  )
  await setSwitch(h.db, 'ydisk.scan', h.modelId, true)
  plantDisk(h.yandex.tree, LORA_ROOT, [...FIXTURE_DISK, ...EXTRA])
  expect((await freezeDisk(h, '2026-11-02')).state).toBe('succeeded')
  const store = await tempStore('legacy-review')
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
  const inputs = await call(app, {
    method: 'PUT',
    url: '/api/v1/lora/legacy/inputs',
    as: owner,
    key: newKey(),
    body: { registry: FIXTURE_REGISTRY },
  })
  expect(inputs.statusCode).toBe(200)
  expect((await runImport(h.db, h.modelId, 'parse')).state).toBe('succeeded')
}, 90_000)
afterAll(async () => {
  await app?.close()
  await h?.close()
})

describe('«Разбор старого» after the metadata pass', () => {
  it('shows every label with examples and the page the rule proposes, nothing confirmed', async () => {
    const r = await review()
    const labels = Object.fromEntries(r.labels.map((l) => [l.label, l]))
    expect(labels.used3).toMatchObject({
      target: null,
      proposed: { kind: 'accounts', accounts: ['lora-3'] },
    })
    expect(labels.used3?.examples.map((e) => e.name)).toEqual([
      'used3_04.08.26_used2_31.07.26.mov',
      'used3_12.07.JPG',
    ])
    expect(labels.used_all?.proposed).toEqual({
      kind: 'accounts',
      accounts: ['lora-1', 'lora-2', 'lora-3'],
    })
    expect(labels.posted_folder?.proposed).toBe(null)
    expect(r.progress).toMatchObject({ processed_folders: 0 })
    expect(r.progress.total_folders).toBeGreaterThan(20)
    expect(r.progress.roots.map((root) => root.root)).toEqual([
      'PPV',
      'Секстинги',
      'Сеты',
      'Кастомы',
      'FYP',
      'Остальное',
      'SMM',
      'Архивы',
      '«Старый формат»',
    ])
  })

  it('lists the disputes of the pass by kind, the foreign archive postponed', async () => {
    const r = await review()
    const kinds = (kind: string) => r.disputes.filter((d) => d.kind === kind)
    expect(kinds('number_taken').map((d) => d.title)).toEqual([
      'PPV-023 у двух папок',
      'PPV-032 у трёх папок',
    ])
    expect(byTitle(r, 'PPV-032').proposal).toBe(
      'cocoa_cup оставляет 032, pumpkin_night и tweed_suit получают новые номера',
    )
    expect(kinds('number_typo').map((d) => [d.title, d.proposal])).toEqual([
      ['[PPV-066]_glitter_Teasing_5min_10.04.2026 — в реестре 067', 'PPV-067'],
    ])
    expect(kinds('number_no_trace').map((d) => d.title)).toEqual([
      'SXT-010: следов нет',
      'SXT-011: следов нет',
    ])
    expect(kinds('unparsed').map((d) => d.fragment)).toEqual(['al'])
    expect(kinds('smm_pack')).toHaveLength(2)
    expect(kinds('archive_broken').length).toBeGreaterThanOrEqual(2)
    expect(kinds('foreign_archive')).toEqual([
      expect.objectContaining({ postponed: 'Отложено до подключения: Bea', resolved: null }),
    ])
    const inbox = await call(app, { method: 'GET', url: '/api/v1/lora/inbox', as: owner })
    expect(inbox.json().legacy_disputes).toBe(r.progress.unresolved)
  })
})

describe('number decisions', () => {
  it('«Так и сделать» confirms the proposal of PPV-032 with the author', async () => {
    const response = await resolve('number.PPV.32', { option: 'proposal' })
    expect(response.statusCode).toBe(200)
    const dispute = byTitle(response.json(), 'PPV-032')
    expect(dispute.resolved).toMatchObject({ option: 'proposal', by: 'Владелец' })
    const { rows } = await h.db.execute<{ decided: number }>(sql`
      SELECT count(*)::int AS decided FROM legacy_number_claims
       WHERE claimed_number = 32 AND decided_by IS NOT NULL`)
    // Three folders and their three registry rows.
    expect(rows[0]?.decided).toBe(6)
  })

  it('a choice by folder swaps who keeps 023; two folders keeping one number are refused', async () => {
    const twice = await resolve('number.PPV.23', {
      option: 'folders',
      folders: {
        '[PPV-023]_ribbon_play_20.12.2025': 'keep',
        '[PPV-023]_paint_body_21.11.2025': 'keep',
      },
    })
    expect(twice.statusCode).toBe(400)
    const swapped = await resolve('number.PPV.23', {
      option: 'folders',
      folders: {
        '[PPV-023]_ribbon_play_20.12.2025': 'keep',
        '[PPV-023]_paint_body_21.11.2025': 'new_number',
      },
    })
    expect(swapped.statusCode).toBe(200)
    const dispute = byTitle(swapped.json(), 'PPV-023')
    expect(dispute.folders.map((f) => [f.name, f.proposal])).toEqual([
      ['[PPV-023]_paint_body_21.11.2025', 'new_number'],
      ['[PPV-023]_ribbon_play_20.12.2025', 'keep'],
    ])
    expect(dispute.resolved).not.toBe(null)
  })

  it('the typo 066 → 067 is confirmed in one click', async () => {
    const r = await review()
    const typo = r.disputes.find((d) => d.kind === 'number_typo') as Dispute
    const response = await resolve(typo.id, { option: 'proposal' })
    expect(byTitle(response.json(), 'glitter').resolved).toMatchObject({ by: 'Владелец' })
  })

  it('«Неясно» leaves a case in the queue and writes the journal', async () => {
    const r = await review()
    const smm = r.disputes.find((d) => d.kind === 'smm_pack') as Dispute
    const response = await resolve(smm.id, { option: 'unclear' })
    expect(response.statusCode).toBe(200)
    expect((response.json() as LegacyReview).disputes.find((d) => d.id === smm.id)?.resolved).toBe(
      null,
    )
    const { rows } = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM action_log
       WHERE action = 'legacy.unclear' AND subject_label = ${smm.title} AND actor_label = 'Владелец'`)
    expect(rows[0]?.n).toBe(1)
  })
})

describe('the cases of the pass', () => {
  it('an SMM folder is marked as a pack, a hole is reserved by a find with its reason', async () => {
    const r = await review()
    const smm = r.disputes.find((d) => d.kind === 'smm_pack') as Dispute
    expect((await resolve(smm.id, { option: 'pack' })).statusCode).toBe(200)
    const hole = byTitle(r, 'SXT-010')
    expect((await resolve(hole.id, { option: 'reserve' })).statusCode).toBe(400)
    const done = await resolve(hole.id, {
      option: 'reserve',
      reason: 'альбом vault «SXT-010 Кружево»',
    })
    expect(byTitle(done.json(), 'SXT-010').resolved).toMatchObject({ option: 'reserve' })
    const { rows } = await h.db.execute<{ resolution: unknown }>(sql`
      SELECT resolution FROM review_cases WHERE dedup_key = 'hole:SXT-010'`)
    expect(rows[0]?.resolution).toEqual({
      option: 'reserve',
      reason: 'альбом vault «SXT-010 Кружево»',
    })
  })

  it('an unparsed name is ignored with a reason: its unknown fragment leaves the queue', async () => {
    const r = await review()
    const unparsed = r.disputes.find((d) => d.kind === 'unparsed') as Dispute
    expect((await resolve(unparsed.id, { option: 'assign', type: 'fyp' })).statusCode).toBe(400)
    const done = await resolve(unparsed.id, { option: 'ignore', reason: 'обрывок метки' })
    expect(done.statusCode).toBe(200)
    const { rows } = await h.db.execute<{ resolution: string }>(sql`
      SELECT resolution FROM legacy_claims WHERE claim_kind = 'unknown' AND raw_fragment = 'al'`)
    expect(rows.map((row) => row.resolution)).toEqual(['ignored'])
    expect((await resolve(unparsed.id, { option: 'ignore', reason: 'ещё раз' })).statusCode).toBe(
      422,
    )
  })
})

describe('labels confirmed by the КМ become placements with evidence `import`', () => {
  let fyp: string
  let set: string
  beforeAll(async () => {
    // Acceptance links accepted files to their source objects (aliases by `resource_id`).
    const fypItem = await acceptAs(
      h.db,
      { type: 'fyp', number: 331, files: [{ role: 'master' }] },
      ['used3_04.08.26_used2_31.07.26.mov'],
    )
    fyp = fypItem.id
    const setItem = await acceptAs(
      h.db,
      { type: 'set', number: 40, files: [{ role: 'ed' }, { role: 'ed' }] },
      ['IMG_5001.JPG', 'IMG_5002.JPG'],
    )
    set = setItem.id
    // A life object has no single surface: its claim stays a claim.
    await acceptAs(h.db, { type: 'life', number: 7, files: [{ role: 'pic' }] }, [
      'IMG_2552(used1_12.07).JPG',
    ])
  })

  it('nothing is placed before the labels are saved', async () => {
    expect(await placements(h.db)).toEqual([])
  })

  it('«Сохранить» writes the labels with the author and places the claims', async () => {
    const r = await review()
    const labels = r.labels.map((l) => ({
      label: l.label,
      target: l.proposed ?? { kind: 'unknown' },
    }))
    const response = await call(app, {
      method: 'PUT',
      url: '/api/v1/lora/legacy/labels',
      as: owner,
      key: newKey(),
      body: { labels },
    })
    expect(response.statusCode).toBe(200)
    expect((response.json() as LegacyReview).labels.every((l) => l.target !== null)).toBe(true)
    expect(await placements(h.db)).toEqual([
      // used2_31.07.26 and used3_04.08.26 of one FYP file: two pages, the FYP surface, by day.
      {
        item: 'FYP-331',
        account: 'lora-2',
        surface: 'fyp',
        occurred: '2026-07-31',
        precision: 'day',
        files: 1,
        evidence: 'import/legacy_claim/claim',
      },
      {
        item: 'FYP-331',
        account: 'lora-3',
        surface: 'fyp',
        occurred: '2026-08-04',
        precision: 'day',
        files: 1,
        evidence: 'import/legacy_claim/claim',
      },
      // `(used_all)` of the set folder: the three historical pages, the wall, no date.
      {
        item: 'SET-40',
        account: 'lora-1',
        surface: 'wall',
        occurred: null,
        precision: 'unknown',
        files: 2,
        evidence: 'import/legacy_claim/claim',
      },
      {
        item: 'SET-40',
        account: 'lora-2',
        surface: 'wall',
        occurred: null,
        precision: 'unknown',
        files: 2,
        evidence: 'import/legacy_claim/claim',
      },
      {
        item: 'SET-40',
        account: 'lora-3',
        surface: 'wall',
        occurred: null,
        precision: 'unknown',
        files: 2,
        evidence: 'import/legacy_claim/claim',
      },
    ])
    const { rows } = await h.db.execute<{ name: string; fragment: string; resolution: string }>(sql`
      SELECT o.current_name AS name, c.raw_fragment AS fragment,
             c.resolution || CASE WHEN c.resolved_evidence_id IS NULL THEN '' ELSE ' → улика' END
               AS resolution
        FROM legacy_claims c JOIN source_objects o ON o.model_id = c.model_id AND o.id = c.source_object_id
       WHERE c.claim_kind IN ('used', 'posted')
         AND o.current_name IN ('used3_04.08.26_used2_31.07.26.mov',
                                'set_на_подоконнике_11.07.25(used_all)', 'IMG_2552(used1_12.07).JPG')
       ORDER BY 1, 2`)
    expect(rows).toEqual([
      // A life object has no single surface: the claim waits.
      { name: 'IMG_2552(used1_12.07).JPG', fragment: 'used1_12.07', resolution: 'pending' },
      {
        name: 'set_на_подоконнике_11.07.25(used_all)',
        fragment: 'used_all',
        resolution: 'resolved → улика',
      },
      {
        name: 'used3_04.08.26_used2_31.07.26.mov',
        fragment: 'used2_31.07.26',
        resolution: 'resolved → улика',
      },
      {
        name: 'used3_04.08.26_used2_31.07.26.mov',
        fragment: 'used3_04.08.26',
        resolution: 'resolved → улика',
      },
    ])
    const { rows: journal } = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM action_log
       WHERE action = 'legacy.saveLabels' AND subject_kind = 'policy_settings'
         AND actor_label = 'Владелец' AND entry_kind = 'action'`)
    expect(journal[0]?.n).toBe(labels.length)
  })

  it('stories and mass messages never come from names', async () => {
    const { rows } = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM placements p
        JOIN surfaces s ON s.model_id = p.model_id AND s.id = p.surface_id
       WHERE s.kind IN ('story', 'mass_dm')`)
    expect(rows[0]?.n).toBe(0)
  })

  it('an object accepted later is placed by the acceptance, a dm PPV goes to the vault', async () => {
    const item = await acceptAs(
      h.db,
      { type: 'ppv', number: 1, ppvKind: 'dm', files: [{ role: 'master' }] },
      ['PPV_Лотос_7мин_03.03.25_кастом_Orion(Used1).MOV'],
    )
    const id = await objectId(h.db, 'PPV_Лотос_7мин_03.03.25_кастом_Orion(Used1).MOV')
    await withActorTx(h.db, ctx(), (tx) =>
      materializeClaims(tx, h.modelId, null, { objectIds: [id] }),
    )
    const placed = (await placements(h.db)).filter((p) => p.item === `PPV-1`)
    expect(item.id).toBe('PPV-001')
    expect(placed).toEqual([
      expect.objectContaining({ account: 'lora-1', surface: 'vault', precision: 'unknown' }),
    ])
  })

  it('a claim of newer rules adds its evidence to the same placement', async () => {
    await withActorTx(h.db, ctx(), async (tx) => {
      await tx.execute(sql`
        INSERT INTO legacy_claims (model_id, source_object_id, parser_version, claim_key,
                                   raw_fragment, claim_kind, payload, parse_work_id)
        SELECT model_id, source_object_id, 'legacy-names@2', claim_key, raw_fragment, claim_kind,
               payload, parse_work_id
          FROM legacy_claims WHERE raw_fragment = 'used3_04.08.26'`)
      await materializeClaims(tx, h.modelId, null)
    })
    const fypPlacements = (await placements(h.db)).filter((p) => p.item === fyp.replace(/-0+/, '-'))
    expect(fypPlacements).toHaveLength(2)
    expect(fypPlacements.find((p) => p.account === 'lora-3')?.evidence).toBe(
      'import/legacy_claim/claim,import/legacy_claim/claim',
    )
    expect(set).toBe('SET-040')
  })
})
