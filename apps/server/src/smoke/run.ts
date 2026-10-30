// Smoke checks of stage 6 (PLAN 6, SPEC §12.2): the processes and integrations of stages 1–5
// through the real stack — nginx → web → db → the worker roles — with the token of the smoke
// agent (`ops.js smoke-setup --token`). Safe on the real base:
//
// - the agency's models are only read; the one change there is a receipt: one small file of
//   an existing object is downloaded as a person would download it;
// - every write goes into the model `smoke` (`smoke/setup.ts`): two tiny generated PNG (no
//   people) uploaded, accepted, put into the plan, marked and cancelled, an order created,
//   delivered and closed, a promo collection handed off. Every run makes new rows; nothing is
//   ever deleted. The fetch below refuses any other write, whatever the code asks for.
//
//   node dist/smoke.js [--reads-only] [--timeout <s>]
//
// Env: CONTENTOPS_URL (default http://proxy:8080 — inside the stack network), CONTENTOPS_TOKEN.
// No external model and no AI is needed. Prints a table; exit 0 when nothing failed.
import { createHash, randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { crc32, deflateSync } from 'node:zlib'
import { createApiClient, type FetchLike } from '@contentops/contracts/api/client'
import { isApiError } from '@contentops/contracts/api/errors'
import { addDays, isoWeekOf, mskDate } from '@contentops/contracts/clock'
import type { DraftState, InboxGroup } from '@contentops/contracts/domain/inbox'
import type { ItemDetail } from '@contentops/contracts/domain/item'
import { SMOKE_CHANNEL, SMOKE_CONTRACTOR, SMOKE_MODEL, SMOKE_PAGES } from './setup'

type Status = 'ok' | 'warn' | 'skip' | 'FAIL'

interface Line {
  area: string
  name: string
  status: Status
  detail: string
  ms: number
}

/** A check that has nothing to check (no objects yet) or whose chain broke earlier. */
class Skip extends Error {}
/** Read fine, but worth a look and not a failure: an integration is down. */
class Warn extends Error {}

const { values: flags } = parseArgs({
  options: {
    'reads-only': { type: 'boolean' },
    timeout: { type: 'string' },
  },
})
const BASE = (process.env.CONTENTOPS_URL ?? 'http://proxy:8080').replace(/\/$/, '')
const TOKEN = process.env.CONTENTOPS_TOKEN ?? ''
const WAIT_MS = Number(flags.timeout ?? 180) * 1000
const RUN = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d+Z$/, 'Z')
const lines: Line[] = []

/** Writes outside the smoke model: only a download of one file (a receipt, SPEC §11.2). */
function allowedWrite(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD') return true
  if (path.startsWith(`/api/v1/${SMOKE_MODEL}/`)) return true
  return /^\/api\/v1\/[a-z][a-z0-9-]*\/i\/[^/]+\/files:download$/.test(path)
}

const authorized: FetchLike = (input, init) => {
  const method = (init.method ?? 'GET').toUpperCase()
  const path = new URL(input, BASE).pathname
  if (!allowedWrite(method, path)) {
    return Promise.reject(
      new Error(`smoke refuses ${method} ${path}: writes go to «${SMOKE_MODEL}» only`),
    )
  }
  return fetch(input, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${TOKEN}` },
    signal: init.signal ?? AbortSignal.timeout(60_000),
  })
}

const api = createApiClient(authorized, { baseUrl: BASE })

function describe(error: unknown): string {
  if (isApiError(error)) return `${error.status} ${error.code}: ${error.message}`
  if (error instanceof Error)
    return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message
  return String(error)
}

/** Runs one check; its value goes on to the checks that need it, `undefined` if it failed. */
async function check<T>(
  area: string,
  name: string,
  run: () => Promise<{ value: T; detail: string } | string>,
): Promise<T | undefined> {
  const started = Date.now()
  const line: Line = { area, name, status: 'ok', detail: '', ms: 0 }
  let value: T | undefined
  try {
    const result = await run()
    if (typeof result === 'string') line.detail = result
    else {
      line.detail = result.detail
      value = result.value
    }
  } catch (error) {
    line.status = error instanceof Skip ? 'skip' : error instanceof Warn ? 'warn' : 'FAIL'
    line.detail = describe(error)
  }
  line.ms = Date.now() - started
  lines.push(line)
  return value
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Skip(`skipped: ${what} failed`)
  return value
}

async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + WAIT_MS
  let delay = 500
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`${what}: not within ${WAIT_MS / 1000} s`)
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, 5_000)
  }
}

/** A GET of bytes the API points to (thumbnail, download, ZIP): through nginx X-Accel. */
async function bytesOf(url: string): Promise<{ size: number; type: string; sha256: string }> {
  const response = await authorized(new URL(url, BASE).toString(), { method: 'GET' })
  if (!response.ok) throw new Error(`GET ${url}: ${response.status}`)
  const body = Buffer.from(await response.arrayBuffer())
  return {
    size: body.length,
    type: response.headers.get('content-type') ?? '?',
    sha256: createHash('sha256').update(body).digest('hex'),
  }
}

const handle = (key: string) => key.split('/').pop() ?? key
const today = () => mskDate(new Date().toISOString())

// --- Tiny PNG (no people): a gradient of the run's own colours, unique bytes every run ----

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, tail])
}

function tinyPng(seed: string, size = 96): Buffer {
  const colour = createHash('sha256').update(seed).digest()
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1)
    for (let x = 0; x < size; x++) {
      const at = row + 1 + x * 3
      raw[at] = ((colour[0] ?? 0) + x * 2) & 0xff
      raw[at + 1] = ((colour[1] ?? 0) + y * 2) & 0xff
      raw[at + 2] = ((colour[2] ?? 0) + x + y) & 0xff
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('tEXt', Buffer.from(`Comment\0contentops smoke ${seed}`, 'latin1')),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** tus 1.0 in one chunk (SPEC §6.1), then the final command of the web upload. */
async function upload(name: string, bytes: Buffer, type: 'set' | 'custom') {
  const tus = { 'Tus-Resumable': '1.0.0' }
  const metadata = ['filename', name, 'kind', 'other']
  const encoded = [
    `${metadata[0]} ${Buffer.from(metadata[1] as string).toString('base64')}`,
    `${metadata[2]} ${Buffer.from(metadata[3] as string).toString('base64')}`,
  ].join(',')
  const created = await authorized(`${BASE}/api/v1/${SMOKE_MODEL}/uploads/tus`, {
    method: 'POST',
    headers: { ...tus, 'Upload-Length': String(bytes.length), 'Upload-Metadata': encoded },
  })
  await created.arrayBuffer()
  const location = created.headers.get('location')
  if (created.status !== 201 || !location) throw new Error(`tus create: ${created.status}`)
  const sent = await authorized(new URL(location, BASE).toString(), {
    method: 'PATCH',
    headers: {
      ...tus,
      'Upload-Offset': '0',
      'Content-Type': 'application/offset+octet-stream',
    },
    body: new Uint8Array(bytes),
  })
  await sent.arrayBuffer()
  if (sent.status !== 204) throw new Error(`tus patch: ${sent.status}`)
  const uploadId = location.split('/').pop() as string
  return api.inbox.upload({
    params: { model: SMOKE_MODEL },
    body: {
      kind: 'other',
      target: null,
      type,
      files: [{ upload_id: uploadId, file_name: name, size_bytes: bytes.length, media: 'photo' }],
    },
  })
}

/** The group once its files are checked: ready, a decision, accepted or an error. */
function settled(group: InboxGroup): DraftState | undefined {
  return group.state.kind === 'preparing' ? undefined : group.state
}

async function settle(group: string): Promise<InboxGroup> {
  return until(`group ${group} prepared`, async () => {
    const view = await api.inbox.get({ params: { model: SMOKE_MODEL, group } })
    return settled(view) ? view : undefined
  })
}

/** Accepts a prepared group; `orderId` answers «Какой заказ?» for a CUS. */
async function accept(group: string, orderId?: string): Promise<{ id: string; how: string }> {
  let view = await settle(group)
  if (view.state.kind === 'decision') {
    const decision = view.state.decision
    if (decision === 'which_order' && orderId) {
      await api.inbox.decide({
        params: { model: SMOKE_MODEL, group },
        body: { decision: 'which_order', order_id: orderId },
      })
    } else if (decision === 'what_is_it') {
      await api.inbox.decide({
        params: { model: SMOKE_MODEL, group },
        body: { decision: 'what_is_it', type: orderId ? 'custom' : 'set' },
      })
    } else throw new Error(`group asks «${decision}»`)
    view = await settle(group)
  }
  if (view.state.kind === 'accepted') return { id: view.state.item_id, how: view.state.how }
  if (view.state.kind !== 'ready') {
    throw new Error(`group is ${view.state.kind}: ${JSON.stringify(view.state)}`)
  }
  const accepted = await api.inbox.accept({
    params: { model: SMOKE_MODEL, group },
    body: { as: 'default' },
  })
  return { id: accepted.item_id, how: accepted.how }
}

/** A ready file of an object: its handle, size and thumbnail. */
function readyFiles(item: ItemDetail) {
  return item.files.filter((file) => file.state.kind === 'ready')
}

/** The download of one file with its receipt, then its bytes through nginx. */
async function downloadOne(model: string, item: string, key: string, expected: number) {
  let answer = await api.objectFiles.download({
    params: { model, id: item },
    body: { keys: [handle(key)], strip_metadata: false },
  })
  let url: string | null = answer.kind === 'ready' ? answer.download_url : null
  if (answer.kind === 'operation') {
    const id = answer.operation_id
    url = await until(`download ${item}`, async () => {
      const operation = await api.operations.get({ params: { model, operation: id } })
      if (operation.state === 'failed') throw new Error(operation.error?.message ?? 'failed')
      return operation.state === 'done' ? (operation.result?.download_url ?? undefined) : undefined
    })
    answer = { kind: 'ready', download_url: url, file_name: '', size_bytes: expected }
  }
  const got = await bytesOf(url as string)
  if (got.size !== expected) throw new Error(`${got.size} bytes, expected ${expected}`)
  return `${item}/${handle(key)} · ${got.size} B · receipt ${String(url).split('/').pop()}`
}

// --- Reads: every area of every model the agent sees -------------------------------------

async function readModel(
  model: string,
): Promise<{ item: string; key: string; size: number } | null> {
  const index = await check(model, 'library index', async () => {
    const value = await api.objects.catalogIndex({ params: { model } })
    return { value, detail: `${value.items.length} objects` }
  })
  await check(model, 'page summaries', async () => {
    const value = await api.objects.pageSummaries({ params: { model } })
    return `${value.entries.length} rows`
  })
  await check(model, 'list · recent', async () => {
    const list = await api.objects.list({ params: { model }, query: { limit: 5 } })
    const recent = await api.objects.recent({ params: { model } })
    return `${list.items.length} listed, ${recent.items.length} recent`
  })
  const first = index?.items[0]
  await check(model, 'search · resolve', async () => {
    if (!first) throw new Skip('no objects')
    const word = first.title.split(/\s+/)[0] || first.id
    const search = await api.objects.search({ params: { model }, query: { q: word } })
    const resolved = await api.objects.resolve({ params: { model }, query: { q: first.id } })
    if (resolved.item_id !== first.id) throw new Error(`resolve ${first.id} → ${resolved.item_id}`)
    const hits = search.groups.reduce((sum, group) => sum + group.total, 0)
    return `«${word}»: ${hits} hits; ${first.id} resolved`
  })
  await check(model, 'object card', async () => {
    if (!first) throw new Skip('no objects')
    const item = await api.objects.get({ params: { model, id: first.id } })
    return `${item.entry.id}: ${item.files.length} files`
  })
  await check(model, 'thumbnail', async () => {
    const covered = index?.items.find((entry) => entry.cover.url)
    if (!covered?.cover.url) throw new Skip('no object has a built thumbnail yet')
    const got = await bytesOf(covered.cover.url)
    if (!got.type.startsWith('image/') || got.size === 0)
      throw new Error(`${got.type} ${got.size} B`)
    return `${covered.id}: ${got.type}, ${got.size} B`
  })
  await check(model, 'journal', async () => {
    const page = await api.journal.list({ params: { model }, query: { limit: 5 } })
    return `${page.items.length} latest events`
  })
  await check(model, 'plan day · week', async () => {
    const day = await api.plan.day({ params: { model }, query: { date: today() } })
    const week = await api.plan.week({ params: { model }, query: { week: isoWeekOf(today()) } })
    return `today ${day.rows.length} rows; week ${isoWeekOf(today())} read (${week.dates.length} days)`
  })
  await check(model, 'orders', async () => {
    const orders = await api.orders.list({ params: { model } })
    return `${orders.items.length} orders`
  })
  await check(model, 'promo', async () => {
    const channels = await api.promo.channels({ params: { model } })
    const handoffs = await api.promo.handoffs({ params: { model } })
    return `${channels.items.length} channels, ${handoffs.items.length} handoffs`
  })
  await check(model, '«Сверить»', async () => {
    const cases = await api.check.list({ params: { model } })
    const unverified = await api.check.unverified({ params: { model } })
    return `${cases.items.length} cases, ${unverified.items.length} unverified`
  })
  await check(model, '«Приехало» · old names', async () => {
    const inbox = await api.inbox.list({ params: { model } })
    const legacy = await api.legacy.get({ params: { model } })
    return `${inbox.count} groups need a person; ${legacy.disputes.length} legacy disputes`
  })
  // A small ready file of the first objects for the download check.
  for (const entry of (index?.items ?? []).slice(0, 25)) {
    if (!(entry.photo_count ?? 0) && !(entry.video_count ?? 0)) continue
    const item = await api.objects.get({ params: { model, id: entry.id } })
    const file = readyFiles(item).sort((a, b) => a.size_bytes - b.size_bytes)[0]
    if (file && file.size_bytes > 0 && file.size_bytes < 64 * 1024 * 1024) {
      return { item: item.entry.id, key: file.key, size: file.size_bytes }
    }
  }
  return null
}

// --- Writes: the processes of stages 2–5 inside the smoke model --------------------------

async function writeSmoke(): Promise<{ item: string; key: string; size: number } | null> {
  const area = `${SMOKE_MODEL} (writes)`
  const contractor = await check(area, 'contractor', async () => {
    const list = await api.promo.contractors({ params: { model: SMOKE_MODEL } })
    const found = list.items.find((one) => one.name === SMOKE_CONTRACTOR)
    if (!found) throw new Error(`«${SMOKE_CONTRACTOR}» missing: run ops.js smoke-setup`)
    return { value: found.id, detail: found.name }
  })
  const order = await check(area, 'order created', async () => {
    const created = await api.orders.create({
      params: { model: SMOKE_MODEL },
      body: {
        message_url: `https://t.me/c/1999999999/1/${Math.floor(Date.now() / 1000)}`,
        buyer: 'проверка',
        account: SMOKE_PAGES[0],
        brief: `проверка ${RUN}`,
        duration_raw: '',
        wants_video: false,
        wants_photos: 1,
        deadline: addDays(today(), 7),
        fan_name: 'no',
        card_text: `Проверочный заказ ${RUN}`,
      },
    })
    return { value: created.id, detail: `${created.id} · ${created.state}` }
  })
  const set = await check(area, 'web upload SET', async () => {
    const sent = await upload(`smoke-set-${RUN}.png`, tinyPng(`set ${RUN}`), 'set')
    return { value: sent.group_id, detail: `group ${sent.group_id} · ${sent.placed}` }
  })
  const cus = await check(area, 'web upload CUS', async () => {
    const sent = await upload(`smoke-cus-${RUN}.png`, tinyPng(`cus ${RUN}`), 'custom')
    return { value: sent.group_id, detail: `group ${sent.group_id} · ${sent.placed}` }
  })
  const setItem = await check(area, 'accept SET', async () => {
    const accepted = await accept(need(set, 'upload'))
    return { value: accepted.id, detail: `${accepted.id} · ${accepted.how}` }
  })
  const cusItem = await check(area, 'accept CUS', async () => {
    const accepted = await accept(need(cus, 'upload'), need(order, 'order'))
    return { value: accepted.id, detail: `${accepted.id} · ${accepted.how}` }
  })
  await check(area, 'order delivered · closed', async () => {
    const id = need(order, 'order')
    const item = need(cusItem, 'accept CUS')
    let current = await api.orders.get({ params: { model: SMOKE_MODEL, order: id } })
    if (!current.deliveries.some((delivery) => delivery.item_id === item)) {
      current = await api.orders.linkDelivery({
        params: { model: SMOKE_MODEL, order: id },
        body: { item_id: item, part: 'photos', complete: true },
      })
    }
    const key = randomUUID()
    const closed = await api.orders.close({
      params: { model: SMOKE_MODEL, order: id },
      idempotencyKey: key,
    })
    const again = await api.orders.close({
      params: { model: SMOKE_MODEL, order: id },
      idempotencyKey: key,
    })
    if (closed.state !== 'closed') throw new Error(`state ${closed.state}`)
    if (JSON.stringify(again) !== JSON.stringify(closed)) {
      throw new Error('a repeat with the same Idempotency-Key answered differently')
    }
    return `${id}: delivered by ${item}, closed; the repeat replayed the answer`
  })
  const detail = await check(area, 'object card · thumbnail', async () => {
    const item = await api.objects.get({
      params: { model: SMOKE_MODEL, id: need(setItem, 'accept SET') },
    })
    const file = readyFiles(item)[0]
    if (!file) throw new Error('no ready file')
    if (!file.thumb.url) throw new Error('no thumbnail built')
    const got = await bytesOf(file.thumb.url)
    return {
      value: { item, file },
      detail: `${item.entry.id}/${handle(file.key)} · thumbnail ${got.size} B`,
    }
  })
  const rows = await check(area, 'plan: two rows', async () => {
    const item = need(setItem, 'accept SET')
    const row = (account: string, date: string) => ({
      item_id: item,
      account,
      surface: 'wall' as const,
      date,
      time: null,
      fyp_version: null,
      assignee: null,
      note: `проверка ${RUN}`,
      requires_new_upload: false,
      awaiting_montage: null,
      marked: null,
    })
    const created = await api.plan.createRows({
      params: { model: SMOKE_MODEL },
      body: {
        rows: [row(SMOKE_PAGES[0], today()), row(SMOKE_PAGES[1], addDays(today(), 1))],
      },
    })
    if (!created.created) {
      throw new Error(created.rejected.map((one) => `${one.code}: ${one.text}`).join('; '))
    }
    const [first, second] = created.rows
    if (!first || !second) throw new Error(`${created.rows.length} rows`)
    return {
      value: { posted: first.id, cancelled: second.id },
      detail: `${first.id}, ${second.id}`,
    }
  })
  await check(area, 'plan: mark · cancel', async () => {
    const ids = need(rows, 'plan rows')
    const marked = await api.plan.mark({
      params: { model: SMOKE_MODEL, row: ids.posted },
      body: { kind: 'posted', stated_occurred_at: new Date().toISOString() },
    })
    const cancelled = await api.plan.cancel({
      params: { model: SMOKE_MODEL, row: ids.cancelled },
      body: { reason: 'paused' },
    })
    const day = await api.plan.day({ params: { model: SMOKE_MODEL }, query: { date: today() } })
    if (!day.rows.some((one) => one.id === ids.posted))
      throw new Error('the marked row is not in today')
    return `marked «${marked.verdict.word}», cancelled «${cancelled.verdict.word}»`
  })
  await check(area, 'promo handoff', async () => {
    const { item, file } = need(detail, 'object card')
    const collection = await api.promo.add({
      params: { model: SMOKE_MODEL },
      body: {
        channel: SMOKE_CHANNEL,
        collection: 'new',
        title: `Проверка ${RUN}`,
        members: [{ item_id: item.entry.id, file_key: handle(file.key) }],
      },
    })
    const started = await api.promo.prepareHandoff({
      params: { model: SMOKE_MODEL, collection: collection.id },
      body: {
        contractor_id: need(contractor, 'contractor'),
        strip_metadata: false,
        exclude_already_handed: false,
        members: null,
      },
    })
    const prepared = await until(`handoff ${started.handoff_id}`, async () => {
      const view = await api.promo.collection({
        params: { model: SMOKE_MODEL, collection: collection.id },
      })
      const handoff = view.handoffs.find((one) => one.id === started.handoff_id)
      if (handoff?.state === 'failed') throw new Error(handoff.failure ?? 'handoff failed')
      return handoff?.state === 'prepared' ? handoff : undefined
    })
    const zip = await bytesOf(prepared.zip_url as string)
    const sent = await api.promo.markSent({
      params: { model: SMOKE_MODEL, collection: collection.id, handoff: prepared.id },
    })
    return `${collection.id}: ZIP ${zip.size} B, «${sent.status.word}»`
  })
  await check(area, '«Сверить» · journal', async () => {
    const cases = await api.check.list({ params: { model: SMOKE_MODEL } })
    const journal = await api.journal.list({ params: { model: SMOKE_MODEL }, query: { limit: 50 } })
    if (journal.items.length === 0) throw new Error('the journal of the smoke model is empty')
    return `${cases.items.length} cases; ${journal.items.length} latest events`
  })
  if (!detail) return null
  return { item: detail.item.entry.id, key: detail.file.key, size: detail.file.size_bytes }
}

// --- Main ---------------------------------------------------------------------------------

async function main(): Promise<number> {
  const healthy = await check('stack', 'healthz', async () => {
    const response = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(10_000) })
    const body = await response.text()
    if (!response.ok) throw new Error(`${response.status} ${body}`)
    return { value: true, detail: body }
  })
  const models = await check('stack', 'agent token', async () => {
    if (!TOKEN) throw new Error('CONTENTOPS_TOKEN is empty: ops.js smoke-setup --token')
    const list = await api.admin.models({})
    return {
      value: list.items.map((model) => model.code),
      detail: `models: ${list.items.map((model) => model.code).join(', ')}`,
    }
  })
  if (healthy && models) {
    await check('stack', 'state', async () => {
      const state = await api.admin.state({})
      const paused = state.queues.filter((queue) => queue.paused).map((queue) => queue.label)
      const disks = state.disks
        .map(
          (disk) =>
            `${disk.name} ${disk.free_bytes === null ? 'нет данных' : `${Math.round(disk.free_bytes / 1e9)} GB free`}`,
        )
        .join(', ')
      const queued = state.queues.reduce((sum, queue) => sum + queue.pending, 0)
      return `${queued} queued${paused.length ? `, paused: ${paused.join(', ')}` : ''}; ${disks || 'no disks'}`
    })
    await check('stack', 'integrations', async () => {
      const list = await api.admin.integrations({})
      const wanted = list.items.filter((one) => ['hub', 'ydisk', 'dropbox'].includes(one.kind))
      const summary = new Map<string, number>()
      for (const one of wanted) {
        const key = `${one.kind} ${one.state}${one.down_reason ? `/${one.down_reason}` : ''}`
        summary.set(key, (summary.get(key) ?? 0) + 1)
      }
      const text = [...summary].map(([key, count]) => `${key} ×${count}`).join(', ') || 'none'
      const down = wanted.filter((one) => one.state === 'down')
      if (down.length > 0) {
        throw new Warn(
          `${text} — down: ${down.map((one) => `${one.kind} ${one.account ?? one.model ?? ''}`).join(', ')}`,
        )
      }
      return text
    })
    await check('stack', 'counters', async () => {
      const counters = await api.admin.counters({})
      return `${counters.models.length} models; space: ${counters.space.label}`
    })
    let candidate: { model: string; item: string; key: string; size: number } | null = null
    for (const model of models.filter((code) => code !== SMOKE_MODEL)) {
      const found = await readModel(model)
      if (found && !candidate) candidate = { model, ...found }
    }
    let smoke: { item: string; key: string; size: number } | null = null
    if (!models.includes(SMOKE_MODEL)) {
      await check(`${SMOKE_MODEL} (writes)`, 'smoke model', async () => {
        throw new Error(`the agent does not see «${SMOKE_MODEL}»: run ops.js smoke-setup`)
      })
    } else if (flags['reads-only']) {
      await check(`${SMOKE_MODEL} (writes)`, 'writes', async () => {
        throw new Skip('--reads-only')
      })
    } else {
      smoke = await writeSmoke()
    }
    await check('download', 'one file with a receipt', async () => {
      const target = candidate ?? (smoke ? { model: SMOKE_MODEL, ...smoke } : null)
      if (!target) throw new Skip('no ready file anywhere yet')
      return `${target.model}: ${await downloadOne(target.model, target.item, target.key, target.size)}`
    })
  }

  const failed = lines.filter((line) => line.status === 'FAIL').length
  const count = (status: Status) => lines.filter((line) => line.status === status).length
  const area = Math.max(...lines.map((line) => line.area.length))
  const name = Math.max(...lines.map((line) => line.name.length))
  process.stdout.write(`smoke ${RUN} · ${BASE}\n`)
  for (const line of lines) {
    process.stdout.write(
      `${line.status.padEnd(4)}  ${line.area.padEnd(area)}  ${line.name.padEnd(name)}  ${String(line.ms).padStart(6)} ms  ${line.detail}\n`,
    )
  }
  process.stdout.write(
    `${failed ? 'FAILED' : 'PASSED'}: ${count('ok')} ok, ${count('warn')} warn, ${count('skip')} skipped, ${failed} failed\n`,
  )
  return failed ? 1 : 0
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`smoke: ${describe(error)}\n`)
    process.exit(1)
  },
)
