import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IssuedTokenSchema } from '@contentops/contracts/domain/agents'
import {
  type OriginalsRelease,
  OriginalsReleaseSchema,
} from '@contentops/contracts/domain/originals'
import type { CopyListEntry } from '@contentops/legacy'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { modelId, systemTx } from '../media/testing'
import {
  addPerson,
  call,
  newKey,
  OWNER,
  signIn,
  type TestServer,
  testServer,
} from '../testing/server'
import { opsHostAgent } from './host-agent'
import { ARI_LIST_FILE, BATCH_KEY, HOST_REPORT_FILE, ORIGINALS_SWITCH } from './release'

/**
 * What the PC may free (`admin.originalsRelease`, SPEC §9.4, §12.2): only releasable originals
 * whose file on the PC has its bytes and the revision's size, nothing from an old or unclean
 * list, with the switch off or during a session; the owner and the host agent only; in batches.
 */

let server: TestServer
let hostDir: string
let owner: string
let lora: string
let ari: string
let ownerId: string
let hostToken: string
let otherAgentToken: string
let manager: string
let reader: string

const HOUR = 3600_000
const iso = (ms: number) => new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/u, 'Z')

async function sourceOf(model: string, kind: 'yandex_disk' | 'dropbox'): Promise<string> {
  return systemTx(server.db, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO sources (model_id, kind, label, root_path, credentials_ref)
      VALUES (${model}::uuid, ${kind}, ${`${kind} ${randomUUID().slice(0, 6)}`},
              ${kind === 'yandex_disk' ? 'disk:/' : ''}, 'TOKEN')
      RETURNING id`)
    return rows[0]?.id as string
  })
}

interface Original {
  revision: string
  hash: string
}

/**
 * A file of a cloud source with one revision; `releasable` — rejected by the owner with a reason
 * (decided) and checked in two clouds (reliable).
 */
async function original(
  model: string,
  src: string,
  kind: 'yandex_disk' | 'dropbox',
  path: string,
  options: { size?: number; releasable?: boolean } = {},
): Promise<Original> {
  const contentHash = randomBytes(32)
  const full = kind === 'yandex_disk' ? `disk:/${path}` : `/${path}`
  const revision = await systemTx(server.db, async (tx) => {
    const { rows: objects } = await tx.execute<{ id: string }>(sql`
      INSERT INTO source_objects (model_id, source_id, resource_id, current_path, current_name)
      VALUES (${model}::uuid, ${src}::uuid, ${`id:${randomUUID()}`}, ${full},
              ${path.slice(path.lastIndexOf('/') + 1)})
      RETURNING id`)
    const object = objects[0]?.id as string
    const { rows: revisions } = await tx.execute<{ id: string }>(sql`
      INSERT INTO source_revisions (model_id, source_object_id, sequence_no, byte_size, md5,
                                    content_hash, remote_rev)
      VALUES (${model}::uuid, ${object}::uuid, 1, ${options.size ?? 100},
              ${kind === 'yandex_disk' ? createHash('md5').update(path).digest() : null},
              ${kind === 'dropbox' ? contentHash : null},
              ${kind === 'dropbox' ? randomUUID().replaceAll('-', '') : null})
      RETURNING id`)
    const id = revisions[0]?.id as string
    await tx.execute(sql`
      UPDATE source_objects SET current_revision_id = ${id}::uuid WHERE id = ${object}::uuid`)
    const { rows: groups } = await tx.execute<{ id: string }>(sql`
      INSERT INTO inbox_groups (model_id, source_id, group_key, grouping)
      VALUES (${model}::uuid, ${src}::uuid, ${`g:${randomUUID()}`}, 'folder')
      RETURNING id`)
    await tx.execute(sql`
      INSERT INTO inbox_drafts (model_id, group_id, source_revision_id, origin, state, outcome,
                                decided_by, reject_reason, rejected_at)
      VALUES (${model}::uuid, ${groups[0]?.id}::uuid, ${id}::uuid, 'disk_scan', 'resolved',
              'rejected', ${ownerId}::uuid, 'брак', now())`)
    return id
  })
  const places = options.releasable === false ? ['mega'] : ['mega', 'dropbox', 'yandex']
  for (const place of places.slice(0, 2)) {
    await server.db.execute(sql`
      INSERT INTO original_copies (model_id, source_revision_id, place, role, remote, path,
                                   object_ref, byte_size, seen_md5, verified_at, verified_by)
      VALUES (${model}::uuid, ${revision}::uuid, ${place}, 'copy', ${place},
              ${`originals/${randomUUID()}`}, ${`node-${randomUUID()}`}, ${options.size ?? 100},
              ${randomBytes(16)}, now(), 'test')`)
  }
  return { revision, hash: contentHash.toString('hex') }
}

const fileEntry = (
  path: string,
  options: { size?: number; present?: boolean; written?: string } = {},
): CopyListEntry => ({
  path,
  is_dir: false,
  size: options.size ?? 100,
  last_write_utc: options.written ?? '2024-05-01T10:00:00Z',
  attributes: options.present === false ? 0x541620 : 0x80020,
  bytes_present: options.present !== false,
})

interface ListOptions {
  finishedAt?: string
  errors?: number
  clientRunning?: boolean
  removedTotal?: number
}

async function writeList(name: string, entries: CopyListEntry[], options: ListOptions = {}) {
  await writeFile(join(hostDir, name), entries.map((e) => JSON.stringify(e)).join('\n'))
  await writeFile(
    join(hostDir, name.replace(/\.jsonl$/u, '.meta.json')),
    // Windows PowerShell writes a BOM: the route takes it.
    `\uFEFF${JSON.stringify({
      finished_at: options.finishedAt ?? iso(-5 * 60_000),
      errors: options.errors ?? 0,
      dirs_not_listed: 3,
      client_running: options.clientRunning ?? false,
      ...(options.removedTotal === undefined ? {} : { removed_total: options.removedTotal }),
    })}`,
  )
}

async function hostReport(report: object | null) {
  const file = join(hostDir, HOST_REPORT_FILE)
  if (report === null) await rm(file, { force: true })
  else await writeFile(file, JSON.stringify(report))
}

async function setPolicy(key: string, value: unknown) {
  await systemTx(server.db, (tx) =>
    tx.execute(sql`
      INSERT INTO policy_settings (key, value)
      VALUES (${key}, ${value === null ? null : JSON.stringify(value)}::jsonb)
      ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE SET value = excluded.value`),
  )
}

async function release(
  model: string,
  holder: 'ydisk_copy' | 'e_ari',
  as: string = owner,
): Promise<OriginalsRelease> {
  const response = await call(server.app, {
    method: 'GET',
    url: `/api/v1/admin/originals/release?model=${model}&holder=${holder}`,
    as,
  })
  if (response.statusCode !== 200)
    throw new Error(`release: ${response.statusCode} ${response.body}`)
  return OriginalsReleaseSchema.parse(response.json())
}

async function agentToken(name: string, models: string[]): Promise<string> {
  const added = await call(server.app, {
    method: 'POST',
    url: '/api/v1/admin/agents',
    as: owner,
    key: newKey(),
    body: { name, role: 'reader', models },
  })
  if (added.statusCode !== 201) throw new Error(`add agent: ${added.body}`)
  const id = added.json().id as string
  const issued = await call(server.app, {
    method: 'POST',
    url: `/api/v1/admin/agents/${id}/tokens`,
    as: owner,
    key: newKey(),
    body: { agent_id: id, expires_in_days: null },
  })
  if (issued.statusCode !== 201) throw new Error(`issue token: ${issued.body}`)
  return `Bearer ${IssuedTokenSchema.parse(issued.json()).secret}`
}

// The Я.Диск copy of Lora: what the list says about each of her files.
const YDISK = {
  present: '1. PPV/a.mov',
  colon: '1. PPV/13:03 b.mov',
  placeholder: '1. PPV/c.mov',
  otherSize: '1. PPV/d.mov',
  onePlace: '1. PPV/e.mov',
  // Two paths of the cloud that are one name in the copy: neither is given out.
  clashA: '2. FYP/x:y.mov',
  clashB: '2. FYP/x-y.mov',
  service: '.sync/state.mov',
  more: ['3. Sets/f1.jpg', '3. Sets/f2.jpg', '3. Sets/f3.jpg'],
}
let ydisk: Record<string, Original> = {}

const ydiskEntries = (): CopyListEntry[] => [
  fileEntry(YDISK.present),
  fileEntry('1. PPV/13-03 b.mov'),
  fileEntry(YDISK.placeholder, { present: false }),
  fileEntry(YDISK.otherSize, { size: 101 }),
  fileEntry(YDISK.onePlace),
  fileEntry('2. FYP/x-y.mov'),
  fileEntry(YDISK.service),
  ...YDISK.more.map((path) => fileEntry(path)),
  {
    path: '4. Life',
    is_dir: true,
    size: 0,
    last_write_utc: '2024-05-01T10:00:00Z',
    attributes: 0x400010,
    listed: false,
  },
]

let ariFiles: Record<string, Original> = {}

beforeAll(async () => {
  hostDir = await mkdtemp(join(tmpdir(), 'originals-host-'))
  server = await testServer({ originalsHostDir: hostDir })
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  lora = await modelId(server.db, 'lora')
  ari = await modelId(server.db, 'ari')
  const { rows } = await server.db.execute<{ id: string }>(sql`
    SELECT id FROM principals WHERE login = ${OWNER.login}`)
  ownerId = rows[0]?.id as string
  const on = await call(server.app, {
    method: 'PATCH',
    url: '/api/v1/admin/integrations/agents',
    as: owner,
    key: newKey(),
    body: { switches: { enabled: true } },
  })
  if (on.statusCode !== 200) throw new Error(`agents on: ${on.body}`)
  manager = (
    await addPerson(server.app, owner, {
      name: 'Диана',
      login: 'diana',
      role: 'manager',
      models: ['lora', 'ari'],
    })
  ).session
  reader = (
    await addPerson(server.app, owner, {
      name: 'Fyper',
      login: 'fyper',
      role: 'reader',
      models: ['lora', 'ari'],
    })
  ).session
  hostToken = await agentToken('ПК', ['lora'])
  otherAgentToken = await agentToken('Приёмка', ['lora', 'ari'])
  expect(await opsHostAgent(server.db, 'ПК')).toMatchObject({ agent: 'ПК', models: ['lora'] })

  const yandex = await sourceOf(lora, 'yandex_disk')
  ydisk = {
    present: await original(lora, yandex, 'yandex_disk', YDISK.present),
    colon: await original(lora, yandex, 'yandex_disk', YDISK.colon),
    placeholder: await original(lora, yandex, 'yandex_disk', YDISK.placeholder),
    otherSize: await original(lora, yandex, 'yandex_disk', YDISK.otherSize),
    onePlace: await original(lora, yandex, 'yandex_disk', YDISK.onePlace, { releasable: false }),
    clashA: await original(lora, yandex, 'yandex_disk', YDISK.clashA),
    clashB: await original(lora, yandex, 'yandex_disk', YDISK.clashB),
    service: await original(lora, yandex, 'yandex_disk', YDISK.service),
  }
  for (const [n, path] of YDISK.more.entries()) {
    ydisk[`more${n}`] = await original(lora, yandex, 'yandex_disk', path)
  }
  const dropbox = await sourceOf(ari, 'dropbox')
  ariFiles = {
    old: await original(ari, dropbox, 'dropbox', '1. PPV/Pack.MOV'),
    fresh: await original(ari, dropbox, 'dropbox', '1. PPV/fresh.mov'),
    inventory: await original(ari, dropbox, 'dropbox', '_опись/manifest.csv'),
    otherSize: await original(ari, dropbox, 'dropbox', '6. Life/big.mov'),
    onlyDropbox: await original(ari, dropbox, 'dropbox', 'PPV packs/p.zip'),
    rootFile: await original(ari, dropbox, 'dropbox', 'README.txt'),
  }
})
afterAll(async () => {
  await server.close()
  await rm(hostDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await setPolicy(ORIGINALS_SWITCH, true)
  await setPolicy(BATCH_KEY, null)
  await hostReport(null)
  await writeList('ydisk-copy-list.jsonl', ydiskEntries())
})

describe('the copy of Я.Диск', () => {
  it('gives only releasable files with their bytes in the copy and the revision size', async () => {
    const answer = await release('lora', 'ydisk_copy')
    expect(answer.blocked).toBeNull()
    expect(answer.files.map((file) => file.path)).toEqual([
      YDISK.colon.replace(':', '-'),
      YDISK.present,
      ...YDISK.more,
    ])
    expect(answer.files[0]).toMatchObject({
      revision_id: ydisk.colon?.revision,
      size: 100,
      last_write_utc: '2024-05-01T10:00:00Z',
      attributes: 0x80020,
      dropbox_hash: null,
    })
    expect(answer.limit).toEqual({ files: 50, bytes: 50_000_000_000, first_run: true })
    expect(answer.left).toEqual({ files: 0, bytes: 0 })
  })

  it.each([
    ['an old list', { finishedAt: iso(-31 * 60_000) }, 'list_stale'],
    ['a list from the future', { finishedAt: iso(40 * 60_000) }, 'list_stale'],
    ['errors of the walk', { errors: 1 }, 'list_errors'],
    ['the client running during the walk', { clientRunning: true }, 'client_running'],
  ] as const)('%s: nothing', async (_name, options, blocked) => {
    await writeList('ydisk-copy-list.jsonl', ydiskEntries(), options)
    const answer = await release('lora', 'ydisk_copy')
    expect(answer).toMatchObject({ blocked, files: [] })
  })

  it('nothing while a release session runs or its report is broken', async () => {
    await hostReport({ running: true, released_total: 3 })
    expect(await release('lora', 'ydisk_copy')).toMatchObject({
      blocked: 'session_running',
      files: [],
    })
    await writeFile(join(hostDir, HOST_REPORT_FILE), '{"running":')
    expect(await release('lora', 'ydisk_copy')).toMatchObject({
      blocked: 'host_report_unreadable',
      files: [],
    })
  })

  it('nothing with the owner’s switch off, without a list, for another model', async () => {
    await setPolicy(ORIGINALS_SWITCH, false)
    expect(await release('lora', 'ydisk_copy')).toMatchObject({ blocked: 'switch_off', files: [] })
    await setPolicy(ORIGINALS_SWITCH, null)
    expect(await release('lora', 'ydisk_copy')).toMatchObject({ blocked: 'switch_off' })
    await setPolicy(ORIGINALS_SWITCH, true)
    expect(await release('ari', 'ydisk_copy')).toMatchObject({ blocked: 'holder_of_other_model' })
    await rm(join(hostDir, 'ydisk-copy-list.jsonl'))
    expect(await release('lora', 'ydisk_copy')).toMatchObject({ blocked: 'no_list', files: [] })
  })

  it('batches: the first one small, then the limits of the policy', async () => {
    await setPolicy(BATCH_KEY, { files: 3, bytes: 250, first_files: 2 })
    const first = await release('lora', 'ydisk_copy')
    expect(first.limit).toEqual({ files: 2, bytes: 250, first_run: true })
    expect(first.files).toHaveLength(2)
    expect(first.left).toEqual({ files: 3, bytes: 300 })
    await hostReport({ running: false, released_total: 2 })
    const next = await release('lora', 'ydisk_copy')
    expect(next.limit).toEqual({ files: 3, bytes: 250, first_run: false })
    // 3 files of 100 bytes do not fit into 250.
    expect(next.files).toHaveLength(2)
    await setPolicy(BATCH_KEY, { files: 3, bytes: 50 })
    // A file bigger than the bytes of a batch goes alone.
    expect((await release('lora', 'ydisk_copy')).files).toHaveLength(1)
  })
})

describe('E:\\Ari', () => {
  const ariEntries = () => [
    fileEntry('1. PPV/pack.mov', { written: iso(-48 * HOUR) }),
    fileEntry('1. PPV/fresh.mov', { written: iso(-HOUR) }),
    fileEntry('_опись/manifest.csv', { written: iso(-48 * HOUR) }),
    fileEntry('6. Life/big.mov', { size: 99, written: iso(-48 * HOUR) }),
    // The archive's own file at its root stays.
    fileEntry('README.txt', { written: iso(-48 * HOUR) }),
  ]

  it('gives files unchanged for 24 h with the Dropbox hash, never the inventory or the root', async () => {
    await writeList(ARI_LIST_FILE, ariEntries())
    const answer = await release('ari', 'e_ari')
    expect(answer.blocked).toBeNull()
    expect(answer.files).toEqual([
      {
        revision_id: ariFiles.old?.revision,
        // As the list wrote it: the case of the disk, not of Dropbox.
        path: '1. PPV/pack.mov',
        size: 100,
        last_write_utc: expect.any(String),
        attributes: 0x80020,
        dropbox_hash: ariFiles.old?.hash,
      },
    ])
    expect(answer.limit.first_run).toBe(true)
    await writeList(ARI_LIST_FILE, ariEntries(), { removedTotal: 7 })
    expect((await release('ari', 'e_ari')).limit.first_run).toBe(false)
  })

  it('nothing from an old list', async () => {
    await writeList(ARI_LIST_FILE, ariEntries(), { finishedAt: iso(-2 * HOUR) })
    expect(await release('ari', 'e_ari')).toMatchObject({ blocked: 'list_stale', files: [] })
  })
})

describe('who may ask', () => {
  it('the owner and the host agent on its models', async () => {
    expect((await release('lora', 'ydisk_copy', hostToken)).files.length).toBeGreaterThan(0)
    await writeList(ARI_LIST_FILE, [])
    const ariByAgent = await call(server.app, {
      method: 'GET',
      url: '/api/v1/admin/originals/release?model=ari&holder=e_ari',
      as: hostToken,
    })
    expect(ariByAgent.statusCode).toBe(403)
  })

  it.each([
    ['a content manager', () => manager],
    ['a reader (Fyper)', () => reader],
    ['an agent the owner did not name', () => otherAgentToken],
  ])('%s: 403', async (_name, as) => {
    const response = await call(server.app, {
      method: 'GET',
      url: '/api/v1/admin/originals/release?model=lora&holder=ydisk_copy',
      as: as(),
    })
    expect(response.statusCode).toBe(403)
  })

  it('the host agent taken off: 403', async () => {
    expect(await opsHostAgent(server.db, null)).toMatchObject({ agent: null, id: null })
    const response = await call(server.app, {
      method: 'GET',
      url: '/api/v1/admin/originals/release?model=lora&holder=ydisk_copy',
      as: hostToken,
    })
    expect(response.statusCode).toBe(403)
    await opsHostAgent(server.db, 'ПК')
  })
})
