import { type ChildProcess, spawn } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { type IncomingMessage, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRemoteName } from './config'
import {
  assertReadCommand,
  type CloudObject,
  type CloudSpace,
  type OriginalsTransport,
  TransportError,
} from './transport'

/**
 * One long-lived `rclone rcd` owned by role `worker` (SPEC §9.4): started on the first call,
 * started again after it exits, stopped with the worker. It listens on a unix socket in a
 * private folder (0700), so `--rc-no-auth` reaches nobody but this process; `--rc-serve` streams
 * an object's bytes without a copy on our disk. The configuration (`RCLONE_CONFIG`) lies in a
 * folder of its own that rclone may write: it refreshes the OAuth tokens of Я.Диск and Dropbox
 * there. `GODEBUG=tlsmlkem=0`: the pilot's provider drops TLS handshakes with a post-quantum key
 * share (ops/README.md «Вход»), and rclone is Go.
 */

export interface RcloneOptions {
  /** `RCLONE_BIN`; default `rclone` from `PATH` (the image has it in /usr/local/bin). */
  binary: string
  /** `RCLONE_CONFIG`. */
  config: string
  log?: (line: string, error?: unknown) => void
  /** How long rclone has to answer after a start; default 20 s. */
  startTimeoutMs?: number
}

interface Daemon {
  child: ChildProcess
  dir: string
  socket: string
  exited: boolean
  /** The last lines rclone wrote, for the error of a failed start. */
  stderr: string[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fsOf(remote: string): string {
  if (!isRemoteName(remote)) throw new TransportError('refused', `${remote}: not an rclone remote`)
  return `${remote}:`
}

function relative(path: string): string {
  return path.replace(/^\/+/u, '')
}

const hex = (value: unknown): string | null =>
  typeof value === 'string' && /^[0-9a-fA-F]+$/u.test(value) ? value.toLowerCase() : null

/** An item of `operations/list` / `operations/stat` (the fields of `rclone lsjson`). */
export function cloudObject(item: Record<string, unknown>): CloudObject | null {
  if (item.IsDir === true || typeof item.Path !== 'string' || typeof item.Size !== 'number') {
    return null
  }
  const hashes = (item.Hashes ?? {}) as Record<string, unknown>
  const modTime =
    typeof item.ModTime === 'string' && !Number.isNaN(Date.parse(item.ModTime))
      ? new Date(item.ModTime).toISOString()
      : null
  return {
    path: item.Path,
    size: item.Size,
    modTime,
    id: typeof item.ID === 'string' && item.ID !== '' ? item.ID : null,
    md5: hex(hashes.md5),
    sha256: hex(hashes.sha256),
    dropbox: hex(hashes.dropbox),
  }
}

/** `/[remote:]/a/b c.mp4` with every component encoded: brackets, `#`, `%`, `?` and Cyrillic. */
export function servePath(remote: string, path: string): string {
  const parts = relative(path)
    .split('/')
    .filter((part) => part !== '')
    .map((part) => encodeURIComponent(part))
  return `/${encodeURIComponent(`[${fsOf(remote)}]`)}/${parts.join('/')}`
}

export class RcloneTransport implements OriginalsTransport {
  readonly #options: RcloneOptions
  #daemon: Daemon | null = null
  #starting: Promise<Daemon> | null = null
  #closed = false

  constructor(options: RcloneOptions) {
    this.#options = options
  }

  /** One rc command; anything but reading is refused before it is sent. */
  async call(command: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    assertReadCommand(command)
    const daemon = await this.#ensure()
    const { status, text } = await this.#post(daemon.socket, command, body, signal)
    let parsed: unknown = null
    try {
      parsed = text === '' ? {} : JSON.parse(text)
    } catch {
      throw new TransportError('failed', `${command}: rclone answered ${status} without JSON`)
    }
    if (status !== 200) {
      const error = (parsed as { error?: unknown }).error
      const message = `${command}: ${typeof error === 'string' ? error : `status ${status}`}`
      throw new TransportError(status === 404 ? 'not_found' : 'failed', message)
    }
    return parsed
  }

  async list(remote: string, path: string, signal?: AbortSignal): Promise<CloudObject[]> {
    const answer = (await this.call(
      'operations/list',
      {
        fs: fsOf(remote),
        remote: relative(path),
        opt: { recurse: true, showHash: true, filesOnly: true, noMimeType: true },
      },
      signal,
    )) as { list?: unknown }
    if (!Array.isArray(answer.list)) {
      throw new TransportError('failed', `${remote}:${path}: the listing has no list`)
    }
    const out: CloudObject[] = []
    for (const item of answer.list) {
      const object = cloudObject((item ?? {}) as Record<string, unknown>)
      if (object) out.push(object)
    }
    return out
  }

  async stat(remote: string, path: string, signal?: AbortSignal): Promise<CloudObject | null> {
    let answer: { item?: unknown }
    try {
      answer = (await this.call(
        'operations/stat',
        { fs: fsOf(remote), remote: relative(path), opt: { noMimeType: true } },
        signal,
      )) as { item?: unknown }
    } catch (error) {
      if (error instanceof TransportError && error.code === 'not_found') return null
      throw error
    }
    if (!answer.item || typeof answer.item !== 'object') return null
    return cloudObject(answer.item as Record<string, unknown>)
  }

  async open(
    remote: string,
    path: string,
    signal: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>> {
    const daemon = await this.#ensure()
    const target = servePath(remote, path)
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request({ socketPath: daemon.socket, path: target, method: 'GET', signal })
      req.once('response', resolve)
      req.once('error', reject)
      req.end()
    })
    if (response.statusCode !== 200) {
      response.resume()
      const code = response.statusCode === 404 ? 'not_found' : 'failed'
      throw new TransportError(code, `${remote}:${path}: rclone answered ${response.statusCode}`)
    }
    return response
  }

  async about(remote: string, signal?: AbortSignal): Promise<CloudSpace> {
    const answer = (await this.call('operations/about', { fs: fsOf(remote) }, signal)) as Record<
      string,
      unknown
    >
    const n = (value: unknown) => (typeof value === 'number' && value >= 0 ? value : null)
    return { total: n(answer.total), used: n(answer.used), free: n(answer.free) }
  }

  async flush(signal?: AbortSignal): Promise<void> {
    await this.call('fscache/clear', {}, signal)
  }

  async close(): Promise<void> {
    this.#closed = true
    const starting = this.#starting
    this.#starting = null
    const daemon = this.#daemon ?? (await starting?.catch(() => null)) ?? null
    this.#daemon = null
    if (daemon) await this.#kill(daemon)
    this.#closed = false
  }

  async #ensure(): Promise<Daemon> {
    if (this.#daemon && !this.#daemon.exited) return this.#daemon
    this.#daemon = null
    if (!this.#starting) {
      this.#starting = this.#start().finally(() => {
        this.#starting = null
      })
    }
    const daemon = await this.#starting
    if (this.#closed) throw new TransportError('failed', 'rclone is stopping')
    this.#daemon = daemon
    return daemon
  }

  async #start(): Promise<Daemon> {
    const { binary, config, log } = this.#options
    try {
      await access(config)
    } catch {
      throw new TransportError('failed', `RCLONE_CONFIG ${config} cannot be read`)
    }
    const dir = await mkdtemp(join(tmpdir(), 'co-rclone-'))
    const socket = join(dir, 'rc.sock')
    const child = spawn(
      binary,
      [
        'rcd',
        `--rc-addr=unix://${socket}`,
        '--rc-no-auth',
        '--rc-serve',
        // A big file at the pace of the house: the per-file timeout of the check is the guard.
        '--rc-server-write-timeout=24h',
        `--config=${config}`,
        '--log-level=NOTICE',
      ],
      {
        cwd: dir,
        env: { ...process.env, RCLONE_CONFIG: config, GODEBUG: 'tlsmlkem=0' },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
    const daemon: Daemon = { child, dir, socket, exited: false, stderr: [] }
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() === '') continue
        daemon.stderr = [...daemon.stderr.slice(-19), line]
        log?.(`rclone: ${line}`)
      }
    })
    child.once('exit', (code, signal) => {
      daemon.exited = true
      log?.(`rclone rcd exited (${signal ?? code})`)
      void rm(dir, { recursive: true, force: true })
    })
    child.once('error', (error) => {
      daemon.exited = true
      daemon.stderr.push(String(error))
    })
    const deadline = Date.now() + (this.#options.startTimeoutMs ?? 20_000)
    for (;;) {
      if (daemon.exited) {
        throw new TransportError('failed', `rclone rcd did not start: ${daemon.stderr.join(' | ')}`)
      }
      try {
        const { status } = await this.#post(socket, 'core/version', {})
        if (status === 200) return daemon
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) {
        await this.#kill(daemon)
        throw new TransportError('failed', 'rclone rcd did not answer in time')
      }
      await sleep(200)
    }
  }

  async #kill(daemon: Daemon): Promise<void> {
    if (!daemon.exited) {
      const gone = new Promise<void>((resolve) => daemon.child.once('exit', () => resolve()))
      daemon.child.kill('SIGTERM')
      const timer = setTimeout(() => daemon.child.kill('SIGKILL'), 5_000)
      await gone
      clearTimeout(timer)
    }
    await rm(daemon.dir, { recursive: true, force: true })
  }

  #post(
    socket: string,
    command: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; text: string }> {
    const payload = JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: socket,
          path: `/${command}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
          ...(signal ? { signal } : {}),
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.once('end', () =>
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
          )
          res.once('error', reject)
        },
      )
      req.once('error', reject)
      req.end(payload)
    })
  }
}
