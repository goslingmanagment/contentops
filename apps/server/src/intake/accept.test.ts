import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { recordingRetry } from '@contentops/sources/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '../context'
import { createLogger } from '../logger'
import type { BlobStore } from '../media/storage'
import { registerBlob } from '../media/storage-ops'
import { tempStore } from '../media/testing'
import { buildServer } from '../server'
import { call, newKey, signIn } from '../testing/server'
import { acceptGroup } from './accept'
import { draftZipExport } from './draft-files'
import { fetchHandler } from './fetch'
import { scanHandler } from './scan'
import { sweepStaging } from './staging'
import { drain, type IntakeHarness, intakeHarness, LORA_ROOT, runWork, setSwitch } from './testing'

/**
 * The byte chain and the accept transaction (SPEC §6.1, §4.1, schema §5, §9.3, §9.4) on fake
 * sources. The media works themselves are tested with real tools in `*.media.test.ts`; here a
 * draft's master is what `derive_image` / `encode_master` would leave: the staged bytes
 * registered as a blob and verified.
 */

let h: IntakeHarness
let store: BlobStore
let app: ReturnType<typeof buildServer>
let owner: string
let ownerActor: Actor
const model = () => ({ id: h.modelId, code: 'lora', name: 'Лора' })

beforeAll(async () => {
  h = await intakeHarness()
  store = await tempStore('intake')
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
  const { rows } = await h.db.execute<{ id: string }>(
    sql`SELECT id FROM principals WHERE login = 'owner'`,
  )
  ownerActor = {
    type: 'person',
    id: rows[0]?.id as string,
    role: 'owner',
    models: ['lora'],
    name: 'Владелец',
    gender: 'm',
    sessionId: null,
    tokenId: null,
  }
  await setSwitch(h.db, 'dropbox.scan', h.modelId, true)
})
afterAll(async () => {
  await app?.close()
  await h?.close()
})

const fetch = () =>
  fetchHandler({
    factory: h.factory,
    store,
    fetchAheadGb: 25,
    retry: recordingRetry({ attempts: 2 }).policy,
  })

async function scan() {
  return runWork(h.db, {
    modelId: h.modelId,
    kind: 'scan',
    scope: h.sources.dropbox.id,
    dataset: 'full',
    handlers: { scan: scanHandler(h.factory) },
  })
}

/** Runs every queued fetch. */
const fetchAll = () => drain(h.db, ['fetch'], { fetch: fetch() })

/** What the media works leave for a draft: its master registered and verified. */
async function makeReady(draftId: string) {
  const { rows } = await h.db.execute<{ sha: string }>(sql`
    SELECT encode(source_sha256, 'hex') AS sha FROM inbox_drafts WHERE id = ${draftId}::uuid`)
  const sha = rows[0]?.sha as string
  const staged = await store.staged(sha)
  if (!staged) throw new Error(`nothing staged for ${draftId}`)
  await registerBlob(h.db, store, {
    file: staged.path,
    sha256: sha,
    ext: staged.ext,
    mediaKind: staged.ext === 'mp4' ? 'video' : 'image',
    owner: 'test:',
  })
  await withActorTx(
    h.db,
    { actor: SYSTEM_ACTOR('test'), action: 'test', requestId: randomUUID() },
    (tx) =>
      tx.execute(sql`
      UPDATE inbox_drafts
         SET master_sha256 = source_sha256, master_is_source = true, master_verified_at = now(),
             state = 'ready', ready_at = now()
       WHERE id = ${draftId}::uuid`),
  )
  // The media works of the draft are done.
  await h.db.execute(sql`
    UPDATE work_operations SET state = 'cancelled', finished_at = now()
     WHERE draft_id = ${draftId}::uuid AND kind <> 'fetch' AND state = 'pending'`)
}

async function groupOfPath(path: string) {
  const { rows } = await h.db.execute<{ group_id: string; draft_id: string }>(sql`
    SELECT group_id, id AS draft_id FROM inbox_drafts WHERE path = ${path}
     ORDER BY discovered_at DESC LIMIT 1`)
  const row = rows[0]
  if (!row) throw new Error(`no draft for ${path}`)
  return row
}

async function counter(type: string) {
  const { rows } = await h.db.execute<{ next: number }>(sql`
    SELECT next_number AS next FROM id_counters WHERE model_id = ${h.modelId}::uuid AND type = ${type}`)
  return rows[0]?.next
}

const accept = (group: string, key = newKey(), body: object = { as: 'default' }) =>
  call(app, {
    method: 'POST',
    url: `/api/v1/lora/inbox/groups/${group}:accept`,
    as: owner,
    key,
    body,
  })

describe('fetch (SPEC §6.1)', () => {
  it('stages checked bytes, writes the hash and queues the media of the draft', async () => {
    h.dropbox.tree.addFile(`${LORA_ROOT}/6. Life/Кухня/01.jpg`, 3000)
    h.dropbox.tree.addFile(`${LORA_ROOT}/6. Life/Кухня/02.mp4`, 5000)
    await scan()
    const outcomes = await fetchAll()
    expect(outcomes.map((o) => o.state)).toEqual(['succeeded', 'succeeded'])
    const { rows } = await h.db.execute<{
      path: string
      state: string
      verified: boolean
      kinds: string[]
    }>(sql`
      SELECT d.path, d.state, r.verified_at IS NOT NULL AS verified,
             array(SELECT w.kind FROM work_operations w WHERE w.draft_id = d.id AND w.kind <> 'fetch'
                   ORDER BY w.kind) AS kinds
        FROM inbox_drafts d JOIN source_revisions r ON r.id = d.source_revision_id
       WHERE d.path LIKE ${`${LORA_ROOT}/6. Life/Кухня/%`} ORDER BY d.path`)
    expect(rows).toEqual([
      {
        path: `${LORA_ROOT}/6. Life/Кухня/01.jpg`,
        state: 'processing',
        verified: true,
        kinds: ['derive_image'],
      },
      {
        path: `${LORA_ROOT}/6. Life/Кухня/02.mp4`,
        state: 'processing',
        verified: true,
        kinds: ['derive_video', 'encode_master'],
      },
    ])
  })

  it('resumes after a cut from the bytes it already has', async () => {
    h.dropbox.tree.addFile(`${LORA_ROOT}/6. Life/Длинный/01.jpg`, 200_000)
    await scan()
    // A cut after 50 kB, then the source is down longer than one attempt waits.
    h.dropbox.fail('cut', { endpoint: 'files/download', afterBytes: 50_000 })
    h.dropbox.fail('server_error', { endpoint: 'files/download', times: 5 })
    const [cut] = await fetchAll()
    expect(cut?.state).toBe('retry_wait')
    h.dropbox.clearFailures()
    await h.db.execute(
      sql`UPDATE work_operations SET next_attempt_at = now() WHERE id = ${cut?.id}::uuid`,
    )
    const [done] = await fetchAll()
    expect(done?.state).toBe('succeeded')
    expect(Number(done?.report?.resumed_from)).toBe(50_000)
  })

  it('bytes that changed during the download go to the next revision', async () => {
    // Dropbox downloads are pinned to the observed `rev`; Yandex Disk serves what is there now.
    const path = `${LORA_ROOT}/6. Life/Меняется/01.jpg`
    await setSwitch(h.db, 'ydisk.scan', h.modelId, true)
    h.yandex.tree.addFile(path, 4000)
    await runWork(h.db, {
      modelId: h.modelId,
      kind: 'scan',
      scope: h.sources.yandex.id,
      dataset: 'full',
      handlers: { scan: scanHandler(h.factory) },
    })
    h.yandex.tree.replace(path, 4000)
    await fetchAll()
    const { rows } = await h.db.execute<{ sequence_no: number; blocked: string | null }>(sql`
      SELECT r.sequence_no, d.blocked_reason AS blocked FROM inbox_drafts d
        JOIN source_revisions r ON r.id = d.source_revision_id
       WHERE d.path = ${`disk:${path}`} ORDER BY r.sequence_no`)
    expect(rows).toEqual([
      { sequence_no: 1, blocked: 'source_unavailable' },
      { sequence_no: 2, blocked: null },
    ])
  })
})

describe('a file gone before its fetch', () => {
  it('blocks the draft «исходник недоступен» instead of failing the work', async () => {
    // Dropbox still serves a removed file's revision; Yandex Disk answers 404.
    const path = `${LORA_ROOT}/6. Life/Исчез/01.jpg`
    await setSwitch(h.db, 'ydisk.scan', h.modelId, true)
    h.yandex.tree.addFile(path, 3300)
    await runWork(h.db, {
      modelId: h.modelId,
      kind: 'scan',
      scope: h.sources.yandex.id,
      dataset: 'full',
      handlers: { scan: scanHandler(h.factory) },
    })
    h.yandex.tree.remove(path)
    const [work] = await fetchAll()
    expect(work?.state).toBe('succeeded')
    expect(String(work?.report?.changed ?? work?.report?.vanished)).toMatch(/gone|true/)
    const { rows } = await h.db.execute<{ blocked: string | null }>(sql`
      SELECT blocked_reason AS blocked FROM inbox_drafts WHERE path = ${`disk:${path}`}`)
    expect(rows[0]?.blocked).toBe('source_unavailable')
  })
})

describe('accept (schema §5, §9.3)', () => {
  it('is refused without a verified master and never thins the group', async () => {
    const { group_id } = await groupOfPath(`${LORA_ROOT}/6. Life/Кухня/01.jpg`)
    const response = await accept(group_id)
    expect(response.statusCode).toBe(422)
    expect(response.json().details).toMatchObject({ reason: 'not_ready' })
  })

  it('issues the next number for a type without legacy and resolves the drafts', async () => {
    const one = await groupOfPath(`${LORA_ROOT}/6. Life/Кухня/01.jpg`)
    const two = await groupOfPath(`${LORA_ROOT}/6. Life/Кухня/02.mp4`)
    await makeReady(one.draft_id)
    await makeReady(two.draft_id)
    const before = await counter('LIFE')
    const response = await accept(one.group_id)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      item_id: `LIFE-${String(before).padStart(3, '0')}`,
      how: 'new',
    })
    expect(await counter('LIFE')).toBe((before as number) + 1)
    const { rows } = await h.db.execute<{
      outcome: string
      role: string
      ordinal: number | null
    }>(sql`
      SELECT d.outcome, m.role, m.ordinal FROM inbox_drafts d
        JOIN asset_versions v ON v.id = d.applied_version_id
        JOIN item_memberships m ON m.asset_id = v.asset_id
       WHERE d.group_id = ${one.group_id}::uuid ORDER BY d.path`)
    expect(rows).toEqual([
      { outcome: 'new_item', role: 'pic', ordinal: 1 },
      { outcome: 'new_item', role: 'clip', ordinal: 1 },
    ])
    const again = await accept(one.group_id)
    expect(again.statusCode).toBe(422)
    expect(again.json().code).toBe('case_resolved')
    // The staged sources are not needed once the master is a blob of an accepted version.
    const { rows: shas } = await h.db.execute<{ sha: string }>(sql`
      SELECT encode(source_sha256, 'hex') AS sha FROM inbox_drafts WHERE id = ${one.draft_id}::uuid`)
    expect(await store.staged(shas[0]?.sha as string)).toBeNull()
  })

  it('one key gives one object and one number under a race; another key is refused', async () => {
    const path = `${LORA_ROOT}/6. Life/Длинный/01.jpg`
    const { group_id, draft_id } = await groupOfPath(path)
    await makeReady(draft_id)
    const before = await counter('LIFE')
    const key = newKey()
    const [a, b] = await Promise.all([accept(group_id, key), accept(group_id, key)])
    expect([a.statusCode, b.statusCode]).toEqual([200, 200])
    expect(a.json()).toEqual(b.json())
    expect(await counter('LIFE')).toBe((before as number) + 1)
    const other = await accept(group_id)
    expect(other.json().code).toBe('case_resolved')
  })

  it('a type with legacy numbers says the number is not issued yet', async () => {
    h.dropbox.tree.addFile(`${LORA_ROOT}/1. PPV/Новый бандл/master.jpg`, 3500)
    await scan()
    await fetchAll()
    const { group_id, draft_id } = await groupOfPath(`${LORA_ROOT}/1. PPV/Новый бандл/master.jpg`)
    await makeReady(draft_id)
    const before = await counter('PPV')
    const response = await accept(group_id)
    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('number_not_issued')
    expect(await counter('PPV')).toBe(before)
  })

  it('a rollback after the number spends no number', async () => {
    h.dropbox.tree.addFile(`${LORA_ROOT}/9. SMM/Дамп/01.jpg`, 2500)
    await scan()
    await fetchAll()
    const { group_id, draft_id } = await groupOfPath(`${LORA_ROOT}/9. SMM/Дамп/01.jpg`)
    await makeReady(draft_id)
    const before = await counter('RAW')
    await expect(
      withActorTx(
        h.db,
        { actor: SYSTEM_ACTOR('test'), action: 'test', requestId: randomUUID() },
        async (tx) => {
          await acceptGroup(tx, model(), ownerActor, group_id, { as: 'default' })
          throw new Error('crash before commit')
        },
      ),
    ).rejects.toThrow('crash before commit')
    expect(await counter('RAW')).toBe(before)
    expect((await accept(group_id)).statusCode).toBe(200)
    expect(await counter('RAW')).toBe((before as number) + 1)
  })

  it('reject keeps the bytes; reopen brings the draft back to «готово»', async () => {
    h.dropbox.tree.addFile(`${LORA_ROOT}/6. Life/Лишнее/01.jpg`, 2600)
    await scan()
    await fetchAll()
    const { group_id, draft_id } = await groupOfPath(`${LORA_ROOT}/6. Life/Лишнее/01.jpg`)
    await makeReady(draft_id)
    const rejected = await call(app, {
      method: 'POST',
      url: `/api/v1/lora/inbox/groups/${group_id}:reject`,
      as: owner,
      key: newKey(),
      body: { reason: 'не то' },
    })
    expect(rejected.statusCode).toBe(200)
    expect(rejected.json().state).toMatchObject({ kind: 'rejected', reason: 'не то' })
    const { rows } = await h.db.execute<{ state: string; key: string }>(sql`
      SELECT b.state, b.storage_key AS key FROM inbox_drafts d JOIN blobs b ON b.sha256 = d.master_sha256
       WHERE d.id = ${draft_id}::uuid`)
    expect(rows[0]?.state).toBe('present')
    expect(existsSync(store.path(rows[0]?.key as string))).toBe(true)
    const reopened = await call(app, {
      method: 'POST',
      url: `/api/v1/lora/inbox/drafts/${group_id}:restore`,
      as: owner,
      key: newKey(),
    })
    expect(reopened.statusCode).toBe(200)
    expect(reopened.json().state).toMatchObject({ kind: 'ready', note: { kind: 'new' } })
  })
})

describe('duplicates (SPEC §6.2)', () => {
  it('an exact duplicate becomes an alias by itself; its path is an alias of the file', async () => {
    const original = h.dropbox.tree.get(`${LORA_ROOT}/6. Life/Кухня/01.jpg`)?.bytes as Buffer
    h.dropbox.tree.addFile(`${LORA_ROOT}/6. Life/Копия/01 copy.jpg`, original)
    await scan()
    await fetchAll()
    const { rows } = await h.db.execute<{ state: string; outcome: string; alias: boolean }>(sql`
      SELECT d.state, d.outcome,
             EXISTS (SELECT 1 FROM aliases a WHERE a.value_raw = d.path AND a.kind = 'legacy_path') AS alias
        FROM inbox_drafts d WHERE d.path = ${`${LORA_ROOT}/6. Life/Копия/01 copy.jpg`}`)
    expect(rows[0]).toEqual({ state: 'resolved', outcome: 'alias', alias: true })
    const done = await call(app, {
      method: 'GET',
      url: '/api/v1/lora/inbox?state=accepted',
      as: owner,
    })
    const decided = done
      .json()
      .items.map((item: { state: { how: string; file_key?: string } }) => item.state)
    expect(decided).toContainEqual(
      expect.objectContaining({
        how: 'duplicate',
        file_key: expect.stringMatching(/^LIFE-\d{3}\/pic01$/),
      }),
    )
  })

  it('custom ↔ PPV is not an alias: a new object over the same bytes, linked as a candidate', async () => {
    h.dropbox.tree.addFile(`${LORA_ROOT}/3. Customs/12:00 заказ.mp4`, 6000)
    await scan()
    await fetchAll()
    const custom = await groupOfPath(`${LORA_ROOT}/3. Customs/12:00 заказ.mp4`)
    await makeReady(custom.draft_id)
    expect((await accept(custom.group_id)).statusCode).toBe(200)
    const bytes = h.dropbox.tree.get(`${LORA_ROOT}/3. Customs/12:00 заказ.mp4`)?.bytes as Buffer
    h.dropbox.tree.addFile(`${LORA_ROOT}/1. PPV/Из кастома/master.mp4`, bytes)
    await scan()
    await fetchAll()
    const { rows } = await h.db.execute<{ state: string; candidate: boolean }>(sql`
      SELECT d.state, EXISTS (SELECT 1 FROM inbox_draft_candidates c
                               WHERE c.draft_id = d.id AND c.kind = 'exact_duplicate') AS candidate
        FROM inbox_drafts d WHERE d.path = ${`${LORA_ROOT}/1. PPV/Из кастома/master.mp4`}`)
    expect(rows[0]).toEqual({ state: 'processing', candidate: true })
  })
})

describe('duplicates among open drafts (SPEC §6.2, schema §5)', () => {
  const life = (path: string) => `${LORA_ROOT}/6. Life/${path}`

  it('twins in one group: one file, the other an alias of it without a master of its own', async () => {
    h.dropbox.tree.addFile(life('Двойня/01.jpg'), 3100)
    h.dropbox.tree.addFile(
      life('Двойня/01 (1).jpg'),
      h.dropbox.tree.get(life('Двойня/01.jpg'))?.bytes as Buffer,
    )
    await scan()
    await fetchAll()
    const first = await groupOfPath(life('Двойня/01.jpg'))
    const twin = await groupOfPath(life('Двойня/01 (1).jpg'))
    expect(twin.group_id).toBe(first.group_id)
    await makeReady(first.draft_id)
    const response = await accept(first.group_id)
    expect(response.statusCode).toBe(200)
    const { rows } = await h.db.execute<{
      path: string
      outcome: string
      same: boolean
      decided: boolean
      files: number
      alias: boolean
    }>(sql`
      SELECT d.path, d.outcome, d.decided_by IS NOT NULL AS decided,
             d.applied_version_id = (SELECT applied_version_id FROM inbox_drafts WHERE id = ${first.draft_id}::uuid) AS same,
             (SELECT count(*)::int FROM item_memberships m WHERE m.item_id = d.applied_item_id) AS files,
             EXISTS (SELECT 1 FROM aliases a WHERE a.value_raw = d.path AND a.kind = 'legacy_path') AS alias
        FROM inbox_drafts d WHERE d.group_id = ${first.group_id}::uuid ORDER BY d.path`)
    expect(rows).toEqual([
      {
        path: life('Двойня/01 (1).jpg'),
        outcome: 'alias',
        same: true,
        decided: true,
        files: 1,
        alias: true,
      },
      {
        path: life('Двойня/01.jpg'),
        outcome: 'new_item',
        same: true,
        decided: true,
        files: 1,
        alias: true,
      },
    ])
  })

  it('an open draft in another group becomes an alias when its bytes are accepted', async () => {
    h.dropbox.tree.addFile(life('Оригинал/01.jpg'), 3200)
    h.dropbox.tree.addFile(
      life('Повтор/01.jpg'),
      h.dropbox.tree.get(life('Оригинал/01.jpg'))?.bytes as Buffer,
    )
    await scan()
    await fetchAll()
    const original = await groupOfPath(life('Оригинал/01.jpg'))
    const copy = await groupOfPath(life('Повтор/01.jpg'))
    expect(copy.group_id).not.toBe(original.group_id)
    await makeReady(original.draft_id)
    expect((await accept(original.group_id)).statusCode).toBe(200)
    const { rows } = await h.db.execute<{ state: string; outcome: string; alias: boolean }>(sql`
      SELECT d.state, d.outcome,
             EXISTS (SELECT 1 FROM aliases a WHERE a.value_raw = d.path AND a.kind = 'legacy_path') AS alias
        FROM inbox_drafts d WHERE d.id = ${copy.draft_id}::uuid`)
    expect(rows[0]).toEqual({ state: 'resolved', outcome: 'alias', alias: true })
    // The second group is not a second object: accepting it has nothing left.
    expect((await accept(copy.group_id)).json().code).toBe('case_resolved')
  })
})

describe('«Принять как есть» (SPEC §9.2)', () => {
  const life = (path: string) => `${LORA_ROOT}/6. Life/${path}`

  /** What `encode_master` leaves for a broken source: kept as a blob for «как есть», or not. */
  async function makeBroken(draftId: string, verdict: 'source_truncated' | 'unreadable') {
    const { rows } = await h.db.execute<{ sha: string }>(sql`
      SELECT encode(source_sha256, 'hex') AS sha FROM inbox_drafts WHERE id = ${draftId}::uuid`)
    const sha = rows[0]?.sha as string
    const kept = verdict !== 'unreadable'
    if (kept) {
      const staged = await store.staged(sha)
      if (!staged) throw new Error(`nothing staged for ${draftId}`)
      await registerBlob(h.db, store, {
        file: staged.path,
        sha256: sha,
        ext: staged.ext,
        mediaKind: 'video',
        owner: 'test:',
      })
    }
    const { rows: works } = await h.db.execute<{ id: string }>(sql`
      INSERT INTO work_operations (model_id, kind, work_key, state, finished_at, input_sha256, draft_id)
      VALUES (${h.modelId}::uuid, 'encode_master', ${`master:test:${draftId}`}, 'succeeded', now(),
              decode(${sha}, 'hex'), ${draftId}::uuid)
      RETURNING id`)
    await h.db.execute(sql`
      INSERT INTO master_checks (source_sha256, recipe_digest, work_id, attempt, decision, verdict, report)
      VALUES (decode(${sha}, 'hex'), 'test', ${works[0]?.id}::uuid, 1, ${kept ? 'encode' : null},
              ${verdict}, ${JSON.stringify({ acceptance: kept ? 'accept_as_is_only' : 'wait_replacement' })}::jsonb)`)
    if (kept) {
      await h.db.execute(sql`
        INSERT INTO rendition_generations (kind, recipe_digest, input_kind, input_sha256, state, ready_at)
        VALUES ('preview', 'test', 'source', decode(${sha}, 'hex'), 'ready', now())`)
    }
    await withActorTx(
      h.db,
      { actor: SYSTEM_ACTOR('test'), action: 'test', requestId: randomUUID() },
      (tx) =>
        tx.execute(sql`
          UPDATE inbox_drafts
             SET master_sha256 = ${kept ? sql`source_sha256` : sql`NULL`}, master_is_source = false,
                 master_verified_at = NULL, blocked_reason = 'master_failed',
                 error = ${`master: ${verdict}`}
           WHERE id = ${draftId}::uuid`),
    )
    await h.db.execute(sql`
      UPDATE work_operations SET state = 'cancelled', finished_at = now()
       WHERE draft_id = ${draftId}::uuid AND kind <> 'fetch' AND state = 'pending'`)
  }

  const group = (id: string) =>
    call(app, { method: 'GET', url: `/api/v1/lora/inbox/groups/${id}`, as: owner })

  it('a broken source that opens is accepted only by «Принять как есть»; an unreadable one waits', async () => {
    h.dropbox.tree.addFile(life('Битый/01.mp4'), 4100)
    h.dropbox.tree.addFile(life('Нечитаемый/01.mp4'), 4200)
    await scan()
    await fetchAll()
    const broken = await groupOfPath(life('Битый/01.mp4'))
    const unreadable = await groupOfPath(life('Нечитаемый/01.mp4'))
    await makeBroken(broken.draft_id, 'source_truncated')
    await makeBroken(unreadable.draft_id, 'unreadable')

    expect((await group(broken.group_id)).json().state).toEqual({
      kind: 'error',
      error: 'source_broken',
      detail: 'файл обрезан',
    })
    const plain = await accept(broken.group_id)
    expect(plain.statusCode).toBe(422)
    expect(plain.json().details).toMatchObject({ reason: 'master_failed' })
    const asIs = await accept(broken.group_id, newKey(), { as: 'default', as_is: true })
    expect(asIs.statusCode).toBe(200)
    const { rows } = await h.db.execute<{
      verified: boolean
      source: boolean
      outcome: string
    }>(sql`
      SELECT master_verified_at IS NOT NULL AS verified, master_is_source AS source, outcome
        FROM inbox_drafts WHERE id = ${broken.draft_id}::uuid`)
    expect(rows[0]).toEqual({ verified: true, source: true, outcome: 'new_item' })
    const { rows: journal } = await h.db.execute<{ after: [string, string][] }>(sql`
      SELECT after FROM action_log WHERE action = 'draft.accept'
       ORDER BY id DESC LIMIT 1`)
    expect(journal[0]?.after).toContainEqual(['Как есть', 'битый исходник: 1'])

    expect((await group(unreadable.group_id)).json().state).toEqual({
      kind: 'error',
      error: 'master_failed',
      detail: 'файл не читается — ждёт замены',
    })
    const refused = await accept(unreadable.group_id, newKey(), { as: 'default', as_is: true })
    expect(refused.statusCode).toBe(422)
    expect(refused.json().details).toMatchObject({ reason: 'master_failed' })
  })
})

describe('staging (SPEC §9.1)', () => {
  it('a staged source goes once its master is registered and no media work needs it', async () => {
    const path = `${LORA_ROOT}/6. Life/Чистка/01.jpg`
    h.dropbox.tree.addFile(path, 2700)
    await scan()
    await fetchAll()
    const { draft_id } = await groupOfPath(path)
    const { rows } = await h.db.execute<{ sha: string }>(sql`
      SELECT encode(source_sha256, 'hex') AS sha FROM inbox_drafts WHERE id = ${draft_id}::uuid`)
    const sha = rows[0]?.sha as string
    expect(await sweepStaging(h.db, store)).not.toContain(sha)
    expect(await store.staged(sha)).not.toBeNull()
    await makeReady(draft_id)
    expect(await sweepStaging(h.db, store)).toContain(sha)
    expect(await store.staged(sha)).toBeNull()
  })
})

describe('«Скачать исходник» (SPEC §6.1, schema §9.2)', () => {
  const download = (group: string) =>
    call(app, {
      method: 'POST',
      url: `/api/v1/lora/inbox/groups/${group}/downloads`,
      as: owner,
      key: newKey(),
    })

  it('one file: ready at once, bytes by X-Accel, the journal says who', async () => {
    const path = `${LORA_ROOT}/6. Life/Один/01.jpg`
    h.dropbox.tree.addFile(path, 2900)
    await scan()
    const { group_id } = await groupOfPath(path)
    const early = await download(group_id)
    expect(early.json()).toMatchObject({
      code: 'accept_blocked',
      details: { reason: 'not_fetched' },
    })
    await fetchAll()
    const answer = await download(group_id)
    expect(answer.statusCode).toBe(200)
    expect(answer.json()).toMatchObject({ kind: 'ready', file_name: '01.jpg', size_bytes: 2900 })
    const file = await call(app, { method: 'GET', url: answer.json().download_url, as: owner })
    expect(file.statusCode).toBe(200)
    expect(String(file.headers['x-accel-redirect'])).toMatch(/^\/_accel\/tmp\/staging\//)
    expect(String(file.headers['content-disposition'])).toContain('01.jpg')
    const { rows } = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM action_log
       WHERE action = 'inbox.download' AND subject_id = ${group_id}::uuid AND entry_kind = 'action'`)
    expect(rows[0]?.n).toBe(2 - 1)
    const { rows: receipts } = await h.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM download_receipts`,
    )
    expect(receipts[0]?.n).toBe(0)
  })

  it('several files: one ZIP by an operation', async () => {
    h.dropbox.tree.addFile(`${LORA_ROOT}/6. Life/Два/01.jpg`, 2100)
    h.dropbox.tree.addFile(`${LORA_ROOT}/6. Life/Два/02.jpg`, 2200)
    await scan()
    await fetchAll()
    const { group_id } = await groupOfPath(`${LORA_ROOT}/6. Life/Два/01.jpg`)
    const answer = await download(group_id)
    expect(answer.json()).toMatchObject({ kind: 'operation' })
    const [zip] = await drain(h.db, ['export'], { export: draftZipExport(store, undefined) })
    expect(zip?.state).toBe('succeeded')
    const operation = await call(app, { method: 'GET', url: answer.json().status_url, as: owner })
    expect(operation.json()).toMatchObject({ kind: 'source_zip', state: 'done' })
    const url = operation.json().result.download_url as string
    const file = await call(app, { method: 'GET', url, as: owner })
    expect(file.statusCode).toBe(200)
    expect(String(file.headers['x-accel-redirect'])).toMatch(/^\/_accel\/tmp\/exports\//)
  })
})

describe('◆ decisions without their case', () => {
  it('say so instead of 501', async () => {
    const { group_id } = await groupOfPath(`${LORA_ROOT}/6. Life/Два/01.jpg`)
    const decide = (body: object) =>
      call(app, {
        method: 'POST',
        url: `/api/v1/lora/inbox/groups/${group_id}:decide`,
        as: owner,
        key: newKey(),
        body,
      })
    expect((await decide({ decision: 'number_taken', keep: true })).json().details).toMatchObject({
      reason: 'no_dispute',
    })
    expect((await decide({ decision: 'split_archive', split: true })).json().details).toMatchObject(
      {
        reason: 'no_archive',
      },
    )
    expect(
      (await decide({ decision: 'substitute_montage', substitute: true })).json().details,
    ).toMatchObject({ reason: 'no_plan_row' })
  })
})
