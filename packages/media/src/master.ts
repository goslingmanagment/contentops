import { stat } from 'node:fs/promises'
import { copyMtime, removeQuietly, sha256File, tempPathIn } from './files.ts'
import {
  type AudioTrack,
  type FfprobeJson,
  parseFfprobe,
  probeVideo,
  UnreadableMediaError,
  type VideoProbe,
} from './probe.ts'
import { type DigestedRecipe, digested, recipe } from './recipe.ts'
import {
  abortAware,
  detectToolVersions,
  progressParser,
  runTool,
  type ToolPaths,
  type ToolVersions,
  throwIfAborted,
  toolPaths,
} from './tools.ts'
import {
  audioOffsetsMs,
  audioPacketHashes,
  checkSource,
  decodeFramePts,
  encodeLogParser,
  errorLog,
  type PtsDrift,
  ptsDrift,
  type SourceCheck,
  type SourceVerdict,
  shownFramesPromised,
  truncated,
} from './verify.ts'

/**
 * Canonical master (SPEC §9.2, schema §9.2 `master_checks`). One profile for everything
 * that is re-encoded; HDR, AV1, sources under 8 Mbit/s and web uploads stay as they are.
 */
export const MASTER_PROFILE = {
  encoder: 'libsvtav1',
  crf: 24,
  preset: 6,
  pixFmt: 'yuv420p10le',
  gop: 300,
  /** `lp` is inserted from `SVTAV1_LP` in the benchmark's order: tune, lp, qm. */
  svtParams: ['tune=1', 'enable-qm=1', 'qm-min=0', 'qm-max=15'],
  fpsMode: 'passthrough',
  encTimeBase: '1/1000000',
  videoTrackTimescale: 600000,
  /**
   * `+faststart` as in the benchmark; `use_metadata_tags` keeps QuickTime `mdta` keys
   * (make, model, creation date with zone, location), which the plain MP4 muxer drops.
   */
  movflags: '+faststart+use_metadata_tags',
  minBitrate: 8_000_000,
  /** Copied bit for bit into MP4 (the benchmark's list). */
  copyableAudio: ['aac', 'ac3', 'eac3', 'alac', 'mp3', 'opus', 'flac', 'pcm_s16le', 'pcm_s24le'],
  ptsToleranceMs: 1,
  audioStartToleranceMs: 2,
  minDecodedShare: 0.95,
  /** Bump when the checks below change meaning. */
  verifier: 1,
} as const

export type MasterDecision =
  | 'encode'
  | 'copy'
  | 'skipped_hdr'
  | 'skipped_av1'
  | 'skipped_lowrate'
  | 'skipped_audio'

/** `master_checks.verdict` (schema §9.2); `publish_failed` is the caller's (rename failed). */
export const MASTER_VERDICTS = [
  'ok',
  'unreadable',
  'bigger_than_source',
  'timing_drift',
  'timing_uncomparable',
  'audio_mismatch',
  'audio_offset',
  'audio_tracks_lost',
  'encode_failed',
  'frame_mismatch',
  'result_decode_errors',
  'publish_failed',
  'source_decode_errors',
  'source_truncated',
  'metadata_mismatch',
] as const
export type MasterVerdict = (typeof MASTER_VERDICTS)[number]

/**
 * What the draft may do with the result (schema §9.2 «Принятие», owner 30.10.2026):
 * the encoded master; the source as master; only «Принять как есть» by the KM; wait for a
 * replacement.
 */
export type MasterAcceptance =
  | 'master_encoded'
  | 'master_is_source'
  | 'accept_as_is_only'
  | 'wait_replacement'

export interface MasterPlan {
  decision: MasterDecision
  /** Audio streams copied into the master. */
  keepAudio: AudioTrack[]
  /** `apple_apac` streams dropped from the master, with a note. */
  dropAudio: AudioTrack[]
  notes: string[]
}

export function planMaster(probe: VideoProbe, options: { webUpload?: boolean } = {}): MasterPlan {
  const plan = (decision: MasterDecision, ...notes: string[]): MasterPlan => ({
    decision,
    keepAudio: [],
    dropAudio: [],
    notes,
  })
  if (options.webUpload) return plan('copy', 'web upload: the uploaded bytes are the master')
  if (probe.video.isHdr) {
    return plan('skipped_hdr', `HDR (${probe.video.colorTransfer ?? 'Dolby Vision'})`)
  }
  if (probe.video.codec === 'av1') return plan('skipped_av1', 'already AV1')
  if (probe.bitRate < MASTER_PROFILE.minBitrate) {
    return plan('skipped_lowrate', `${(probe.bitRate / 1e6).toFixed(3)} Mbit/s is below 8 Mbit/s`)
  }
  const copyable = new Set<string>(MASTER_PROFILE.copyableAudio)
  const apac = probe.audio.filter((a) => a.applePositional)
  const other = probe.audio.filter((a) => !a.applePositional && !copyable.has(a.codec))
  const keep = probe.audio.filter((a) => !a.applePositional && copyable.has(a.codec))
  if (other.length > 0) {
    return plan(
      'skipped_audio',
      `audio that MP4 cannot copy: ${other.map((a) => `a:${a.audioIndex} ${a.codec}`).join(', ')}`,
    )
  }
  if (apac.length > 0 && keep.length === 0) {
    return plan('skipped_audio', 'the only audio is apple_apac')
  }
  return {
    decision: 'encode',
    keepAudio: keep,
    dropAudio: apac,
    notes: apac.map((a) => `dropped a:${a.audioIndex} apple_apac (MP4 cannot carry it)`),
  }
}

/** Creation date for the master: the source's `creation_time` or, failing that, its mtime. */
export function masterCreationTime(tags: Record<string, string>, mtime: Date): string {
  // The formats compress-library.sh accepts; anything else (two dates joined by `;`) → mtime.
  const raw = tags.creation_time?.trim() ?? ''
  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?$/.exec(raw)
  if (iso) return `${iso[1]}T${iso[2]}Z`
  const ampm = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}:\d{2}) ([AP])MZ$/.exec(raw)
  if (ampm) {
    const hour = (Number(ampm[2]) % 12) + (ampm[4] === 'P' ? 12 : 0)
    return `${ampm[1]}T${String(hour).padStart(2, '0')}:${ampm[3]}Z`
  }
  return `${mtime.toISOString().slice(0, 19)}Z`
}

export function masterEncodeArgs(
  input: string,
  output: string,
  plan: MasterPlan,
  options: { lp: number; creationTime: string },
): string[] {
  const p = MASTER_PROFILE
  const [tune, ...qm] = p.svtParams
  return [
    '-nostdin',
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'level+info',
    '-progress',
    'pipe:1',
    '-y',
    '-i',
    input,
    '-map',
    '0:v:0',
    ...plan.keepAudio.flatMap((a) => ['-map', `0:a:${a.audioIndex}`]),
    '-c:a',
    'copy',
    '-map_metadata',
    '0',
    '-fps_mode',
    p.fpsMode,
    '-enc_time_base:v',
    p.encTimeBase,
    '-filter:v',
    'showinfo',
    '-c:v',
    p.encoder,
    '-preset',
    String(p.preset),
    '-crf',
    String(p.crf),
    '-pix_fmt',
    p.pixFmt,
    '-g',
    String(p.gop),
    '-svtav1-params',
    [tune, `lp=${options.lp}`, ...qm].join(':'),
    '-metadata',
    `creation_time=${options.creationTime}`,
    // QuickTime brands are not metadata; with use_metadata_tags they would become keys.
    '-metadata',
    'major_brand=',
    '-metadata',
    'minor_version=',
    '-metadata',
    'compatible_brands=',
    '-video_track_timescale',
    String(p.videoTrackTimescale),
    '-movflags',
    p.movflags,
    '-f',
    'mp4',
    output,
  ]
}

export function masterRecipe(versions: ToolVersions, lp: number): DigestedRecipe {
  return digested(
    recipe(
      'master',
      'video',
      {
        ...MASTER_PROFILE,
        svtParams: [...MASTER_PROFILE.svtParams],
        copyableAudio: [...MASTER_PROFILE.copyableAudio],
        lp,
      },
      versions,
      ['ffmpeg', 'ffprobe', 'svtav1'],
    ),
  )
}

export function defaultLp(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SVTAV1_LP)
  return Number.isInteger(n) && n > 0 ? n : 4
}

export interface MasterProgress {
  phase: 'encode' | 'verify' | 'source'
  fraction: number | null
}

export interface MasterOptions {
  source: string
  /**
   * Directory for the encoded file: the directory (and filesystem) of its final location.
   * The verified file stays there under a dot-prefixed temp name; renaming it is the
   * caller's job.
   */
  outDir: string
  /** Web upload by the KM: the uploaded bytes are the master (decision `copy`). */
  webUpload?: boolean
  /** Known SHA-256 of the source (computed while fetching); hashed here otherwise. */
  sourceSha256?: string
  /** SVT-AV1 `lp`, default `SVTAV1_LP` or 4. */
  lp?: number
  niceness?: number
  signal?: AbortSignal
  onProgress?: (progress: MasterProgress) => void
  paths?: ToolPaths
  versions?: ToolVersions
}

export interface MasterReport {
  notes: string[]
  droppedAudio: { audioIndex: number; codec: string; codecTag: string }[]
  promisedFrames: number | null
  sourceErrors: { count: number; lines: string[] }
  encoderErrors: { count: number; lines: string[] }
  resultErrors: { count: number; lines: string[] }
  timing: PtsDrift | null
  audio: {
    audioIndex: number
    sourceSha256: string | null
    resultSha256: string | null
    sourceOffsetMs: number | null
    resultOffsetMs: number | null
  }[]
  metadata: { missing: string[]; changed: string[]; display: string | null } | null
  ratio: number | null
  sourceCheck: {
    verdict: SourceVerdict
    frames: number | null
    errors: { count: number; lines: string[] }
    undecodableAudio: number[]
  } | null
  exitCode: number | null
  stderrTail: string | null
}

export interface MasterResult {
  /** Null only when the source cannot be probed (`unreadable`): no rule applies. */
  decision: MasterDecision | null
  verdict: MasterVerdict
  acceptance: MasterAcceptance
  masterIsSource: boolean
  /** Verified encoded file inside `outDir`, to be renamed by the caller; null otherwise. */
  masterPath: string | null
  masterSha256: string | null
  sourceSha256: string
  sourceBytes: number
  masterBytes: number | null
  crf: number | null
  encMs: number | null
  verifyMs: number
  srcFrames: number | null
  dstFrames: number | null
  recipeDigest: string
  recipe: DigestedRecipe['recipe']
  probe: VideoProbe | null
  report: MasterReport
}

/** Highest first: the first failing check names the verdict. */
const PRECEDENCE: readonly MasterVerdict[] = [
  'encode_failed',
  'result_decode_errors',
  'source_truncated',
  'source_decode_errors',
  'audio_offset',
  'audio_mismatch',
  'timing_uncomparable',
  'timing_drift',
  'audio_tracks_lost',
  'frame_mismatch',
  'metadata_mismatch',
  'bigger_than_source',
]

/** Tags that belong to the container writer, not to the material. */
const WRITER_TAGS = new Set(['major_brand', 'minor_version', 'compatible_brands', 'encoder'])

export function compareMetadata(
  source: VideoProbe,
  result: VideoProbe,
  creationTime: string,
): { missing: string[]; changed: string[]; display: string | null } {
  const missing: string[] = []
  const changed: string[] = []
  for (const [key, value] of Object.entries(source.tags)) {
    if (WRITER_TAGS.has(key) || key === 'creation_time') continue
    if (!(key in result.tags)) missing.push(key)
    else if (result.tags[key] !== value) changed.push(key)
  }
  const ct = result.tags.creation_time
  if (!ct || new Date(ct).getTime() !== new Date(creationTime).getTime())
    changed.push('creation_time')
  const s = source.video
  const r = result.video
  const display =
    s.displayWidth === r.displayWidth && s.displayHeight === r.displayHeight
      ? null
      : `${s.displayWidth}x${s.displayHeight} → ${r.displayWidth}x${r.displayHeight}`
  return { missing, changed, display }
}

export async function createMaster(options: MasterOptions): Promise<MasterResult> {
  const paths = options.paths ?? toolPaths()
  const signal = options.signal
  const lp = options.lp ?? defaultLp()
  const versions = options.versions ?? (await detectToolVersions({ paths, signal }))
  const masterRecipeDigested = masterRecipe(versions, lp)
  const sourceInfo = await stat(options.source)
  const sourceShaPromise = options.sourceSha256
    ? Promise.resolve(options.sourceSha256)
    : sha256File(options.source, signal)
  sourceShaPromise.catch(() => undefined)

  const base = {
    sourceBytes: sourceInfo.size,
    recipeDigest: masterRecipeDigested.digest,
    recipe: masterRecipeDigested.recipe,
  }
  const emptyReport = (notes: string[] = []): MasterReport => ({
    notes,
    droppedAudio: [],
    promisedFrames: null,
    sourceErrors: { count: 0, lines: [] },
    encoderErrors: { count: 0, lines: [] },
    resultErrors: { count: 0, lines: [] },
    timing: null,
    audio: [],
    metadata: null,
    ratio: null,
    sourceCheck: null,
    exitCode: null,
    stderrTail: null,
  })

  let probe: VideoProbe
  const probeStarted = performance.now()
  try {
    probe = await probeVideo(options.source, { paths, signal })
  } catch (error) {
    if (!(error instanceof UnreadableMediaError)) throw error
    const report = emptyReport([error.message])
    report.stderrTail = error.stderr || null
    return {
      ...base,
      decision: options.webUpload ? 'copy' : null,
      verdict: 'unreadable',
      acceptance: 'wait_replacement',
      masterIsSource: false,
      masterPath: null,
      masterSha256: null,
      sourceSha256: await sourceShaPromise,
      masterBytes: null,
      crf: null,
      encMs: null,
      verifyMs: Math.round(performance.now() - probeStarted),
      srcFrames: null,
      dstFrames: null,
      probe: null,
      report,
    }
  }

  const plan = planMaster(probe, { webUpload: options.webUpload })
  const report = emptyReport([...plan.notes])
  report.promisedFrames = probe.video.nbFrames
  report.droppedAudio = plan.dropAudio.map((a) => ({
    audioIndex: a.audioIndex,
    codec: a.codec,
    codecTag: a.codecTag,
  }))

  const sourceAsMaster = async (
    verdict: MasterVerdict | null,
    check: SourceCheck,
    extra: Partial<MasterResult>,
  ): Promise<MasterResult> => {
    report.sourceCheck = {
      verdict: check.verdict,
      frames: check.frames,
      errors: { count: check.errors.count, lines: check.errors.lines },
      undecodableAudio: check.undecodableAudio,
    }
    for (const i of check.undecodableAudio)
      report.notes.push(`a:${i} cannot be decoded, not checked`)
    const acceptance: MasterAcceptance =
      check.verdict === 'ok'
        ? 'master_is_source'
        : check.verdict === 'unreadable'
          ? 'wait_replacement'
          : 'accept_as_is_only'
    const sourceSha256 = await sourceShaPromise
    return {
      ...base,
      decision: plan.decision,
      verdict: verdict ?? check.verdict,
      acceptance,
      masterIsSource: acceptance === 'master_is_source',
      masterPath: null,
      masterSha256: acceptance === 'master_is_source' ? sourceSha256 : null,
      sourceSha256,
      masterBytes: acceptance === 'master_is_source' ? sourceInfo.size : null,
      crf: null,
      encMs: null,
      verifyMs: check.durationMs,
      srcFrames: check.frames,
      dstFrames: null,
      probe,
      report,
      ...extra,
    }
  }

  if (plan.decision !== 'encode') {
    const check = await checkSource(paths, options.source, probe, {
      signal,
      niceness: options.niceness,
      onProgress: (fraction) => options.onProgress?.({ phase: 'source', fraction }),
    })
    return sourceAsMaster(null, check, {})
  }

  // ---- encode ----
  const creationTime = masterCreationTime(probe.tags, sourceInfo.mtime)
  const tmp = tempPathIn(options.outDir, 'master', '.mp4')
  const srcPts: number[] = []
  const sourceErrors = errorLog()
  const encoderErrors = errorLog()
  let encMs: number
  let code: number | null
  let stderrTail: string
  const encodeStarted = performance.now()
  try {
    const run = await runTool(
      paths.ffmpeg,
      masterEncodeArgs(options.source, tmp, plan, { lp, creationTime }),
      {
        signal,
        niceness: options.niceness,
        onStdoutLine: progressParser(probe.durationMs, (p) =>
          options.onProgress?.({ phase: 'encode', fraction: p.fraction }),
        ),
        onStderrLine: encodeLogParser({
          onFrame: (t) => srcPts.push(t),
          source: sourceErrors,
          encoder: encoderErrors,
        }),
      },
    )
    code = run.code
    stderrTail = run.stderrTail
    encMs = Math.round(performance.now() - encodeStarted)
  } catch (error) {
    await removeQuietly(tmp)
    throw abortAware(error, signal)
  }
  report.sourceErrors = { count: sourceErrors.count, lines: sourceErrors.lines }
  report.encoderErrors = { count: encoderErrors.count, lines: encoderErrors.lines }
  report.exitCode = code
  const srcFrames = srcPts.length

  const outSize = await stat(tmp).then(
    (s) => s.size,
    () => 0,
  )
  if (code !== 0 || outSize === 0) {
    await removeQuietly(tmp)
    report.stderrTail = stderrTail.slice(-4000)
    // The encode pass stopped early, so the source is checked on its own.
    const check = await checkSource(paths, options.source, probe, {
      signal,
      niceness: options.niceness,
      onProgress: (fraction) => options.onProgress?.({ phase: 'source', fraction }),
    })
    return sourceAsMaster('encode_failed', check, { encMs, crf: MASTER_PROFILE.crf, srcFrames })
  }

  try {
    throwIfAborted(signal)
    await copyMtime(options.source, tmp)
    const verifyStarted = performance.now()
    const keep = plan.keepAudio.map((a) => a.audioIndex)
    const [decoded, masterSha256, srcHashes, dstHashes, srcOffsets, dstOffsets, resultProbe] =
      await Promise.all([
        decodeFramePts(paths, tmp, {
          signal,
          niceness: options.niceness,
          onFrame: (n) =>
            options.onProgress?.({
              phase: 'verify',
              fraction: srcFrames ? Math.min(1, n / srcFrames) : null,
            }),
        }),
        sha256File(tmp, signal),
        audioPacketHashes(paths, options.source, keep, { signal }),
        audioPacketHashes(paths, tmp, 'all', { signal }),
        audioOffsetsMs(paths, options.source, keep, signal),
        audioOffsetsMs(
          paths,
          tmp,
          keep.map((_, i) => i),
          signal,
        ),
        probeResult(paths, tmp, outSize, signal),
      ])
    const verifyMs = Math.round(performance.now() - verifyStarted)
    const dstFrames = decoded.pts.length
    report.resultErrors = { count: decoded.errors.count, lines: decoded.errors.lines }
    if (decoded.code !== 0 && decoded.errors.count === 0) {
      report.resultErrors = { count: 1, lines: [`ffprobe exited with ${decoded.code}`] }
    }

    const failed = new Set<MasterVerdict>()
    if (encoderErrors.lines.some((l) => /^Svt\[error\]/.test(l))) failed.add('encode_failed')
    if (report.resultErrors.count > 0) failed.add('result_decode_errors')
    report.promisedFrames = await shownFramesPromised(
      paths,
      options.source,
      probe.video.nbFrames,
      srcFrames,
      signal,
    )
    if (truncated(srcFrames, report.promisedFrames)) failed.add('source_truncated')
    if (sourceErrors.count > 0) failed.add('source_decode_errors')
    if (srcFrames !== dstFrames) failed.add('frame_mismatch')
    else {
      const drift = ptsDrift(srcPts, decoded.pts, MASTER_PROFILE.ptsToleranceMs)
      report.timing = drift
      if (!drift.comparable) failed.add('timing_uncomparable')
      else if (drift.drifted > 0) failed.add('timing_drift')
    }
    const resultAudio = resultProbe?.audio.length ?? 0
    if (resultAudio !== keep.length || dstHashes.length !== keep.length) {
      failed.add('audio_tracks_lost')
    }
    report.audio = keep.map((audioIndex, i) => ({
      audioIndex,
      sourceSha256: srcHashes[i] ?? null,
      resultSha256: dstHashes[i] ?? null,
      sourceOffsetMs: srcOffsets[i] ?? null,
      resultOffsetMs: dstOffsets[i] ?? null,
    }))
    for (const a of report.audio) {
      if (!a.sourceSha256 || a.sourceSha256 !== a.resultSha256) failed.add('audio_mismatch')
      else if (
        a.sourceOffsetMs !== null &&
        a.resultOffsetMs !== null &&
        Math.abs(a.sourceOffsetMs - a.resultOffsetMs) > MASTER_PROFILE.audioStartToleranceMs
      ) {
        failed.add('audio_offset')
      }
    }
    if (resultProbe) {
      report.metadata = compareMetadata(probe, resultProbe, creationTime)
      const m = report.metadata
      if (m.missing.length || m.changed.length || m.display) failed.add('metadata_mismatch')
    } else {
      failed.add('result_decode_errors')
    }
    report.ratio = Math.round((outSize / sourceInfo.size) * 1000) / 1000
    if (outSize >= sourceInfo.size) failed.add('bigger_than_source')

    const verdict = PRECEDENCE.find((v) => failed.has(v)) ?? 'ok'
    const common = {
      crf: MASTER_PROFILE.crf,
      encMs,
      srcFrames,
      dstFrames,
    }
    if (verdict === 'ok') {
      return {
        ...base,
        ...common,
        decision: 'encode',
        verdict,
        acceptance: 'master_encoded',
        masterIsSource: false,
        masterPath: tmp,
        masterSha256,
        sourceSha256: await sourceShaPromise,
        masterBytes: outSize,
        verifyMs,
        probe,
        report,
      }
    }
    await removeQuietly(tmp)
    if (verdict === 'source_truncated' || verdict === 'source_decode_errors') {
      // The encode pass decoded the whole source and found it broken.
      return {
        ...base,
        ...common,
        decision: 'encode',
        verdict,
        acceptance: 'accept_as_is_only',
        masterIsSource: false,
        masterPath: null,
        masterSha256: null,
        sourceSha256: await sourceShaPromise,
        masterBytes: null,
        verifyMs,
        probe,
        report,
      }
    }
    // Encode failure or bigger result: the source is the master (owner 30.10.2026) once its
    // audio decodes too; its video was decoded cleanly by the encode pass.
    const check = await checkSource(paths, options.source, probe, {
      decodeVideo: false,
      signal,
      niceness: options.niceness,
    })
    return sourceAsMaster(
      verdict,
      { ...check, frames: srcFrames },
      {
        ...common,
        verifyMs: verifyMs + check.durationMs,
      },
    )
  } catch (error) {
    await removeQuietly(tmp)
    throw abortAware(error, signal)
  }
}

async function probeResult(
  paths: ToolPaths,
  file: string,
  size: number,
  signal: AbortSignal | undefined,
): Promise<VideoProbe | null> {
  const run = await runTool(
    paths.ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { captureStdout: true, signal },
  )
  if (run.code !== 0) return null
  try {
    return parseFfprobe(JSON.parse(run.stdout) as FfprobeJson, size)
  } catch {
    return null
  }
}
