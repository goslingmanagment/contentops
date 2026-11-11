import { randomUUID } from 'node:crypto'
import { type Db, SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import type { LegacyListingEntry } from '@contentops/legacy'
import { recordingRetry } from '@contentops/sources/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { duplicateOutcome, fetchHandler } from '../intake/fetch'
import { drain, type IntakeHarness, intakeHarness, LORA_ROOT, setSwitch } from '../intake/testing'
import type { BlobStore } from '../media/storage'
import { registerBlob } from '../media/storage-ops'
import { tempStore } from '../media/testing'
import { autoAcceptForDraft } from './auto-accept'
import { saveLabelTargets } from './labels'
import { claimsAgain } from './materialize'
import { enqueueImport } from './parse'
import { snapshotOf } from './snapshot'
import { freezeDisk, plantDisk, runImport, runQueued } from './testing'

/**
 * The same bytes in two places of the old disk (SPEC §6.1 p. 1, §6.2, §6.3): what becomes an
 * object is decided by the types of the groups, not by which of them was accepted first — a
 * posted FYP that is also a clip of `8. Other/нюды` stays a FYP; and a file resolved as an
 * alias places the claims of its old name on the object it repeats.
 */

let h: IntakeHarness
let store: BlobStore

const ctx = (action = 'test') => ({ actor: SYSTEM_ACTOR('test'), action, requestId: randomUUID() })

const file = (path: string, size: number, md5: string): LegacyListingEntry => ({
  path: `disk:/${path}`,
  isDir: false,
  size,
  md5,
  createdAt: '2025-09-20T10:00:00+00:00',
})

const POSTED_RAW = '2. FYP/Posted/August 2025 (posted)/posted/used1_2_14.08.mov'
const POSTED_RAW_AGAIN = '2. FYP/Posted/November 2025 (posted)/used3_2_19.09.mov'
const POSTED = '2. FYP/Posted/October 2025 (posted)/used2_2_15.09.mov'
const POSTED_AGAIN = '2. FYP/Posted/September2025 (posted)/used3_1_03.10.mov'
const NUDES = '8. Other/нюды'

// Equal md5 — equal bytes (`plantDisk`).
const DISK = [
  file(POSTED_RAW, 2000, 'a'),
  file(POSTED_RAW_AGAIN, 2000, 'a'),
  file(`${NUDES}/17.mov`, 2000, 'a'),
  file(`${NUDES}/18.mov`, 2100, 'b'),
  file(POSTED, 2200, 'c'),
  file(POSTED_AGAIN, 2200, 'c'),
]

beforeAll(async () => {
  h = await intakeHarness()
  store = await tempStore('legacy-duplicates')
  await setSwitch(h.db, 'ydisk.scan', h.modelId, true)
  plantDisk(h.yandex.tree, LORA_ROOT, DISK)
  expect((await freezeDisk(h, '2026-11-02')).state).toBe('succeeded')
  expect((await runImport(h.db, h.modelId, 'parse')).state).toBe('succeeded')
  // The КМ confirmed the labels: every `usedN` here is the one page of the harness.
  await withActorTx(h.db, ctx(), (tx) =>
    saveLabelTargets(
      tx,
      h.modelId,
      null,
      ['used1', 'used2', 'used3'].map((label) => ({
        label,
        target: { kind: 'accounts' as const, accounts: ['lora-1'] },
      })),
    ),
  )
}, 90_000)
afterAll(async () => {
  await h?.close()
})

async function bytes(root: string) {
  const { work } = await withActorTx(h.db, ctx(), async (tx) => {
    const snapshot = await snapshotOf(tx, h.modelId, null)
    if (!snapshot) throw new Error('no snapshot')
    return enqueueImport(tx, {
      modelId: h.modelId,
      mode: 'bytes',
      snapshot,
      nonce: randomUUID(),
      input: { roots: [root], folder: null, force: true },
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
    mediaKind: 'video',
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
}

/** The open drafts under a path, ready one by one in the order of their paths. */
async function readyUnder(prefix: string) {
  const { rows } = await h.db.execute<{ id: string }>(sql`
    SELECT id FROM inbox_drafts
     WHERE state <> 'resolved' AND path LIKE ${`disk:${LORA_ROOT}/${prefix}%`} ORDER BY path`)
  for (const row of rows) await makeReady(h.db, row.id)
}

async function outcomeOf(relative: string) {
  const { rows } = await h.db.execute<{ outcome: string | null; item: string | null }>(sql`
    SELECT d.outcome, public_item_id(i.type, i.number) AS item
      FROM inbox_drafts d LEFT JOIN content_items i ON i.id = d.applied_item_id
     WHERE d.path = ${`disk:${LORA_ROOT}/${relative}`}`)
  return rows[0]
}

/** Placements of the import: object, page, surface and how many claims are their evidence. */
async function placements() {
  const { rows } = await h.db.execute<{ item: string; surface: string; evidence: number }>(sql`
    SELECT public_item_id(i.type, i.number) AS item, s.kind AS surface,
           (SELECT count(*)::int FROM placement_evidence e WHERE e.placement_id = p.id) AS evidence
      FROM placements p
      JOIN surfaces s ON s.id = p.surface_id
      JOIN content_items i ON i.id = p.item_id
     WHERE p.origin = 'import'
     ORDER BY 1`)
  return rows
}

describe('the same bytes in a group of a ready type and in raw material', () => {
  it('raw material accepted first does not take a posted FYP: the FYP is its own object', async () => {
    expect((await bytes('2. FYP')).state).toBe('succeeded')
    expect((await bytes('8. Other')).state).toBe('succeeded')
    await drain(h.db, ['fetch'], {
      fetch: fetchHandler({
        factory: h.factory,
        store,
        fetchAheadGb: 25,
        retry: recordingRetry({ attempts: 1 }).policy,
      }),
    })
    // `8. Other/нюды` is ready first: it holds 17.mov before the FYP of the same bytes.
    await readyUnder(NUDES)
    expect(await outcomeOf(`${NUDES}/17.mov`)).toEqual({ outcome: 'new_item', item: 'RAW-0001' })
    // The open FYP draft of those bytes waits for its own acceptance instead of an alias.
    expect(await outcomeOf(POSTED_RAW)).toEqual({ outcome: null, item: null })
    await readyUnder('2. FYP')
    const fyp = await outcomeOf(POSTED_RAW)
    expect(fyp).toMatchObject({ outcome: 'new_item', item: expect.stringMatching(/^FYP-/) })
    // The third copy of the bytes repeats the FYP, not the raw material.
    expect(await outcomeOf(POSTED_RAW_AGAIN)).toEqual({ outcome: 'alias', item: fyp?.item })
    const { rows } = await h.db.execute<{ items: string[] }>(sql`
      SELECT array_agg(DISTINCT public_item_id(i.type, i.number) ORDER BY public_item_id(i.type, i.number)) AS items
        FROM asset_versions v
        JOIN item_memberships m ON m.asset_id = v.asset_id AND m.kind = 'owned'
        JOIN content_items i ON i.id = m.item_id
       WHERE v.master_sha256 = (SELECT master_sha256 FROM inbox_drafts
                                 WHERE path = ${`disk:${LORA_ROOT}/${NUDES}/17.mov`})`)
    expect(rows[0]?.items).toEqual([fyp?.item, 'RAW-0001'])
  })

  it('an alias places the claims of its old name on the object it repeats', async () => {
    // One FYP of the two posted copies; the other is its alias, and both names are placements.
    const first = await outcomeOf(POSTED_AGAIN)
    const again = await outcomeOf(POSTED)
    expect([first?.outcome, again?.outcome].sort()).toEqual(['alias', 'new_item'])
    expect(first?.item).toBe(again?.item)
    const fyp = (await outcomeOf(POSTED_RAW))?.item as string
    expect(await placements()).toEqual(
      [
        // used1_2_14.08 and the alias's used3_2_19.09: one undated placement, two claims.
        { item: fyp, surface: 'fyp', evidence: 2 },
        { item: first?.item as string, surface: 'fyp', evidence: 2 },
      ].sort((a, b) => a.item.localeCompare(b.item)),
    )
    const { rows } = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM legacy_claims
       WHERE claim_kind = 'used' AND resolution = 'pending'`)
    expect(rows[0]?.n).toBe(0)
  })

  it('`ops.js claims` places what an alias missed and writes its path; a repeat changes nothing', async () => {
    await withActorTx(h.db, ctx(), async (tx) => {
      // As before 05.11.2026: the import's alias kept no path of the file...
      await tx.execute(sql`
        DELETE FROM aliases a USING source_objects o
         WHERE o.id = a.source_object_id AND o.current_name = 'used3_2_19.09.mov'
           AND a.kind = 'legacy_path'`)
      // ...and the claim of its name waited: a claim of newer rules stands for it here.
      await tx.execute(sql`
        INSERT INTO legacy_claims (model_id, source_object_id, parser_version, claim_key,
                                   raw_fragment, claim_kind, payload, parse_work_id)
        SELECT c.model_id, c.source_object_id, 'legacy-names@2', c.claim_key, c.raw_fragment,
               c.claim_kind, c.payload, c.parse_work_id
          FROM legacy_claims c JOIN source_objects o ON o.id = c.source_object_id
         WHERE o.current_name = 'used3_2_19.09.mov' AND c.claim_kind = 'used'`)
    })
    const fyp = (await outcomeOf(POSTED_RAW))?.item as string
    const again = await withActorTx(h.db, ctx(), (tx) => claimsAgain(tx, h.modelId))
    expect(again).toEqual({ paths: 1, claims: 1, placements: 0, evidence: 1 })
    expect((await placements()).find((p) => p.item === fyp)?.evidence).toBe(3)
    const repeat = await withActorTx(h.db, ctx(), (tx) => claimsAgain(tx, h.modelId))
    expect(repeat).toEqual({ paths: 0, claims: 0, placements: 0, evidence: 0 })
  })
})

describe('what the same bytes are, by the types (SPEC §6.1 p. 1)', () => {
  it('a ready type over raw material or promo and custom ↔ PPV are two objects', () => {
    expect(duplicateOutcome('FYP', 'RAW')).toBe('own_object')
    expect(duplicateOutcome('SET', 'RAW')).toBe('own_object')
    expect(duplicateOutcome('LIFE', 'PRM')).toBe('own_object')
    expect(duplicateOutcome('PPV', 'CUS')).toBe('own_object')
    expect(duplicateOutcome('CUS', 'PPV')).toBe('own_object')
    // A custom that came after its copy is a custom, not an alias of the copy (11.11.2026).
    expect(duplicateOutcome('CUS', 'FYP')).toBe('own_object')
    expect(duplicateOutcome('CUS', 'SET')).toBe('own_object')
  })

  it('the same type, raw material, promo and a group without a type are aliases', () => {
    expect(duplicateOutcome('FYP', 'FYP')).toBe('alias')
    expect(duplicateOutcome('RAW', 'FYP')).toBe('alias')
    expect(duplicateOutcome('RAW', 'RAW')).toBe('alias')
    expect(duplicateOutcome('PRM', 'FYP')).toBe('alias')
    expect(duplicateOutcome('PRM', 'RAW')).toBe('alias')
    expect(duplicateOutcome(null, 'RAW')).toBe('alias')
    expect(duplicateOutcome('LIFE', 'SET')).toBe('alias')
  })
})
