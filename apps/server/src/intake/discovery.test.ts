import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scanHandler, scanStreams } from './scan'
import {
  type IntakeHarness,
  intakeCounts,
  intakeHarness,
  LORA_ROOT,
  runWork,
  setSwitch,
} from './testing'

/** SPEC §6.1, PLAN 2в: discovery from both clouds behind one interface, with fakes. */

let h: IntakeHarness
const day = (iso: string) => new Date(iso)

beforeAll(async () => {
  h = await intakeHarness({ recentLimit: 3, pageSize: 4 })
  await setSwitch(h.db, 'ydisk.scan', h.modelId, true)
  await setSwitch(h.db, 'dropbox.scan', h.modelId, true)
})
afterAll(() => h?.close())

const scan = (kind: 'yandex' | 'dropbox', dataset: 'recent' | 'full' = 'recent') =>
  runWork(h.db, {
    modelId: h.modelId,
    kind: 'scan',
    scope: h.sources[kind].id,
    dataset,
    handlers: { scan: scanHandler(h.factory) },
  })

async function groups(sourceId: string) {
  const { rows } = await h.db.execute<{
    group_key: string
    grouping: string
    proposed_type: string | null
    proposed_title: string | null
    files: string[]
  }>(sql`
    SELECT g.group_key, g.grouping, g.proposed_type, g.proposed_title,
           array_agg(d.path ORDER BY d.path) AS files
      FROM inbox_groups g JOIN inbox_drafts d ON d.model_id = g.model_id AND d.group_id = g.id
     WHERE g.source_id = ${sourceId}::uuid
     GROUP BY g.model_id, g.id ORDER BY min(d.path)`)
  return rows
}

describe('discovery from Dropbox', () => {
  beforeAll(() => {
    const t = h.dropbox.tree
    t.addFile(`${LORA_ROOT}/2. Sets/Set A/01.jpg`, 1000)
    t.addFile(`${LORA_ROOT}/2. Sets/Set A/02.jpg`, 1100)
    t.addFile(`${LORA_ROOT}/3. Customs/12:30 вся в красном.mov`, 3000)
    const at = (iso: string) => ({ created: day(iso), modified: day(iso) })
    t.addFile(`${LORA_ROOT}/8. Other/x.jpg`, 700, at('2026-10-21T10:00:00Z'))
    t.addFile(`${LORA_ROOT}/8. Other/y.jpg`, 710, at('2026-10-21T10:30:00Z'))
    t.addFile(`${LORA_ROOT}/8. Other/z.jpg`, 720, at('2026-10-21T12:00:00Z'))
    t.addFile(`${LORA_ROOT}/notes.txt`, 10)
  })

  it('a draft appears at discovery, grouped by folder id and upload cluster', async () => {
    const first = await scan('dropbox')
    expect(first.state).toBe('succeeded')
    // The first recent pass has no cursor: it traverses.
    expect(first.report).toMatchObject({ mode: 'full', complete: true, files: 7, drafts: 6 })
    const found = await groups(h.sources.dropbox.id)
    expect(
      found.map((g) => [g.grouping, g.proposed_type, g.proposed_title, g.files.length]),
    ).toEqual([
      ['folder', 'SET', 'Set A', 2],
      ['single', 'CUS', 'вся в красном', 1],
      ['upload_cluster', null, null, 2],
      ['upload_cluster', null, null, 1],
    ])
    expect(found[0]?.group_key).toMatch(/^folder:id:/)
    // A text file is a fact of the source, not a draft.
    const { rows } = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM source_objects WHERE current_name = 'notes.txt'`)
    expect(rows[0]?.n).toBe(1)
    const { rows: drafts } = await h.db.execute<{ state: string; origin: string }>(sql`
      SELECT DISTINCT state, origin FROM inbox_drafts`)
    expect(drafts).toEqual([{ state: 'discovered', origin: 'disk_scan' }])
  })

  it('a repeat changes nothing', async () => {
    const before = await intakeCounts(h.db)
    await scan('dropbox', 'full')
    const again = await scan('dropbox')
    expect(again.report).toMatchObject({ mode: 'recent', files: 0 })
    expect(await intakeCounts(h.db)).toEqual(before)
  })

  it('a rename or move is a new path of the same object, the draft follows its folder', async () => {
    h.dropbox.tree.move(`${LORA_ROOT}/2. Sets/Set A/01.jpg`, `${LORA_ROOT}/2. Sets/Set B/01.jpg`)
    const before = await intakeCounts(h.db)
    await scan('dropbox')
    const after = await intakeCounts(h.db)
    expect(after.drafts).toBe(before.drafts)
    expect(after.revisions).toBe(before.revisions)
    expect(after.paths).toBe(before.paths + 2) // the file and the new folder
    const moved = (await groups(h.sources.dropbox.id)).find((g) => g.proposed_title === 'Set B')
    expect(moved?.files).toEqual([`${LORA_ROOT}/2. Sets/Set B/01.jpg`])
  })

  it('A → B → A gives three revisions and three drafts', async () => {
    const path = `${LORA_ROOT}/2. Sets/Set A/02.jpg`
    const original = h.dropbox.tree.get(path)?.bytes as Buffer
    h.dropbox.tree.replace(path, 1234)
    await scan('dropbox')
    h.dropbox.tree.replace(path, original)
    await scan('dropbox')
    const { rows } = await h.db.execute<{ sequence_no: number; drafts: number }>(sql`
      SELECT r.sequence_no, count(d.id)::int AS drafts
        FROM source_revisions r
        JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
        LEFT JOIN inbox_drafts d ON d.model_id = r.model_id AND d.source_revision_id = r.id
       WHERE o.current_name = '02.jpg' GROUP BY r.sequence_no ORDER BY r.sequence_no`)
    expect(rows).toEqual([
      { sequence_no: 1, drafts: 1 },
      { sequence_no: 2, drafts: 1 },
      { sequence_no: 3, drafts: 1 },
    ])
  })

  it('a reset cursor becomes a full traversal without duplicates', async () => {
    const before = await intakeCounts(h.db)
    h.dropbox.resetCursors()
    const run = await scan('dropbox')
    expect(run.report).toMatchObject({ mode: 'full', complete: true })
    expect(await intakeCounts(h.db)).toEqual(before)
  })
})

describe('losses (SPEC §6.1)', () => {
  const file = `${LORA_ROOT}/8. Other/z.jpg`
  const away = '/Elsewhere/z.jpg'

  async function lost() {
    const { rows } = await h.db.execute<{ gone: boolean; blocked: string | null }>(sql`
      SELECT o.gone_since IS NOT NULL AS gone, d.blocked_reason AS blocked
        FROM source_objects o
        JOIN source_revisions r ON r.model_id = o.model_id AND r.source_object_id = o.id
        JOIN inbox_drafts d ON d.model_id = r.model_id AND d.source_revision_id = r.id
       WHERE o.current_name = 'z.jpg' AND o.source_id = ${h.sources.dropbox.id}::uuid`)
    return rows[0]
  }

  it('only after two complete traversals, never after an interrupted one', async () => {
    h.dropbox.tree.move(file, away)
    await scan('dropbox', 'full')
    expect(await lost()).toEqual({ gone: false, blocked: null })

    h.dropbox.fail('server_error', { endpoint: 'files/list_folder/continue', times: 5 })
    const broken = await scan('dropbox', 'full')
    h.dropbox.clearFailures()
    expect(broken.state).not.toBe('succeeded')
    expect(await lost()).toEqual({ gone: false, blocked: null })

    await scan('dropbox', 'full')
    expect(await lost()).toEqual({ gone: true, blocked: 'source_unavailable' })
  })

  it('a file found again lifts the block by itself', async () => {
    h.dropbox.tree.move(away, file)
    await scan('dropbox', 'full')
    expect(await lost()).toEqual({ gone: false, blocked: null })
  })
})

describe('Yandex Disk', () => {
  it('files right in a root go by their EXIF day', async () => {
    const t = h.yandex.tree
    t.addFile(`${LORA_ROOT}/3. Customs/a.jpg`, 900, { shotAt: day('2026-10-20T10:00:00Z') })
    t.addFile(`${LORA_ROOT}/3. Customs/b.jpg`, 950, { shotAt: day('2026-10-20T18:00:00Z') })
    t.addFile(`${LORA_ROOT}/3. Customs/c.jpg`, 960, { shotAt: day('2026-10-22T09:00:00Z') })
    await scan('yandex')
    const found = await groups(h.sources.yandex.id)
    expect(found.map((g) => [g.grouping, g.proposed_type, g.files.length])).toEqual([
      ['exif_day', 'CUS', 2],
      ['exif_day', 'CUS', 1],
    ])
    expect(found[0]?.group_key).toMatch(/^exif-day:.+:2026-10-20$/)
  })

  it('a full recent window becomes a full traversal', async () => {
    const t = h.yandex.tree
    for (let n = 1; n <= 5; n++) {
      t.addFile(`${LORA_ROOT}/1. PPV/Bundle ${n}/master.mp4`, 2000 + n, {
        created: day(`2026-10-2${n}T10:00:00Z`),
      })
    }
    const first = await scan('yandex')
    expect(first.report).toMatchObject({ mode: 'full', drafts: 5 })
    const again = await scan('yandex')
    expect(again.report).toMatchObject({ mode: 'recent', drafts: 0 })
    for (let n = 6; n <= 9; n++) {
      t.addFile(`${LORA_ROOT}/1. PPV/Bundle ${n}/master.mp4`, 2000 + n, {
        created: day(`2026-10-2${n}T12:00:00Z`),
      })
    }
    // Four new files do not fit a window of three: traverse.
    const behind = await scan('yandex')
    expect(behind.report).toMatchObject({ mode: 'full', drafts: 4 })
    const types = await groups(h.sources.yandex.id)
    expect(types.filter((g) => g.grouping === 'folder').map((g) => g.proposed_type)).toEqual(
      Array(9).fill('PPV'),
    )
  })

  it('429 waits, 5xx retries, a refused token stops and holds the stream', async () => {
    h.yandex.fail('rate_limit', { retryAfter: 120, times: 3 })
    const limited = await scan('yandex')
    expect(limited).toMatchObject({ state: 'retry_wait', error_code: 'rate_limited' })
    h.yandex.clearFailures()

    h.yandex.fail('server_error', { times: 3 })
    const down = await scan('yandex')
    expect(down).toMatchObject({ state: 'retry_wait', error_code: 'transient' })
    h.yandex.clearFailures()

    // The database clock: the Docker VM may run behind or ahead of the host.
    const { rows: clock } = await h.db.execute<{ at: string }>(sql`SELECT now()::text AS at`)
    const since = new Date(
      (clock[0] as { at: string }).at.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'),
    )
    h.yandex.fail('unauthorized', { times: 10 })
    const refused = await scan('yandex')
    h.yandex.clearFailures()
    expect(refused).toMatchObject({ state: 'failed', error_code: 'auth_rejected' })
    const env = { TEST_YDISK: 'x', TEST_DROPBOX: 'y' }
    const streams = await scanStreams(h.db, env, since)
    expect(streams.map((s) => s.scope)).not.toContain(h.sources.yandex.id)
    expect(streams.map((s) => s.scope)).toContain(h.sources.dropbox.id)
    // After a restart (a new token) the stream is back.
    const later = await scanStreams(h.db, env, new Date(Date.now() + 60_000))
    expect(later.map((s) => s.scope)).toContain(h.sources.yandex.id)
  })

  it('switched off: no request; switched on: catches up without duplicates', async () => {
    await setSwitch(h.db, 'ydisk.scan', h.modelId, false)
    h.yandex.tree.addFile(`${LORA_ROOT}/1. PPV/Bundle 10/master.mp4`, 3010)
    const calls = h.yandex.requests.length
    const paused = await scan('yandex')
    expect(paused).toMatchObject({ state: 'retry_wait', paused_reason: 'switch_off:ydisk.scan' })
    expect(h.yandex.requests.length).toBe(calls)

    const before = await intakeCounts(h.db)
    await setSwitch(h.db, 'ydisk.scan', h.modelId, true)
    await scan('yandex', 'full')
    const after = await intakeCounts(h.db)
    expect(after.drafts).toBe(before.drafts + 1)
    await scan('yandex', 'full')
    expect((await intakeCounts(h.db)).drafts).toBe(after.drafts)
  })
})
