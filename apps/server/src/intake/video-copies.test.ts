import { randomUUID } from 'node:crypto'
import { SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { VIDEO_PRINT_PROFILE } from '@contentops/media'
import { recordingRetry } from '@contentops/sources/testing'
import { type SQL, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLogger } from '../logger'
import type { BlobStore } from '../media/storage'
import { registerBlob } from '../media/storage-ops'
import { tempStore } from '../media/testing'
import { buildServer } from '../server'
import { call, newKey, signIn } from '../testing/server'
import { fetchHandler } from './fetch'
import { scanHandler } from './scan'
import { drain, type IntakeHarness, intakeHarness, LORA_ROOT, runWork, setSwitch } from './testing'
import { similarVideos, videoCopiesReport } from './video-copies'

/**
 * ◆ «Похоже на ролик» (SPEC §6.2): a copy of a montage with other bytes must not become an
 * object of its own by itself — 17 extra FYP of Ари came that way. The prints are written
 * here as `derive_video` leaves them; the frames themselves are tested with real tools.
 */

let h: IntakeHarness
let store: BlobStore
let app: ReturnType<typeof buildServer>
let owner: string

beforeAll(async () => {
  h = await intakeHarness()
  store = await tempStore('video-copies')
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
  await setSwitch(h.db, 'dropbox.scan', h.modelId, true)
})
afterAll(async () => {
  await app?.close()
  await h?.close()
})

const asTest = <T>(work: (tx: Parameters<Parameters<typeof withActorTx>[2]>[0]) => Promise<T>) =>
  withActorTx(h.db, { actor: SYSTEM_ACTOR('test'), action: 'test', requestId: randomUUID() }, work)
const run = (query: SQL) => asTest((tx) => tx.execute(query))

/** Ten frames of 64 bits; `flip` bits differ in every frame. */
function frames(seed: number, flip = 0): string[] {
  return VIDEO_PRINT_PROFILE.permille.map((_, frame) => {
    let x = BigInt(seed * 7919 + frame * 104_729) * 0x9e3779b97f4a7c15n
    const bits: string[] = []
    for (let i = 0; i < 64; i++) {
      x = (x * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) % 2n ** 64n
      bits.push(x >> 63n ? '1' : '0')
    }
    for (let i = 0; i < flip; i++) bits[i * 7] = bits[i * 7] === '1' ? '0' : '1'
    return bits.join('')
  })
}

/** A montage in `7. Монтажи`: a FYP of its own group, fetched, its master ready, its print. */
async function montage(name: string, size: number, print: string[], durationMs = 7300) {
  const path = `${LORA_ROOT}/7. Монтажи/Алиса/${name}.mp4`
  h.dropbox.tree.addFile(path, size)
  await runWork(h.db, {
    modelId: h.modelId,
    kind: 'scan',
    scope: h.sources.dropbox.id,
    dataset: 'full',
    handlers: { scan: scanHandler(h.factory) },
  })
  await drain(h.db, ['fetch'], {
    fetch: fetchHandler({
      factory: h.factory,
      store,
      fetchAheadGb: 25,
      retry: recordingRetry({ attempts: 2 }).policy,
    }),
  })
  const { rows } = await h.db.execute<{ id: string; group_id: string; sha: string }>(sql`
    SELECT id, group_id, encode(source_sha256, 'hex') AS sha FROM inbox_drafts WHERE path = ${path}`)
  const draft = rows[0]
  if (!draft) throw new Error(`no draft for ${path}`)
  const staged = await store.staged(draft.sha)
  if (!staged) throw new Error(`nothing staged for ${path}`)
  await registerBlob(h.db, store, {
    file: staged.path,
    sha256: draft.sha,
    ext: staged.ext,
    mediaKind: 'video',
    owner: 'test:',
  })
  await run(sql`
    UPDATE inbox_drafts
       SET master_sha256 = source_sha256, master_is_source = true, master_verified_at = now(),
           state = 'ready', ready_at = now()
     WHERE id = ${draft.id}::uuid`)
  await h.db.execute(sql`
    UPDATE work_operations SET state = 'cancelled', finished_at = now()
     WHERE draft_id = ${draft.id}::uuid AND kind <> 'fetch' AND state = 'pending'`)
  await h.db.execute(sql`
    INSERT INTO video_prints (sha256, algorithm, algo_version, duration_ms, frames)
    VALUES (decode(${draft.sha}, 'hex'), ${VIDEO_PRINT_PROFILE.algorithm}, 'sharp-phash@test',
            ${durationMs}, ${`{${print.join(',')}}`}::bit(64)[])`)
  return { draftId: draft.id, groupId: draft.group_id }
}

const decide = (group: string, body: object) =>
  call(app, {
    method: 'POST',
    url: `/api/v1/lora/inbox/groups/${group}:decide`,
    as: owner,
    key: newKey(),
    body,
  })
const accept = (group: string) =>
  call(app, {
    method: 'POST',
    url: `/api/v1/lora/inbox/groups/${group}:accept`,
    as: owner,
    key: newKey(),
    body: { as: 'default' },
  })
const group = async (id: string) =>
  (await call(app, { method: 'GET', url: `/api/v1/lora/inbox/groups/${id}`, as: owner })).json()

describe('«Похоже на ролик» (SPEC §6.2)', () => {
  it('asks about a close print, an alias by «Это копия», a file of its own otherwise', async () => {
    const original = await montage('I never touched', 6100, frames(1))
    const accepted = await accept(original.groupId)
    expect(accepted.statusCode, accepted.body).toBe(200)
    const item = accepted.json().item_id as string

    // No threshold — the function is off, as every setting of §13.
    const quiet = await montage('I never touched (norm)', 6200, frames(1, 2))
    expect(await asTest((tx) => similarVideos(tx, h.modelId, quiet.draftId))).toBe(0)

    await run(sql`
      INSERT INTO policy_settings (key, value) VALUES ('video_suggest_threshold', '85'::jsonb)`)
    expect(await asTest((tx) => similarVideos(tx, h.modelId, quiet.draftId))).toBe(1)
    const asked = await group(quiet.groupId)
    expect(asked.state).toEqual({ kind: 'decision', decision: 'video_copy' })
    expect(asked.hints).toContainEqual(
      expect.objectContaining({
        kind: 'similar_video',
        text: `Похоже на ролик ${item}/master`,
        draft_key: quiet.draftId,
        frames_close: 10,
      }),
    )
    // «Принять» waits for the answer: nothing is decided by the print.
    const refused = await accept(quiet.groupId)
    expect(refused.json()).toMatchObject({
      code: 'accept_blocked',
      details: { reason: 'video_copy' },
    })

    const copy = await decide(quiet.groupId, {
      decision: 'video_copy',
      file_key: quiet.draftId,
      copy: true,
    })
    expect(copy.statusCode, copy.body).toBe(200)
    expect(copy.json().state).toMatchObject({ kind: 'accepted', how: 'duplicate', item_id: item })
    const { rows: alias } = await h.db.execute<{ outcome: string; journal: string }>(sql`
      SELECT d.outcome,
             (SELECT action FROM action_log WHERE subject_id = d.id ORDER BY id DESC LIMIT 1) AS journal
        FROM inbox_drafts d WHERE d.id = ${quiet.draftId}::uuid`)
    expect(alias).toEqual([{ outcome: 'alias', journal: 'draft.copy' }])

    // Another export of the same picture that is a file of its own goes on with its group.
    const second = await montage('Which do you prefer', 6300, frames(1, 4))
    expect(await asTest((tx) => similarVideos(tx, h.modelId, second.draftId))).toBe(1)
    const separate = await decide(second.groupId, {
      decision: 'video_copy',
      file_key: second.draftId,
      copy: false,
    })
    expect(separate.statusCode, separate.body).toBe(200)
    expect(separate.json().state.kind).toBe('ready')
    // The answer stays: the same print is not asked again when the draft becomes ready.
    expect(await asTest((tx) => similarVideos(tx, h.modelId, second.draftId))).toBe(0)
    expect((await accept(second.groupId)).statusCode).toBe(200)

    // Another montage — other frames — and another length are never asked.
    const other = await montage('хук', 6400, frames(2))
    const longer = await montage('I never touched long', 6500, frames(1, 1), 9300)
    expect(await asTest((tx) => similarVideos(tx, h.modelId, other.draftId))).toBe(0)
    expect(await asTest((tx) => similarVideos(tx, h.modelId, longer.draftId))).toBe(0)

    // The report of the accepted library pairs the two accepted exports.
    const report = await videoCopiesReport(h.db, { id: h.modelId, code: 'lora' }, null)
    expect(report.pairs).toEqual([
      expect.objectContaining({ a: `${item}/master`, frames_close: 10 }),
    ])
  })
})
