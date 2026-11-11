import { randomUUID } from 'node:crypto'
import { IssuedTokenSchema } from '@contentops/contracts/domain/agents'
import { InboxAlertListSchema, InboxAlertSchema } from '@contentops/contracts/domain/inbox'
import { SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { recordingRetry } from '@contentops/sources/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLogger } from '../logger'
import type { BlobStore } from '../media/storage'
import { registerBlob } from '../media/storage-ops'
import { tempStore } from '../media/testing'
import { opsCustomCopies } from '../ops-owner'
import { buildServer } from '../server'
import { addPerson, call, newKey, signIn } from '../testing/server'
import { fetchHandler } from './fetch'
import { scanHandler } from './scan'
import { drain, type IntakeHarness, intakeHarness, LORA_ROOT, runWork, setSwitch } from './testing'

/**
 * «Копии кастомов» (SPEC §6.2, решение владельца 11.11.2026): the bytes of a custom seen at a
 * path outside the customs section raise one signal per custom and path, whichever came first
 * and whatever the copy becomes — an alias, an object of its own, a moved file. Read by everyone
 * with the model, an agent too; «Понятно» — the owner, a person.
 */

let h: IntakeHarness
let store: BlobStore
let app: ReturnType<typeof buildServer>
let owner: string
let manager: string
let agent: string

beforeAll(async () => {
  h = await intakeHarness()
  store = await tempStore('custom-copies')
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
  manager = (
    await addPerson(app, owner, {
      name: 'Диана',
      login: 'diana',
      role: 'manager',
      models: ['lora'],
    })
  ).session
  const on = await call(app, {
    method: 'PATCH',
    url: '/api/v1/admin/integrations/agents',
    as: owner,
    key: newKey(),
    body: { switches: { enabled: true } },
  })
  expect(on.statusCode, on.body).toBe(200)
  const added = await call(app, {
    method: 'POST',
    url: '/api/v1/admin/agents',
    as: owner,
    key: newKey(),
    body: { name: 'Генгар', role: 'manager', models: ['lora'] },
  })
  const token = await call(app, {
    method: 'POST',
    url: `/api/v1/admin/agents/${added.json().id}/tokens`,
    as: owner,
    key: newKey(),
    body: { agent_id: added.json().id, expires_in_days: null },
  })
  agent = `Bearer ${IssuedTokenSchema.parse(token.json()).secret}`
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

const scan = () =>
  runWork(h.db, {
    modelId: h.modelId,
    kind: 'scan',
    scope: h.sources.dropbox.id,
    dataset: 'full',
    handlers: { scan: scanHandler(h.factory) },
  })

const fetchAll = () => drain(h.db, ['fetch'], { fetch: fetch() })

/** Scans the source and fetches what it found. */
async function arrive() {
  await scan()
  await fetchAll()
}

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
  await h.db.execute(sql`
    UPDATE work_operations SET state = 'cancelled', finished_at = now()
     WHERE draft_id = ${draftId}::uuid AND kind <> 'fetch' AND state = 'pending'`)
}

/** Takes the file at `path` into the catalog as its group's object; gives its ID. */
async function accept(path: string): Promise<string> {
  const { rows } = await h.db.execute<{ group_id: string; draft_id: string }>(sql`
    SELECT group_id, id AS draft_id FROM inbox_drafts WHERE path = ${`${LORA_ROOT}/${path}`}
     ORDER BY discovered_at DESC LIMIT 1`)
  const draft = rows[0]
  if (!draft) throw new Error(`no draft for ${path}`)
  await makeReady(draft.draft_id)
  const response = await call(app, {
    method: 'POST',
    url: `/api/v1/lora/inbox/groups/${draft.group_id}:accept`,
    as: owner,
    key: newKey(),
    body: { as: 'default' },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().item_id as string
}

const bytesOf = (path: string) => h.dropbox.tree.get(`${LORA_ROOT}/${path}`)?.bytes as Buffer

async function alerts(query = '', as = owner) {
  const response = await call(app, { method: 'GET', url: `/api/v1/lora/inbox/alerts${query}`, as })
  expect(response.statusCode, response.body).toBe(200)
  return InboxAlertListSchema.parse(response.json())
}

async function alertOf(path: string) {
  return (await alerts('?state=all')).items.find((alert) => alert.path === path)
}

describe('a copy of a custom outside the customs section (SPEC §6.2)', () => {
  let red: string

  it('copy after custom: the copy in `2. FYP` is seen the same day, with a journal row', async () => {
    h.dropbox.tree.addFile(`${LORA_ROOT}/3. Customs/12:30 в красном.mp4`, 6100)
    await arrive()
    red = await accept('3. Customs/12:30 в красном.mp4')
    expect(red).toMatch(/^CUS-\d{3}$/)
    expect((await alerts()).items).toEqual([])
    h.dropbox.tree.addFile(
      `${LORA_ROOT}/2. FYP/Красное.mp4`,
      bytesOf('3. Customs/12:30 в красном.mp4'),
    )
    await arrive()
    const list = await alerts()
    expect(list.open).toBe(1)
    expect(list.items).toEqual([
      expect.objectContaining({
        kind: 'custom_copy',
        state: 'open',
        custom: { id: red, title: 'в красном' },
        path: '2. FYP/Красное.mp4',
        source: 'dropbox',
        also_in: [],
        dismissed: null,
      }),
    ])
    const { rows } = await h.db.execute<{
      subject_label: string
      after: Record<string, string>
    }>(sql`
      SELECT subject_label, after FROM action_log WHERE action = 'draft.custom_copy'`)
    expect(rows).toEqual([
      { subject_label: red, after: { Кастом: red, Где: '2. FYP/Красное.mp4' } },
    ])
  })

  it('no duplicate signal on rescan, nor from the owner command over the whole catalog', async () => {
    await arrive()
    await scan()
    expect((await alerts()).items).toHaveLength(1)
    const again = await opsCustomCopies(h.db, { model: 'lora' })
    expect(again).toEqual({ model: 'lora', found: 1, raised: 0, open: 1 })
  })

  it('move: a custom moved out of its section is a copy outside it too', async () => {
    h.dropbox.tree.addFile(`${LORA_ROOT}/3. Customs/13:00 синее.mp4`, 6200)
    await arrive()
    const blue = await accept('3. Customs/13:00 синее.mp4')
    h.dropbox.tree.move(
      `${LORA_ROOT}/3. Customs/13:00 синее.mp4`,
      `${LORA_ROOT}/8. Other/синее.mp4`,
    )
    await scan()
    expect(await alertOf('8. Other/синее.mp4')).toMatchObject({
      custom: { id: blue },
      state: 'open',
    })
    // A rename inside the section is no copy.
    h.dropbox.tree.addFile(`${LORA_ROOT}/3. Customs/13:30 фиолетовое.mp4`, 6250)
    await arrive()
    await accept('3. Customs/13:30 фиолетовое.mp4')
    h.dropbox.tree.move(
      `${LORA_ROOT}/3. Customs/13:30 фиолетовое.mp4`,
      `${LORA_ROOT}/3. Customs/Сдано/13:30 фиолетовое.mp4`,
    )
    await scan()
    expect(await alertOf('3. Customs/Сдано/13:30 фиолетовое.mp4')).toBeUndefined()
  })

  it('custom after copy: the custom is its own object, and the FYP over its bytes is the copy', async () => {
    h.dropbox.tree.addFile(`${LORA_ROOT}/2. FYP/Зелёное.mp4`, 6300)
    await arrive()
    const fyp = await accept('2. FYP/Зелёное.mp4')
    expect(fyp).toMatch(/^FYP-\d{4}$/)
    h.dropbox.tree.addFile(
      `${LORA_ROOT}/3. Customs/14:00 в зелёном.mp4`,
      bytesOf('2. FYP/Зелёное.mp4'),
    )
    await arrive()
    // Not an alias of the FYP: a custom of its own over the same bytes.
    const green = await accept('3. Customs/14:00 в зелёном.mp4')
    expect(green).toMatch(/^CUS-\d{3}$/)
    expect(await alertOf('2. FYP/Зелёное.mp4')).toMatchObject({
      custom: { id: green },
      also_in: [fyp],
      state: 'open',
    })
  })

  it('CUS ↔ PPV pair: a PPV of the same bytes is an object of its own, and still a copy', async () => {
    h.dropbox.tree.addFile(`${LORA_ROOT}/3. Customs/15:00 жёлтое.mp4`, 6400)
    await arrive()
    const yellow = await accept('3. Customs/15:00 жёлтое.mp4')
    h.dropbox.tree.addFile(
      `${LORA_ROOT}/1. PPV/Жёлтое/master.mp4`,
      bytesOf('3. Customs/15:00 жёлтое.mp4'),
    )
    await arrive()
    const { rows } = await h.db.execute<{ state: string }>(sql`
      SELECT state FROM inbox_drafts WHERE path = ${`${LORA_ROOT}/1. PPV/Жёлтое/master.mp4`}`)
    expect(rows[0]?.state).not.toBe('resolved')
    expect(await alertOf('1. PPV/Жёлтое/master.mp4')).toMatchObject({
      custom: { id: yellow },
      state: 'open',
    })
  })
})

describe('who sees and who dismisses (SPEC §11.1)', () => {
  it('an agent reads the signals and cannot dismiss one; a manager cannot either; the owner can', async () => {
    const byAgent = await alerts('?state=open', agent)
    expect(byAgent.open).toBeGreaterThanOrEqual(4)
    const [first] = byAgent.items
    if (!first) throw new Error('no signal')
    const url = `/api/v1/lora/inbox/alerts/${first.id}:dismiss`
    const refusedAgent = await call(app, { method: 'POST', url, as: agent, key: newKey() })
    expect(refusedAgent.statusCode, refusedAgent.body).toBe(403)
    const refusedManager = await call(app, { method: 'POST', url, as: manager, key: newKey() })
    expect(refusedManager.statusCode, refusedManager.body).toBe(403)
    expect((await alerts()).open).toBe(byAgent.open)
    const done = await call(app, { method: 'POST', url, as: owner, key: newKey() })
    expect(done.statusCode, done.body).toBe(200)
    expect(InboxAlertSchema.parse(done.json())).toMatchObject({
      state: 'dismissed',
      dismissed: { by: { type: 'person', name: 'Владелец' } },
    })
    const open = await alerts()
    expect(open.open).toBe(byAgent.open - 1)
    expect(open.items.map((alert) => alert.id)).not.toContain(first.id)
    // A rescan does not bring it back.
    await arrive()
    expect((await alerts()).open).toBe(byAgent.open - 1)
  })

  it('the model gets the attention marker while a signal is open', async () => {
    const response = await call(app, { method: 'GET', url: '/api/v1/admin/counters', as: owner })
    expect(response.json().models).toContainEqual(
      expect.objectContaining({ model: 'lora', attention: true }),
    )
  })

  it('`since` gives what came after the last look', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    expect((await alerts(`?state=all&since=${encodeURIComponent(future)}`)).items).toEqual([])
  })
})
