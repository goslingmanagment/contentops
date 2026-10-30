import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { beforeAll, describe, expect, inject, it } from 'vitest'
import { sha256File } from './files.ts'
import { createMaster, type MasterResult, masterRecipe } from './master.ts'
import { probeVideo } from './probe.ts'
import type { FixtureName } from './testing/fixtures.ts'
import { FIXTURE_TAGS } from './testing/fixtures.ts'
import { freshDir, listFiles, processesMentioning, toolVersions } from './testing/helpers.ts'
import { MediaAbortError, type ToolVersions } from './tools.ts'

const fx = inject('fixtures')
let versions: ToolVersions

beforeAll(async () => {
  versions = await toolVersions()
})

async function master(name: FixtureName, extra: { webUpload?: boolean } = {}) {
  const source = fx.files[name]
  const before = await sha256File(source)
  const outDir = await freshDir(name)
  const result = await createMaster({ source, outDir, versions, lp: 4, ...extra })
  expect(await sha256File(source), 'the source is never modified').toBe(before)
  expect(result.sourceSha256).toBe(before)
  return { result, outDir, left: await listFiles(outDir) }
}

function expectSourceIsMaster(result: MasterResult, left: string[]) {
  expect(result.acceptance).toBe('master_is_source')
  expect(result.masterIsSource).toBe(true)
  expect(result.masterPath).toBeNull()
  expect(result.masterSha256).toBe(result.sourceSha256)
  expect(left).toEqual([])
}

describe('canonical master — encode', () => {
  it('VFR with 120 fps inserts, two AAC tracks and QuickTime keys → ok', async () => {
    const { result, left } = await master('vfr120')
    expect(result).toMatchObject({
      decision: 'encode',
      verdict: 'ok',
      acceptance: 'master_encoded',
      masterIsSource: false,
      crf: 24,
      srcFrames: 90,
      dstFrames: 90,
    })
    expect(result.recipeDigest).toBe(masterRecipe(versions, 4).digest)
    const path = result.masterPath as string
    expect(left).toEqual([basename(path)])
    expect(basename(path).startsWith('.master-')).toBe(true)
    expect(await sha256File(path)).toBe(result.masterSha256)
    expect(result.masterBytes).toBe((await stat(path)).size)
    expect(result.masterBytes).toBeLessThan(result.sourceBytes)
    expect(result.report.timing).toMatchObject({ comparable: true, drifted: 0 })
    expect(result.report.audio).toHaveLength(2)
    for (const a of result.report.audio) {
      expect(a.resultSha256).toBe(a.sourceSha256)
      expect(Math.abs((a.sourceOffsetMs ?? 0) - (a.resultOffsetMs ?? 0))).toBeLessThanOrEqual(2)
    }
    expect(result.report.metadata).toEqual({ missing: [], changed: [], display: null })

    const out = await probeVideo(path)
    expect(out.video).toMatchObject({ codec: 'av1', pixFmt: 'yuv420p10le' })
    expect(out.audio.map((a) => a.codec)).toEqual(['aac', 'aac'])
    expect(out.tags['com.apple.quicktime.make']).toBe(FIXTURE_TAGS.make)
    expect(out.tags['com.apple.quicktime.creationdate']).toBe(FIXTURE_TAGS.creationDate)
    expect(new Date(out.tags.creation_time as string).toISOString()).toBe(
      '2024-01-02T03:04:05.000Z',
    )
    const [m, src] = await Promise.all([stat(path), stat(fx.files.vfr120)])
    expect(Math.abs(m.mtimeMs - src.mtimeMs)).toBeLessThan(1)
  })

  it('constant 120 fps → ok, every frame time within 1 ms', async () => {
    const { result } = await master('fps120')
    expect(result).toMatchObject({ verdict: 'ok', srcFrames: 120, dstFrames: 120 })
    expect(result.report.timing?.maxDriftMs).toBeLessThanOrEqual(1)
  })

  it('portrait by display matrix → ok, shown the same size', async () => {
    const { result } = await master('vertical')
    expect(result.verdict).toBe('ok')
    const out = await probeVideo(result.masterPath as string)
    expect([out.video.displayWidth, out.video.displayHeight]).toEqual([720, 1280])
  })

  it('drops an apac track with a note and copies the AAC one', async () => {
    const { result } = await master('apac')
    expect(result).toMatchObject({ decision: 'encode', verdict: 'ok' })
    expect(result.report.droppedAudio.map((a) => a.audioIndex)).toEqual([1])
    expect(result.report.notes.join()).toContain('apple_apac')
    const out = await probeVideo(result.masterPath as string)
    expect(out.audio).toHaveLength(1)
  })

  it('a bigger result is discarded and the source is the master', async () => {
    const { result, left } = await master('bigger')
    expect(result).toMatchObject({ decision: 'encode', verdict: 'bigger_than_source' })
    expect(result.report.ratio).toBeGreaterThan(1)
    expectSourceIsMaster(result, left)
  })
})

describe('canonical master — kept as is', () => {
  it.each([
    ['hdr4k60', 'skipped_hdr'],
    ['lowrate', 'skipped_lowrate'],
    ['av1', 'skipped_av1'],
    ['apacOnly', 'skipped_audio'],
    ['adpcm', 'skipped_audio'],
  ] as const)('%s → %s, verified by a full decode', async (name, decision) => {
    const { result, left } = await master(name)
    expect(result).toMatchObject({ decision, verdict: 'ok', crf: null })
    expect(result.report.sourceCheck?.verdict).toBe('ok')
    expectSourceIsMaster(result, left)
  })

  it('a web upload is the master (copy)', async () => {
    const { result, left } = await master('vfr120', { webUpload: true })
    expect(result).toMatchObject({ decision: 'copy', verdict: 'ok' })
    expectSourceIsMaster(result, left)
  })
})

describe('canonical master — broken sources', () => {
  it('truncated → source_truncated, accept as is only', async () => {
    const { result, left } = await master('truncated')
    expect(result.verdict).toBe('source_truncated')
    expect(result.acceptance).toBe('accept_as_is_only')
    expect(result.masterSha256).toBeNull()
    expect(left).toEqual([])
  })

  it('damaged → source_decode_errors, accept as is only', async () => {
    const { result, left } = await master('corrupt')
    expect(result.verdict).toBe('source_decode_errors')
    expect(result.acceptance).toBe('accept_as_is_only')
    expect(result.report.sourceErrors.count).toBeGreaterThan(0)
    expect(left).toEqual([])
  })

  it('unreadable → no decision, waits for a replacement', async () => {
    const { result, left } = await master('unreadable')
    expect(result).toMatchObject({
      decision: null,
      verdict: 'unreadable',
      acceptance: 'wait_replacement',
      masterSha256: null,
      probe: null,
    })
    expect(left).toEqual([])
  })
})

describe('canonical master — abort', () => {
  it('kills the encoder and leaves no files', async () => {
    const outDir = await freshDir('abort')
    const controller = new AbortController()
    const run = createMaster({
      source: fx.files.vfr120,
      outDir,
      versions,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === 'encode') controller.abort()
      },
    })
    await expect(run).rejects.toBeInstanceOf(MediaAbortError)
    expect(await listFiles(outDir)).toEqual([])
    expect(await processesMentioning(outDir)).toEqual([])
  })
})
