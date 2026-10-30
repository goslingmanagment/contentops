import { randomUUID } from 'node:crypto'
import {
  type Db,
  enqueueWork,
  resumeSwitch,
  SYSTEM_ACTOR,
  type WorkHandler,
  WorkRunner,
  withActorTx,
} from '@contentops/db'
import { createHubClient, type HubClient } from '@contentops/hub'
import { FAKE_HUB_KEY, type FakeHub, fakeRow, recordingRetry } from '@contentops/hub/testing'
import { sql } from 'drizzle-orm'
import { vi } from 'vitest'
import { createWorkGate } from '../work-gate'
import { type HubSyncOptions, hubSyncHandler } from './sync'

/**
 * Hub on a fake server for the poll tests (SPEC §12.0: external systems are fake HTTP servers,
 * no live keys in CI). Everything here is made up: refs, names and captions are fictional.
 */

export interface PageIds {
  modelId: string
  accountId: string
}

export async function pageIds(db: Db, code: string): Promise<PageIds> {
  const { rows } = await db.execute<{ model_id: string; id: string }>(sql`
    SELECT model_id, id FROM accounts WHERE code = ${code}`)
  const row = rows[0]
  if (!row) throw new Error(`no page ${code}`)
  return { modelId: row.model_id, accountId: row.id }
}

const ACTOR = (action: string) => ({
  actor: SYSTEM_ACTOR('test'),
  action,
  requestId: randomUUID(),
})

export async function setHubPage(db: Db, code: string, hubPage: string | null): Promise<void> {
  await withActorTx(db, ACTOR('test.hub_page'), (tx) =>
    tx.execute(sql`UPDATE accounts SET hub_page_ref = ${hubPage} WHERE code = ${code}`),
  )
}

/** «Получать данные» of one page; switching on releases what the switch paused. */
export async function setReceive(db: Db, page: PageIds, on: boolean): Promise<void> {
  await withActorTx(db, ACTOR('test.switch'), async (tx) => {
    await tx.execute(sql`
      INSERT INTO policy_settings (model_id, account_id, key, value)
      VALUES (${page.modelId}::uuid, ${page.accountId}::uuid, 'hub.receive', ${JSON.stringify(on)}::jsonb)
      ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE SET value = excluded.value`)
    if (on) await resumeSwitch(tx, 'hub.receive')
  })
}

/** A client of the fake Hub that does not really wait between retries. */
export function fakeClient(
  hub: FakeHub,
  options: { attempts?: number; fetch?: typeof fetch } = {},
): { client: HubClient; delays: number[] } {
  const { policy, delays } = recordingRetry({ attempts: options.attempts ?? 2 })
  const client = createHubClient({
    baseUrl: hub.url,
    key: FAKE_HUB_KEY,
    retry: policy,
    now: () => hub.now(),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  return { client, delays }
}

export interface WorkOutcome {
  id: string
  state: string
  error_code: string | null
  error_text: string | null
  paused_reason: string | null
  report: Record<string, unknown> | null
  next_attempt_at: string
  attempt_no: number
  fence_generation: number
}

export async function workOutcome(db: Db, id: string): Promise<WorkOutcome> {
  const { rows } = await db.execute<WorkOutcome & Record<string, unknown>>(sql`
    SELECT id, state, error_code, error_text, paused_reason, report, next_attempt_at::text,
           attempt_no, fence_generation::int
      FROM work_operations WHERE id = ${id}::uuid`)
  const [row] = rows
  if (!row) throw new Error(`no work ${id}`)
  return row
}

let serial = 0

/** Queues one `hub_sync` work of a page and dataset, as the scheduler would. */
export async function enqueueHub(db: Db, page: PageIds, dataset: string): Promise<string> {
  serial += 1
  const { work } = await withActorTx(db, ACTOR('test.enqueue'), (tx) =>
    enqueueWork(tx, {
      modelId: page.modelId,
      kind: 'hub_sync',
      workKey: `hub:${page.accountId}:${dataset}@test-${serial}-${randomUUID()}`,
      accountId: page.accountId,
      dataset,
      streamKey: `hub:${page.accountId}:${dataset}`,
    }),
  )
  return work.id
}

const settled = (outcome: WorkOutcome) =>
  ['succeeded', 'failed', 'cancelled'].includes(outcome.state) ||
  (outcome.state === 'retry_wait' &&
    (outcome.paused_reason !== null || outcome.error_code !== null))

/**
 * Runs the work through a `worker` runner with the real gate until a claim of it settles.
 * `claim: false` — the work is expected to stay where it is (paused): the runner just runs a
 * moment.
 */
export async function runHubWork(
  db: Db,
  workId: string,
  handler: WorkHandler,
  options: {
    claim?: boolean
    extra?: Partial<Record<string, WorkHandler>>
    /** The kind the handler runs (default `hub_sync`). */
    kind?: 'hub_sync' | 'hub_publish'
  } = {},
): Promise<WorkOutcome> {
  const start = await workOutcome(db, workId)
  const runner = new WorkRunner({
    db,
    role: 'worker',
    handlers: { [options.kind ?? 'hub_sync']: handler, ...options.extra } as never,
    gate: createWorkGate(),
    pollMs: 20,
    leaseMs: 5_000,
    backoffMs: () => 60_000,
    maxAttempts: 3,
    stopTimeoutMs: 1_000,
  })
  runner.start()
  try {
    if (options.claim === false) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      return await workOutcome(db, workId)
    }
    return await vi.waitFor(
      async () => {
        const outcome = await workOutcome(db, workId)
        if (outcome.fence_generation <= start.fence_generation || !settled(outcome)) {
          throw new Error(`work ${workId} is ${outcome.state}`)
        }
        return outcome
      },
      { timeout: 20_000, interval: 25 },
    )
  } finally {
    await runner.stop()
  }
}

/** Queues and runs one poll of a page and dataset. */
export async function syncOnce(
  db: Db,
  page: PageIds,
  dataset: string,
  options: HubSyncOptions,
): Promise<WorkOutcome> {
  return runHubWork(db, await enqueueHub(db, page, dataset), hubSyncHandler(options))
}

const HOUR = 3_600_000

/** Fictional content of one Fansly page: three posts, their files, a vault album, stats. */
export function seedFansly(hub: FakeHub, page: string, at: Date): void {
  const iso = (hoursAgo: number) => new Date(at.getTime() - hoursAgo * HOUR).toISOString()
  hub.put('posts', page, [
    post('post-1', iso(72), 'Test caption one', 2),
    post('post-2', iso(48), 'Test caption two', 1),
    post('post-3', iso(24), 'Test caption three', 0),
  ])
  hub.put('post_attachments', page, [
    attachment('post-1', iso(72), 0, 'media-1', 'PPV-001_V1_page-a.mp4'),
    attachment('post-1', iso(72), 1, 'media-2', 'PPV-001_V2_page-a.mp4'),
    attachment('post-2', iso(48), 0, 'media-3', 'SET-002_01_page-a.jpg'),
    attachment('post-2', iso(48), 0, 'media-4', 'SET-002_01_page-a.jpg', 'offer_preview'),
  ])
  hub.put(
    'raw_media',
    page,
    ['media-1', 'media-2', 'media-3', 'media-4'].map((ref, i) =>
      fakeRow('raw_media', ref, {
        platform: 'fansly',
        mediaRef: ref,
        filename: `FILE-${i + 1}.MP4`,
        mimeType: 'video/mp4',
        durationMs: 7_000 + i,
        originalWidth: 1080,
        originalHeight: 1920,
        firstObservedAt: iso(70 - i),
      }),
    ),
  )
  hub.put('vault_media', page, [
    member('album-1', 'PPV-001 Тест', 'member-1', 'media-1', iso(30), 'creator'),
    member('album-1', 'PPV-001 Тест', 'member-2', 'media-2', iso(30), 'creator'),
    // The user vault (likes and purchases) is never mirrored.
    member('album-9', 'Likes', 'member-9', 'media-9', iso(30), 'user'),
  ])
  hub.put('creator_stats_media_daily', page, [
    fakeRow('creator_stats_media_daily', 'offer-1:media-1:0:2026-10-25', {
      platform: 'fansly',
      mediaOfferId: 'offer-1',
      mediaId: 'media-1',
      source: 0,
      sourceLabel: 'For You',
      day: '2026-10-25',
      views: 120,
      capturedAt: iso(5),
    }),
  ])
  hub.put('creator_stats_media_likes', page, [
    fakeRow('creator_stats_media_likes', 'offer-1:0:2026-10-25', {
      platform: 'fansly',
      mediaOfferId: 'offer-1',
      source: 0,
      day: '2026-10-25',
      likes: 9,
      capturedAt: iso(5),
    }),
  ])
  hub.put('capture_coverage', page, [
    fakeRow('capture_coverage', 'cov-1', {
      platform: 'fansly',
      plane: 'catalog_vault_media',
      scopeRef: 'album-1',
      status: 'provider_exhausted',
      updatedAt: iso(30),
    }),
  ])
}

export function post(ref: string, publishedAt: string, caption: string, files: number) {
  return fakeRow('posts', ref, {
    platform: 'fansly',
    postRef: ref,
    postText: caption,
    publishedAt,
    firstObservedAt: new Date(Date.parse(publishedAt) + 2 * HOUR).toISOString(),
    lastObservedAt: new Date(Date.parse(publishedAt) + 3 * HOUR).toISOString(),
    attachmentCount: files,
    fypFlags: 0,
    wallRefs: [],
  })
}

export function attachment(
  postRef: string,
  publishedAt: string,
  index: number,
  mediaRef: string,
  filename: string,
  role = 'main',
) {
  return fakeRow('post_attachments', `${postRef}:${index}::${role}`, {
    platform: 'fansly',
    postRef,
    publishedAt,
    attachmentIndex: index,
    pos: index,
    contentType: 1,
    contentRef: `offer-${postRef}-${index}`,
    role,
    mediaOfferRef: `offer-${mediaRef}`,
    mediaRef,
    linkState: 'resolved',
    filename,
    mimeType: 'video/mp4',
    durationMs: 7_000,
    originalWidth: 1080,
    originalHeight: 1920,
  })
}

export function member(
  albumRef: string,
  title: string,
  memberRef: string,
  mediaRef: string,
  firstObservedAt: string,
  vaultKind: 'creator' | 'user',
) {
  return fakeRow('vault_media', `${albumRef}:${memberRef}`, {
    platform: 'fansly',
    vaultKind,
    albumRef,
    albumTitle: title,
    lastFullWalkAt: firstObservedAt,
    fullWalkRef: 'walk-1',
    fullWalkObservedCount: 2,
    customFilename: `${mediaRef}.mp4`,
    filename: `${mediaRef}.mp4`,
    mimeType: 'video/mp4',
    mediaRef,
    memberRef,
    firstObservedAt,
  })
}
