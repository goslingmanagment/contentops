import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Db, SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import type { LegacyListingEntry } from '@contentops/legacy'
import { FIXTURE_REGISTRY } from '@contentops/legacy/fixture'
import { fakeBytes, recordingRetry } from '@contentops/sources/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchHandler } from '../intake/fetch'
import { drain, type IntakeHarness, intakeHarness, LORA_ROOT, setSwitch } from '../intake/testing'
import { createLogger } from '../logger'
import type { BlobStore } from '../media/storage'
import { registerBlob } from '../media/storage-ops'
import { tempStore } from '../media/testing'
import { buildServer } from '../server'
import { call, newKey, signIn } from '../testing/server'
import { unpackArchiveHandler } from './archive'
import { autoAcceptForDraft } from './auto-accept'
import { importBytes } from './bytes'
import { writeInputs } from './inputs'
import { enqueueImport } from './parse'
import type { ReconcileReport } from './reconcile'
import { snapshotOf } from './snapshot'
import { freezeDisk, plantDisk, runImport, runQueued, zipOf } from './testing'

/**
 * The byte half of stage 3 (SPEC §6.3 «Байты, папка за папкой», «Архивы», «Сверка») on a
 * fictional old disk: the local copy where its list allows, the API otherwise; numbers kept,
 * renumbered and corrected; archives unpacked once and split by their folders; a file changed,
 * moved and gone after the snapshot; the batch scope; the reconciliation; repeats.
 */

let h: IntakeHarness
let store: BlobStore
let app: ReturnType<typeof buildServer>
let owner: string
let copyRoot: string

const ctx = (action = 'test') => ({ actor: SYSTEM_ACTOR('test'), action, requestId: randomUUID() })

const file = (path: string, size: number, extra: Partial<LegacyListingEntry> = {}) => ({
  path: `disk:/${path}`,
  isDir: false,
  size,
  createdAt: '2026-08-01T10:00:00+00:00',
  ...extra,
})

const DISK: LegacyListingEntry[] = [
  file('1. PPV/Bundles/[PPV-023]_paint_body_21.11.2025/Роспись.mov', 3000),
  file('1. PPV/Bundles/[PPV-023]_ribbon_play_20.12.2025/7:12 с лентой .mov', 3100),
  file('1. PPV/Bundles/[PPV-070]_amber_dress_28.05.26/full.mov', 3200),
  file('1. PPV/Bundles/[PPV-070]_amber_dress_28.05.26/1.jpg', 900),
  file('1. PPV/[PPV-001]_lotus_pose_7min_03.03.2025/lotus.MOV', 3300),
  file('1. PPV/[PPV-066]_rope_stretch_6min_X.X.X/Растяжка.mov', 3400),
  file('1. PPV/Bundles/[PPV-066]_glitter_Teasing_5min_10.04.2026/glitter.mov', 3500),
  file('1. PPV/Bundles/[PPV-071]_slow_strip_tights_23.07.26/a.mov', 3600),
  file('1. PPV/Bundles/[PPV-071]_slow_strip_tights_23.07.26/b.mov', 3700),
  file('1. PPV/Bundles/[PPV-071]_slow_strip_tights_23.07.26/c.mov', 3800),
  file('1. PPV/Bundles/[PPV-072]_quick_tease_sun_30.07.26/x.mov', 3900),
  file('1. PPV/7.08.2026/IMG_8487.JPG', 800),
  file('1. PPV/Bundles/[PPV-069]_lace_tease_21.05.26/gone.mov', 4000),
  file('5. Sextings/sexting_012_satin_heels_30.05.26/1.jpg', 700),
  file('5. Sextings/sexting_012_satin_heels_30.05.26/2.jpg', 710),
  file('5. Sextings/notes.txt', 50),
  // A past pack of a promo contractor: one own photo, one the same bytes as a PPV photo.
  file('9. SMM/Twitter/zenpromo june/photos/june_photo_001.jpg', 300),
]

const PATH = (relative: string) => `${LORA_ROOT}/${relative}`

beforeAll(async () => {
  h = await intakeHarness()
  store = await tempStore('legacy-bytes')
  await setSwitch(h.db, 'ydisk.scan', h.modelId, true)
  await withActorTx(h.db, ctx(), (tx) =>
    tx.execute(sql`UPDATE id_counters SET legacy_reserved_at = NULL WHERE type IN ('PPV', 'SXT')`),
  )
  plantDisk(h.yandex.tree, LORA_ROOT, DISK)
  const t = h.yandex.tree
  // An archive with two numbered sextings inside, two equal archives, a broken one.
  t.addFile(
    PATH('5. Sextings/sexting feb.zip'),
    await zipOf({
      'sexting_010_lace_10.02.25/1.jpg': fakeBytes(600, 'sxt10-1'),
      'sexting_011_mesh_14.02.25/1.jpg': fakeBytes(610, 'sxt11-1'),
      'sexting_011_mesh_14.02.25/2.jpg': fakeBytes(620, 'sxt11-2'),
    }),
  )
  const extra = await zipOf({
    'a.jpg': fakeBytes(500, 'extra-a'),
    'b.jpg': fakeBytes(510, 'extra-b'),
  })
  t.addFile(PATH('5. Sextings/extra.zip'), extra)
  t.addFile(PATH('5. Sextings/extra (copy).zip'), extra)
  t.addFile(PATH('5. Sextings/broken.zip'), 2000)
  const amber = t.get(PATH('1. PPV/Bundles/[PPV-070]_amber_dress_28.05.26/1.jpg'))?.bytes as Buffer
  t.addFile(PATH('9. SMM/Twitter/zenpromo june/photos/june_photo_002.jpg'), amber)
  expect((await freezeDisk(h, '2026-11-02')).state).toBe('succeeded')

  // The local copy: some files on disk, one a placeholder, one with other bytes (SPEC §6.3).
  copyRoot = await mkdtemp(join(tmpdir(), 'ydisk-copy-'))
  const copy = async (relative: string, bytes: Buffer | null, present = true) => {
    const node = t.get(PATH(relative))
    const content = bytes ?? (node?.bytes as Buffer)
    // The copy holds the whole disk; the client wrote `:` as `-` (SPEC §6.3).
    const local = `${LORA_ROOT.slice(1)}/${relative}`.replaceAll(':', '-')
    await mkdir(join(copyRoot, 'disk', local, '..'), { recursive: true })
    if (present) await writeFile(join(copyRoot, 'disk', local), content)
    return {
      path: local,
      is_dir: false,
      size: content.length,
      last_write_utc: '2026-08-01T10:00:00Z',
      attributes: present ? 0x20 : 0x401620,
      bytes_present: present,
    }
  }
  const lines = [
    await copy('1. PPV/Bundles/[PPV-070]_amber_dress_28.05.26/full.mov', null),
    await copy('1. PPV/Bundles/[PPV-070]_amber_dress_28.05.26/1.jpg', null),
    await copy('1. PPV/[PPV-066]_rope_stretch_6min_X.X.X/Растяжка.mov', null, false),
    await copy(
      '1. PPV/Bundles/[PPV-023]_paint_body_21.11.2025/Роспись.mov',
      fakeBytes(3000, 'other'),
    ),
    await copy('1. PPV/Bundles/[PPV-069]_lace_tease_21.05.26/gone.mov', null),
    await copy('5. Sextings/sexting feb.zip', null),
  ]
  await writeFile(join(copyRoot, 'list.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'))

  store = await tempStore('legacy-bytes')
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
  await withActorTx(h.db, ctx(), (tx) =>
    writeInputs(tx, h.modelId, null, { registry: FIXTURE_REGISTRY }),
  )
  expect((await runImport(h.db, h.modelId, 'parse')).state).toBe('succeeded')
}, 90_000)
afterAll(async () => {
  await app?.close()
  await h?.close()
  if (copyRoot) await rm(copyRoot, { recursive: true, force: true })
})

const handlers = () => ({
  fetch: fetchHandler({
    factory: h.factory,
    store,
    fetchAheadGb: 25,
    retry: recordingRetry({ attempts: 1 }).policy,
    legacyCopy: { root: join(copyRoot, 'disk'), listFile: join(copyRoot, 'list.jsonl') },
  }),
  unpack_archive: unpackArchiveHandler({
    factory: h.factory,
    store,
    retry: recordingRetry({ attempts: 1 }).policy,
    legacyCopy: { root: join(copyRoot, 'disk'), listFile: join(copyRoot, 'list.jsonl') },
  }),
})

async function bytes(roots: string[], options: { folder?: string; force?: boolean } = {}) {
  const { work } = await withActorTx(h.db, ctx(), async (tx) => {
    const snapshot = await snapshotOf(tx, h.modelId, null)
    if (!snapshot) throw new Error('no snapshot')
    return enqueueImport(tx, {
      modelId: h.modelId,
      mode: 'bytes',
      snapshot,
      nonce: randomUUID(),
      input: { roots, folder: options.folder ?? null, force: options.force ?? false },
    })
  })
  return runQueued(h.db, work.id)
}

/** What the media works do for a draft, and the hook that follows «готово». */
async function makeReady(db: Db, draftId: string) {
  const { rows } = await db.execute<{ sha: string; path: string }>(sql`
    SELECT encode(source_sha256, 'hex') AS sha, path FROM inbox_drafts WHERE id = ${draftId}::uuid`)
  const { sha, path } = rows[0] as { sha: string; path: string }
  const staged = await store.staged(sha)
  if (!staged) throw new Error(`nothing staged for ${path}`)
  await registerBlob(db, store, {
    file: staged.path,
    sha256: sha,
    ext: staged.ext,
    mediaKind: /\.(mov|mp4)$/i.test(path) ? 'video' : 'image',
    owner: 'test:',
  })
  await withActorTx(db, ctx('work.succeeded'), async (tx) => {
    await tx.execute(sql`
      UPDATE inbox_drafts
         SET master_sha256 = source_sha256, master_is_source = true, master_verified_at = now(),
             state = 'ready', ready_at = now()
       WHERE id = ${draftId}::uuid AND state <> 'resolved'`)
    await tx.transaction((inner) => autoAcceptForDraft(inner, h.modelId, draftId))
  })
  await db.execute(sql`
    UPDATE work_operations SET state = 'cancelled', finished_at = now()
     WHERE draft_id = ${draftId}::uuid AND kind <> 'fetch' AND state = 'pending'`)
}

/** Every processing draft of the import becomes ready (the media works of a real stack). */
async function readyAll() {
  const { rows } = await h.db.execute<{ id: string }>(sql`
    SELECT d.id FROM inbox_drafts d JOIN inbox_groups g ON g.id = d.group_id
     WHERE d.state IN ('discovered', 'processing') AND d.source_sha256 IS NOT NULL
       AND d.blocked_reason IS NULL AND g.evidence ? 'legacy'
     ORDER BY d.path`)
  for (const row of rows) await makeReady(h.db, row.id)
}

async function items() {
  const { rows } = await h.db.execute<{ id: string; origin: string; files: number }>(sql`
    SELECT public_item_id(type, number) AS id, origin,
           (SELECT count(*)::int FROM item_memberships m
             WHERE m.model_id = i.model_id AND m.item_id = i.id AND m.removed_at IS NULL) AS files
      FROM content_items i ORDER BY type, number`)
  return rows
}

async function draftOf(relative: string) {
  const { rows } = await h.db.execute<{
    state: string
    outcome: string | null
    blocked: string | null
    route: string | null
    origin: string
  }>(sql`
    SELECT d.state, d.outcome, d.blocked_reason AS blocked, r.verified_route AS route, d.origin
      FROM inbox_drafts d JOIN source_revisions r ON r.id = d.source_revision_id
     WHERE r.frozen_path = ${`disk:${PATH(relative)}`}`)
  return rows[0]
}

/** Rows a repeat could change: all but the works and their journal. */
async function footprint() {
  const { rows } = await h.db.execute(sql`SELECT
    (SELECT count(*) FROM inbox_groups)::int AS groups,
    (SELECT count(*) FROM inbox_drafts)::int AS drafts,
    (SELECT count(*) FROM content_items)::int AS items,
    (SELECT count(*) FROM legacy_claims WHERE resolution = 'resolved')::int AS resolved,
    (SELECT count(*) FROM action_log WHERE entry_kind = 'change'
      AND subject_kind NOT IN ('work_operations'))::int AS changes`)
  return rows[0]
}

describe('the order of the import', () => {
  it('sextings wait until the PPV files are taken (SPEC §6.3)', async () => {
    const run = await bytes(['5. Sextings'])
    expect(run).toMatchObject({ state: 'failed', error_code: 'import_order' })
  })
})

describe('1. PPV', () => {
  it('a batch scope defers what is out of it: a draft, no download', async () => {
    const { rows } = await h.db.execute<{ id: string }>(sql`
      SELECT o.resource_id AS id FROM source_objects o
       WHERE o.resource_id IS NOT NULL AND NOT o.is_dir
         AND o.current_path NOT LIKE ${`%[PPV-072]%`}`)
    await withActorTx(h.db, ctx(), (tx) =>
      tx.execute(sql`
        INSERT INTO policy_settings (model_id, key, value)
        VALUES (${h.modelId}::uuid, 'import_batch_scope',
                ${JSON.stringify(rows.map((r) => r.id))}::jsonb)`),
    )
    // One folder first: the rest of the root later is a resume, not a second import.
    const first = await bytes(['1. PPV'], {
      folder: '1. PPV/Bundles/[PPV-070]_amber_dress_28.05.26',
    })
    expect(first.report).toMatchObject({ units: 1, drafts_new: 2, fetch_queued: 2 })
    const run = await bytes(['1. PPV'])
    expect(run.state).toBe('succeeded')
    expect(run.report).toMatchObject({ deferred: 1, groups_new: 9, drafts_new: 11 })
    expect(await draftOf('1. PPV/Bundles/[PPV-072]_quick_tease_sun_30.07.26/x.mov')).toMatchObject({
      blocked: 'deferred',
    })
  })

  it('bytes come from the copy where the list allows it, else from the API', async () => {
    // A file moved after the snapshot is found by the scan under its new path; one is gone.
    h.yandex.tree.move(
      PATH('1. PPV/[PPV-001]_lotus_pose_7min_03.03.2025/lotus.MOV'),
      PATH('1. PPV/[PPV-001]_lotus_pose_7min_03.03.2025/lotus pose.MOV'),
    )
    h.yandex.tree.remove(PATH('1. PPV/Bundles/[PPV-069]_lace_tease_21.05.26/gone.mov'))
    h.yandex.tree.remove(PATH('1. PPV/7.08.2026/IMG_8487.JPG'))
    const { scanHandler } = await import('../intake/scan')
    const scan = await (await import('../intake/testing')).runWork(h.db, {
      modelId: h.modelId,
      kind: 'scan',
      scope: h.sources.yandex.id,
      dataset: 'full',
      handlers: { scan: scanHandler(h.factory) },
    })
    expect(scan.state).toBe('succeeded')
    await drain(h.db, ['fetch'], handlers())
    expect(await draftOf('1. PPV/Bundles/[PPV-070]_amber_dress_28.05.26/full.mov')).toMatchObject({
      route: 'local_copy',
    })
    // A placeholder and other bytes in the copy go through the API.
    expect(await draftOf('1. PPV/[PPV-066]_rope_stretch_6min_X.X.X/Растяжка.mov')).toMatchObject({
      route: 'download',
    })
    expect(
      await draftOf('1. PPV/Bundles/[PPV-023]_paint_body_21.11.2025/Роспись.mov'),
    ).toMatchObject({ route: 'download' })
    expect(await draftOf('1. PPV/[PPV-001]_lotus_pose_7min_03.03.2025/lotus.MOV')).toMatchObject({
      route: 'download',
    })
    // Gone from the cloud: verified bytes of the copy are enough; without them it is blocked.
    expect(await draftOf('1. PPV/Bundles/[PPV-069]_lace_tease_21.05.26/gone.mov')).toMatchObject({
      route: 'local_copy',
    })
    expect(await draftOf('1. PPV/7.08.2026/IMG_8487.JPG')).toMatchObject({
      blocked: 'source_unavailable',
    })
  })

  it('what is settled accepts itself; collisions and typos wait for a person', async () => {
    await readyAll()
    console.log(
      JSON.stringify(
        (
          await h.db.execute(
            sql`SELECT g.group_key, g.proposed_type, g.evidence->>'queue' q, g.evidence->'number' n, array_agg(d.state || ':' || coalesce(d.blocked_reason,'') || ':' || coalesce(d.outcome,'') || ':' || (d.master_verified_at IS NOT NULL)) FROM inbox_groups g JOIN inbox_drafts d ON d.group_id = g.id GROUP BY 1,2,3,4`,
          )
        ).rows,
        null,
        1,
      ),
    )
    expect(await items()).toEqual([
      { id: 'PPV-001', origin: 'import', files: 1 },
      { id: 'PPV-066', origin: 'import', files: 1 },
      { id: 'PPV-069', origin: 'import', files: 1 },
      { id: 'PPV-070', origin: 'import', files: 2 },
    ])
    // Three videos in one PPV: a ◆ in «Приехало»; the rest of PPV waits in «Разбор старого».
    expect(
      await draftOf('1. PPV/Bundles/[PPV-071]_slow_strip_tights_23.07.26/a.mov'),
    ).toMatchObject({
      blocked: 'video_in_set',
    })
    const inbox = await call(app, { method: 'GET', url: '/api/v1/lora/inbox', as: owner })
    const kinds = (inbox.json().items as { state: { kind: string } }[]).map((i) => i.state.kind)
    expect(kinds.sort()).toEqual(['decision', 'error'])
  })

  it('«Так и сделать» on 023 and the typo accept the waiting folders with their numbers', async () => {
    const resolve = (id: string) =>
      call(app, {
        method: 'POST',
        url: `/api/v1/lora/legacy/disputes/${encodeURIComponent(id)}:resolve`,
        as: owner,
        key: newKey(),
        body: { option: 'proposal' },
      })
    expect((await resolve('number.PPV.23')).statusCode).toBe(200)
    const review = await call(app, { method: 'GET', url: '/api/v1/lora/legacy', as: owner })
    const typo = (review.json().disputes as { id: string; kind: string }[]).find(
      (d) => d.kind === 'number_typo',
    )
    expect((await resolve(typo?.id as string)).statusCode).toBe(200)
    // 023 keeps its number, the later folder gets the next of the counter (073), 066 → 067.
    expect((await items()).map((i) => i.id)).toEqual([
      'PPV-001',
      'PPV-023',
      'PPV-066',
      'PPV-067',
      'PPV-069',
      'PPV-070',
      'PPV-073',
    ])
    const { rows } = await h.db.execute<{ value: string; item: string }>(sql`
      SELECT a.value_raw AS value, public_item_id(i.type, i.number) AS item
        FROM aliases a JOIN content_items i ON i.id = a.item_id
       WHERE a.kind = 'legacy_id' ORDER BY 1`)
    expect(rows).toEqual([
      { value: 'PPV-023', item: 'PPV-073' },
      { value: 'PPV-066', item: 'PPV-067' },
    ])
    const { rows: moved } = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM aliases WHERE kind = 'legacy_path' AND value_raw LIKE '%lotus%'`)
    expect(moved[0]?.n).toBe(2)
    const { rows: claims } = await h.db.execute<{ kind: string; item: string }>(sql`
      SELECT c.claim_kind AS kind, public_item_id(i.type, i.number) AS item
        FROM legacy_claims c JOIN content_items i ON i.id = c.resolved_item_id
       WHERE c.claim_kind IN ('number', 'title', 'registry_row') ORDER BY 2, 1`)
    expect(claims).toContainEqual({ kind: 'number', item: 'PPV-070' })
    expect(claims).toContainEqual({ kind: 'title', item: 'PPV-070' })
    expect(claims).toContainEqual({ kind: 'registry_row', item: 'PPV-067' })
  })

  it('a repeat of the root changes no row', async () => {
    const before = await footprint()
    const again = await bytes(['1. PPV'])
    expect(again.report).toMatchObject({ groups_new: 0, drafts_new: 0, accepted_now: 0 })
    expect(await footprint()).toEqual(before)
  })
})

describe('5. Sextings and archives', () => {
  let featureGroup: string
  it('archives are unpacked once; a changed file waits on its next revision', async () => {
    h.yandex.tree.replace(PATH('5. Sextings/sexting_012_satin_heels_30.05.26/2.jpg'), 720)
    // The worker dies after two units of the root: what it wrote stays, the next run goes on.
    const { work } = await withActorTx(h.db, ctx(), async (tx) => {
      const snapshot = await snapshotOf(tx, h.modelId, null)
      if (!snapshot) throw new Error('no snapshot')
      return enqueueImport(tx, {
        modelId: h.modelId,
        mode: 'bytes',
        snapshot,
        nonce: randomUUID(),
        input: { roots: ['5. Sextings'], folder: null, force: false },
      })
    })
    let units = 0
    await expect(
      importBytes({
        work,
        db: h.db,
        signal: new AbortController().signal,
        checkpoint: async () => {
          units += 1
          if (units === 2) throw new Error('worker killed')
        },
      }),
    ).rejects.toThrow('worker killed')
    const run = await bytes(['5. Sextings'])
    expect(run.state).toBe('succeeded')
    // The stopped work is taken again by the runner and writes the two units it had left;
    // the new run finds everything in place: nothing twice.
    const { rows: resumed } = await h.db.execute<{
      state: string
      report: Record<string, unknown>
    }>(sql`SELECT state, report FROM work_operations WHERE id = ${work.id}::uuid`)
    expect(resumed[0]).toMatchObject({ state: 'succeeded', report: { units: 4, groups_new: 2 } })
    expect(run.report).toMatchObject({ units: 4, groups_new: 0, drafts_new: 0, not_media: 2 })
    await drain(h.db, ['fetch', 'unpack_archive'], handlers())
    const { rows } = await h.db.execute<{
      path: string
      blocked: string | null
      route: string
    }>(sql`
      SELECT d.path, d.blocked_reason AS blocked, r.verified_route AS route
        FROM inbox_drafts d JOIN source_revisions r ON r.id = d.source_revision_id
       WHERE d.origin = 'archive' ORDER BY d.path`)
    expect(
      rows.filter((r) => r.path.includes('sexting feb.zip')).map((r) => [r.blocked, r.route]),
    ).toEqual([
      ['archive_split', 'local_copy'],
      ['archive_split', 'local_copy'],
      ['archive_split', 'local_copy'],
    ])
    expect(rows.filter((r) => r.path.includes('extra')).every((r) => r.route === 'download')).toBe(
      true,
    )
    const { rows: dirs } = await h.db.execute<{ n: number }>(sql`
      SELECT count(DISTINCT r.source_sha256)::int AS n FROM source_revisions r
        JOIN source_objects o ON o.id = r.source_object_id
       WHERE o.current_name LIKE 'extra%.zip'`)
    expect(dirs[0]?.n).toBe(1)
    expect(await draftOf('5. Sextings/sexting_012_satin_heels_30.05.26/2.jpg')).toMatchObject({
      blocked: 'source_unavailable',
    })
    const { rows: groups } = await h.db.execute<{ id: string }>(sql`
      SELECT DISTINCT d.group_id AS id FROM inbox_drafts d WHERE d.blocked_reason = 'archive_split'`)
    featureGroup = groups[0]?.id as string
  })

  it('«Разделить архив» makes a group per numbered folder; equal archives alias', async () => {
    const split = await call(app, {
      method: 'POST',
      url: `/api/v1/lora/inbox/groups/${featureGroup}:decide`,
      as: owner,
      key: newKey(),
      body: { decision: 'split_archive', split: true },
    })
    expect(split.statusCode, `${featureGroup} ${split.body}`).toBe(200)
    await readyAll()
    const sxt = (await items()).filter((i) => i.id.startsWith('SXT'))
    expect(sxt).toEqual([
      { id: 'SXT-010', origin: 'import', files: 1 },
      { id: 'SXT-011', origin: 'import', files: 2 },
      // Its 2.jpg changed after the snapshot: the current revision goes in its place.
      { id: 'SXT-012', origin: 'import', files: 2 },
      // extra.zip: no number, the counter; its copy is an alias of the same bytes.
      { id: 'SXT-013', origin: 'import', files: 2 },
    ])
    const { rows } = await h.db.execute<{ outcome: string; n: number }>(sql`
      SELECT outcome, count(*)::int AS n FROM inbox_drafts
       WHERE path LIKE '%extra%' GROUP BY outcome ORDER BY outcome`)
    expect(rows).toEqual([
      { outcome: 'alias', n: 2 },
      { outcome: 'new_item', n: 2 },
    ])
  })
})

describe('9. SMM: past packs of contractors', () => {
  it('a folder becomes a collection of its channel; a marked pack a handoff «импорт»', async () => {
    await withActorTx(h.db, ctx(), async (tx) => {
      await tx.execute(sql`
        INSERT INTO promo_channels (model_id, code, title) VALUES (${h.modelId}::uuid, 'twitter', 'Twitter')`)
      await tx.execute(sql`
        INSERT INTO contractors (model_id, name) VALUES (${h.modelId}::uuid, 'Zen Promo')`)
    })
    const review = await call(app, { method: 'GET', url: '/api/v1/lora/legacy', as: owner })
    const pack = (review.json().disputes as { id: string; kind: string }[]).find(
      (d) => d.kind === 'smm_pack',
    )
    const marked = await call(app, {
      method: 'POST',
      url: `/api/v1/lora/legacy/disputes/${encodeURIComponent(pack?.id as string)}:resolve`,
      as: owner,
      key: newKey(),
      body: { option: 'pack', contractor: 'Zen Promo' },
    })
    expect(marked.statusCode).toBe(200)
    const run = await bytes(['9. SMM'], { force: true })
    expect(run.state).toBe('succeeded')
    await drain(h.db, ['fetch'], handlers())
    await readyAll()
    const { rows } = await h.db.execute<{
      id: string
      channel: string
      own: number
      links: number
    }>(sql`
      SELECT public_item_id(i.type, i.number) AS id, c.code AS channel,
             count(*) FILTER (WHERE m.kind = 'owned')::int AS own,
             count(*) FILTER (WHERE m.kind = 'reference')::int AS links
        FROM content_items i
        JOIN promo_channels c ON c.id = i.promo_channel_id
        JOIN item_memberships m ON m.item_id = i.id AND m.removed_at IS NULL
       WHERE i.type = 'PRM' GROUP BY 1, 2`)
    expect(rows).toEqual([{ id: 'PRM-001', channel: 'twitter', own: 1, links: 1 }])
    const { rows: handoffs } = await h.db.execute<{
      origin: string
      state: string
      files: number
      sent_at: string | null
    }>(sql`
      SELECT p.origin, p.state, m.entry_count AS files, p.sent_at FROM promo_deliveries p
        JOIN asset_manifests m ON m.id = p.manifest_id`)
    expect(handoffs).toEqual([{ origin: 'import', state: 'sent', files: 2, sent_at: null }])
  })
})

describe('the reconciliation with the snapshot', () => {
  let report: ReconcileReport
  it('every revision has exactly one outcome, the roots add up, nothing unexplained', async () => {
    const started = await call(app, {
      method: 'POST',
      url: '/api/v1/lora/legacy:reconcile',
      as: owner,
      key: newKey(),
    })
    expect(started.statusCode).toBe(202)
    const id = started.json().operation_id as string
    expect((await runQueued(h.db, id)).state).toBe('succeeded')
    const op = await call(app, { method: 'GET', url: started.json().status_url, as: owner })
    report = op.json().report as ReconcileReport
    expect(report.totals).toMatchObject({ files: 22, members: 7, unexplained: 0 })
    expect(report.files.every((root) => root.adds_up)).toBe(true)
    expect(report.files.find((r) => r.root === 'PPV')?.outcomes).toMatchObject({
      accepted: 8,
      blocked: 5,
    })
    expect(report.reasons).toMatchObject({
      'blocked:deferred': 1,
      'blocked:video_in_set': 3,
      'blocked:source_unavailable': 1,
      'blocked:archive_unreadable': 1,
    })
    expect(
      Object.keys(report.reasons).some((r) => r.startsWith('blocked:changed_after_snapshot')),
    ).toBe(true)
    expect(report.members.find((r) => r.root === 'Архивы')?.outcomes).toMatchObject({
      accepted: 5,
      alias: 2,
    })
  })

  it('a repeat changes no row', async () => {
    const before = await footprint()
    const again = await runImport(h.db, h.modelId, 'reconcile')
    expect(again.state).toBe('succeeded')
    expect((again.report as unknown as ReconcileReport).totals).toEqual(report.totals)
    expect(await footprint()).toEqual(before)
  })
})
