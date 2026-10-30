import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import sharp from 'sharp'

/**
 * Tool runner (SPEC §12.0 «Видео»): FFmpeg and ffprobe run as subprocesses with argument
 * arrays, never through a shell. Each run gets its own process group so an abort kills the
 * whole tree; stderr is streamed line by line and only its tail is kept.
 */

export interface ToolPaths {
  ffmpeg: string
  ffprobe: string
}

export function toolPaths(env: NodeJS.ProcessEnv = process.env): ToolPaths {
  return { ffmpeg: env.FFMPEG_PATH || 'ffmpeg', ffprobe: env.FFPROBE_PATH || 'ffprobe' }
}

/** Thrown when an AbortSignal stops a run; partial outputs are already removed. */
export class MediaAbortError extends Error {
  override name = 'AbortError'
  constructor(message = 'media operation aborted') {
    super(message)
  }
}

export class ToolError extends Error {
  override name = 'ToolError'
  readonly tool: string
  readonly code: number | null
  readonly stderrTail: string
  constructor(message: string, tool: string, code: number | null, stderrTail: string) {
    super(message)
    this.tool = tool
    this.code = code
    this.stderrTail = stderrTail
  }
}

export interface RunOptions {
  signal?: AbortSignal
  /** nice(1) increment; workers run below `web` (SPEC §12.0 «Производительность»). */
  niceness?: number
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
  /** Collect stdout as one string (ffprobe JSON). Off by default. */
  captureStdout?: boolean
  /** How much of stderr to keep for reports. */
  stderrTailBytes?: number
  /** SIGTERM → SIGKILL grace on abort. */
  killGraceMs?: number
  /** Called with the child pid (also its process group id). */
  onSpawn?: (pid: number) => void
}

export interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderrTail: string
  durationMs: number
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaAbortError()
}

/** After an abort every rejection (a hash stream's DOM AbortError too) is a MediaAbortError. */
export function abortAware(error: unknown, signal: AbortSignal | undefined): unknown {
  return signal?.aborted && !(error instanceof MediaAbortError) ? new MediaAbortError() : error
}

export function runTool(
  file: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const { signal, niceness = 0 } = options
  if (signal?.aborted) return Promise.reject(new MediaAbortError())
  const [command, argv] =
    niceness > 0 ? ['nice', ['-n', String(niceness), file, ...args]] : [file, [...args]]
  const tailLimit = options.stderrTailBytes ?? 64 * 1024
  const started = performance.now()

  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    if (child.pid !== undefined) options.onSpawn?.(child.pid)
    let stdout = ''
    let stderrTail = ''
    let aborted = false
    let killTimer: NodeJS.Timeout | undefined

    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, sig)
      } catch {
        // already gone
      }
    }
    const onAbort = () => {
      aborted = true
      killGroup('SIGTERM')
      killTimer = setTimeout(() => killGroup('SIGKILL'), options.killGraceMs ?? 3000)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const stdoutLines = lineSplitter(options.onStdoutLine)
    const stderrLines = lineSplitter(options.onStderrLine)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (options.captureStdout) stdout += chunk
      stdoutLines.push(chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      stderrTail += chunk
      if (stderrTail.length > tailLimit * 2) stderrTail = stderrTail.slice(-tailLimit)
      stderrLines.push(chunk)
    })

    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(killTimer)
      reject(new ToolError(`cannot run ${file}: ${error.message}`, file, null, ''))
    })
    child.on('close', (code, sig) => {
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(killTimer)
      stdoutLines.end()
      stderrLines.end()
      if (aborted) {
        reject(new MediaAbortError())
        return
      }
      resolve({
        code,
        signal: sig,
        stdout,
        stderrTail: stderrTail.slice(-tailLimit),
        durationMs: Math.round(performance.now() - started),
      })
    })
  })
}

/** Runs a tool and throws {@link ToolError} on a non-zero exit. */
export async function runToolChecked(
  file: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const result = await runTool(file, args, options)
  if (result.code !== 0) {
    const last = result.stderrTail.trim().split('\n').slice(-5).join('\n')
    throw new ToolError(`${file} exited with ${result.code}: ${last}`, file, result.code, last)
  }
  return result
}

function lineSplitter(onLine: ((line: string) => void) | undefined) {
  let rest = ''
  return {
    push(chunk: string) {
      if (!onLine) return
      rest += chunk
      const parts = rest.split(/\r?\n|\r/)
      rest = parts.pop() ?? ''
      for (const line of parts) onLine(line)
    },
    end() {
      if (onLine && rest) onLine(rest)
      rest = ''
    },
  }
}

export interface FfmpegProgress {
  /** 0…1 when the duration is known. */
  fraction: number | null
  outTimeMs: number
  frame: number | null
  speed: number | null
}

/**
 * Parser for `-progress pipe:1` key=value blocks; feed it stdout lines.
 * `durationMs` is the expected output duration.
 */
export function progressParser(
  durationMs: number | null,
  onProgress: ((progress: FfmpegProgress) => void) | undefined,
): (line: string) => void {
  let frame: number | null = null
  let outTimeMs = 0
  let speed: number | null = null
  return (line) => {
    const eq = line.indexOf('=')
    if (eq < 0) return
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1).trim()
    if (key === 'frame') frame = Number(value)
    else if (key === 'out_time_us' && value !== 'N/A') outTimeMs = Math.max(0, Number(value) / 1000)
    else if (key === 'speed') speed = Number.parseFloat(value) || null
    else if (key === 'progress' && onProgress) {
      const fraction =
        value === 'end'
          ? 1
          : durationMs && durationMs > 0
            ? Math.min(1, outTimeMs / durationMs)
            : null
      onProgress({ fraction, outTimeMs: Math.round(outTimeMs), frame, speed })
    }
  }
}

/** Version strings that go into `pipeline_versions` and every recipe digest. */
export interface ToolVersions {
  /** `ffmpeg -version` build id, e.g. `n8.1.2-50-g1a748fe2cd-20260831`. */
  ffmpeg: string
  ffprobe: string
  /** Version of the SVT-AV1 library linked into FFmpeg, e.g. `v4.2.0-73-gfb0ed7e59`. */
  svtav1: string
  libvips: string
  sharp: string
  libheif: string | null
  libde265: string | null
  libwebp: string | null
  /** Perceptual hash implementation, `sharp-phash@<version>`. */
  phash: string
}

/**
 * Versions the product image pins (Dockerfile). The media tests compare against them in
 * the image (`CONTENTOPS_MEDIA_STRICT=1`); a new build changes them only after the A/B on
 * the frozen corpus (SPEC §12.0).
 */
export const PINNED_TOOLS = {
  ffmpegPrefix: 'n8.1.2-50-g1a748fe2cd-',
  svtav1: 'v4.2.0-73-gfb0ed7e59',
  libvips: '8.16.1',
  sharp: '0.34.2',
} as const

const require = createRequire(import.meta.url)

export async function detectToolVersions(
  options: { paths?: ToolPaths; packagesFile?: string; signal?: AbortSignal } = {},
): Promise<ToolVersions> {
  const paths = options.paths ?? toolPaths()
  const [ffmpeg, ffprobe, svtav1, packages] = await Promise.all([
    banner(paths.ffmpeg, options.signal),
    banner(paths.ffprobe, options.signal),
    svtVersion(paths.ffmpeg, options.signal),
    readPackages(options.packagesFile ?? process.env.CONTENTOPS_PACKAGES_FILE),
  ])
  const sv = sharp.versions as Record<string, string | undefined>
  return {
    ffmpeg,
    ffprobe,
    svtav1,
    libvips: sv.vips ?? 'unknown',
    sharp: sv.sharp ?? packageVersion('sharp'),
    libheif: packages.libheif1 ?? sv.heif ?? null,
    libde265: packages['libde265-0'] ?? null,
    libwebp: packages.libwebp7 ?? sv.webp ?? null,
    phash: `sharp-phash@${packageVersion('sharp-phash')}`,
  }
}

async function banner(file: string, signal: AbortSignal | undefined): Promise<string> {
  const { stdout } = await runToolChecked(file, ['-hide_banner', '-version'], {
    captureStdout: true,
    signal,
  })
  const match = /^\S+ version (\S+)/.exec(stdout)
  if (!match?.[1]) throw new ToolError(`cannot read the version of ${file}`, file, 0, stdout)
  return match[1]
}

/** One tiny frame makes FFmpeg print the SVT-AV1 library version (as the benchmark did). */
async function svtVersion(ffmpeg: string, signal: AbortSignal | undefined): Promise<string> {
  let version: string | undefined
  await runToolChecked(
    ffmpeg,
    [
      '-nostdin',
      '-hide_banner',
      '-f',
      'lavfi',
      '-i',
      'color=s=64x64:r=1',
      '-frames:v',
      '1',
      '-c:v',
      'libsvtav1',
      '-preset',
      '8',
      '-svtav1-params',
      'lp=1',
      '-pix_fmt',
      'yuv420p10le',
      '-f',
      'null',
      '-',
    ],
    {
      signal,
      onStderrLine: (line) => {
        const match = /SVT \[version\]:\s*SVT-AV1 Encoder Lib (\S+)/.exec(line)
        if (match?.[1]) version = match[1]
      },
    },
  )
  if (!version) throw new ToolError('cannot read the SVT-AV1 version', ffmpeg, 0, '')
  return version
}

async function readPackages(file: string | undefined): Promise<Record<string, string>> {
  if (!file) return {}
  try {
    const text = await readFile(file, 'utf8')
    const out: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
    return out
  } catch {
    return {}
  }
}

function packageVersion(name: string): string {
  return (require(`${name}/package.json`) as { version: string }).version
}
