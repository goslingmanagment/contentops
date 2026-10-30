import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IntegrationViewSchema } from '@contentops/contracts/api/responses'
import { InboxGroupSchema, InboxListSchema } from '@contentops/contracts/domain/inbox'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLogger } from '../logger'
import { buildServer } from '../server'
import { call, newKey, signIn } from '../testing/server'
import { scanHandler } from './scan'
import { type IntakeHarness, intakeHarness, LORA_ROOT, runWork, setSwitch } from './testing'

/** «Приехало» on the server (DESIGN §4.8): discovered groups, fields, source pictures. */

let h: IntakeHarness
let app: ReturnType<typeof buildServer>
let owner: string

beforeAll(async () => {
  h = await intakeHarness()
  const storage = await mkdtemp(join(tmpdir(), 'inbox-api-'))
  app = buildServer({
    db: h.db,
    publicUrl: 'http://localhost:5173',
    secrets: { hub: false },
    sourceEnv: {
      TEST_DROPBOX: h.dropbox.token,
      DROPBOX_API_BASE: h.dropbox.url,
      DROPBOX_CONTENT_BASE: h.dropbox.url,
    },
    logger: createLogger({ level: 'silent' }),
    storage: { dataRoot: storage, derivedRoot: storage, tmpRoot: storage },
  })
  await app.ready()
  owner = await signIn(app, 'owner', 'owner-password')
  await setSwitch(h.db, 'dropbox.scan', h.modelId, true)
  h.dropbox.tree.addFile(`${LORA_ROOT}/2. Sets/Morning/01.jpg`, 1500)
  h.dropbox.tree.addFile(`${LORA_ROOT}/2. Sets/Morning/02.jpg`, 1600)
  h.dropbox.tree.addFile(`${LORA_ROOT}/Новое/clip.mov`, 4000)
  await runWork(h.db, {
    modelId: h.modelId,
    kind: 'scan',
    scope: h.sources.dropbox.id,
    dataset: 'recent',
    handlers: { scan: scanHandler(h.factory) },
  })
})
afterAll(async () => {
  await app?.close()
  await h?.close()
})

const get = (url: string) => call(app, { method: 'GET', url, as: owner })

describe('«Приехало» from the source', () => {
  it('lists what was discovered before any byte is downloaded', async () => {
    const response = await get('/api/v1/lora/inbox')
    expect(response.statusCode).toBe(200)
    const list = InboxListSchema.parse(response.json())
    expect(list.disk_checked_at).not.toBeNull()
    const titles = list.items.map((group) => [group.title, group.state.kind, group.file_count])
    expect(titles).toEqual(
      expect.arrayContaining([
        ['Morning', 'preparing', 2],
        [expect.stringMatching(/^Новое · /), 'preparing', 1],
      ]),
    )
    const morning = list.items.find((group) => group.title === 'Morning')
    expect(morning?.fields.type).toBe('set')
    expect(morning?.state).toMatchObject({ kind: 'preparing', stage: 'discovered' })
    expect(morning?.files.map((file) => file.file_name)).toEqual(['01.jpg', '02.jpg'])
    // «Готово» and «нужно решение» are counted; preparing groups are not.
    expect(list.count).toBe(0)
  })

  it('shows the source picture of a draft to whoever has the model', async () => {
    const list = InboxListSchema.parse((await get('/api/v1/lora/inbox')).json())
    const src = list.items.flatMap((group) => group.files)[0]?.thumb.url
    expect(src).toMatch(/^\/api\/v1\/lora\/inbox\/thumbs\//)
    const picture = await get(src as string)
    expect(picture.statusCode).toBe(200)
    expect(picture.headers['content-type']).toMatch(/^image\//)
    const anonymous = await call(app, { method: 'GET', url: src as string })
    expect(anonymous.statusCode).toBe(401)
  })

  it('edits the fields of the future object by version', async () => {
    const list = InboxListSchema.parse((await get('/api/v1/lora/inbox')).json())
    const loose = list.items.find((group) => group.title.startsWith('Новое'))
    if (!loose) throw new Error('no loose group')
    expect(loose.fields.type).toBeNull()
    const url = `/api/v1/lora/inbox/groups/${loose.id}`
    const stale = await call(app, {
      method: 'PATCH',
      url,
      as: owner,
      key: newKey(),
      ifMatch: loose.version + 5,
      body: { type: 'life', title: 'Утро на кухне' },
    })
    expect(stale.statusCode).toBe(412)
    const saved = await call(app, {
      method: 'PATCH',
      url,
      as: owner,
      key: newKey(),
      ifMatch: loose.version,
      body: { type: 'life', title: 'Утро на кухне' },
    })
    expect(saved.statusCode).toBe(200)
    const group = InboxGroupSchema.parse(saved.json())
    expect(group).toMatchObject({ title: 'Утро на кухне', version: loose.version + 1 })
    expect(group.fields).toMatchObject({ type: 'life', title: 'Утро на кухне' })
  })

  it('«Разбор старого» is empty before stage 3', async () => {
    const response = await get('/api/v1/lora/legacy')
    expect(response.statusCode).toBe(200)
    expect(response.json().disputes).toEqual([])
  })

  it('«Интеграции» shows each cloud of the model; a refused token says since when', async () => {
    const list = async () =>
      (await get('/api/v1/admin/integrations'))
        .json()
        .items.map((item: unknown) => IntegrationViewSchema.parse(item))
    const before = await list()
    expect(before.find((item: { id: string }) => item.id === 'dropbox.lora')).toMatchObject({
      state: 'working',
    })
    // No token for the Yandex Disk of the model in this environment.
    expect(before.find((item: { id: string }) => item.id === 'ydisk.lora')).toMatchObject({
      state: 'unset',
    })
    h.dropbox.fail('unauthorized', { times: 10 })
    await runWork(h.db, {
      modelId: h.modelId,
      kind: 'scan',
      scope: h.sources.dropbox.id,
      dataset: 'recent',
      handlers: { scan: scanHandler(h.factory) },
    })
    h.dropbox.clearFailures()
    const after = (await list()).find((item: { id: string }) => item.id === 'dropbox.lora')
    expect(after).toMatchObject({ state: 'down', down_reason: 'token_rejected' })
    expect(after?.line.text).toMatch(/^Dropbox: токен не принят с \d\d:\d\d$/)
  })
})
