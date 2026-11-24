import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRemoteName } from './config'
import {
  assertReadCommand,
  assertWrite,
  assertWritePath,
  type CloudObject,
  type CloudSpace,
  type OriginalsTransport,
  type RemoteKind,
  TransportError,
  type UploadSource,
  WRITE_COMMANDS,
} from './transport'

/**
 * One long-lived `rclone rcd` owned by role `worker` (SPEC §9.4): started on the first call,
 * started again after it exits, stopped with the worker. It listens on a unix socket in a
 * private folder (0700), so `--rc-no-auth` reaches nobody but this process; `--rc-serve` streams
 * an object's bytes without a copy on our disk. The configuration (`RCLONE_CONFIG`) lies in a
 * folder of its own that rclone may write: it refreshes the OAuth tokens of Я.Диск and Dropbox
 * there. `GODEBUG=tlsmlkem=0`: the pilot's provider drops TLS handshakes with a post-quantum key
 * share (ops/README.md «Вход»), and rclone is Go. `--bwlimit` is the day and night timetable of
 * `ORIGINALS_BWLIMIT`, in Moscow time (`TZ=Europe/Moscow` for rclone alone). MEGA is reached by
 * plain HTTP, rclone's default: uploads over HTTPS from the pilot's provider do not go.
 *
 * A write (`upload`) never spools the bytes on our disk: rclone pulls them from a one-time
 * address of this process (`:http` remote on 127.0.0.1, a random token per feed) with their
 * size, so MEGA, which takes no stream of unknown length, gets a plain upload. Every byte rclone
 * reads passes through the source the caller gave (`UploadSource`), which hashes it; a read from
 * the middle (`Range`) is refused, so a broken read starts again from the first byte. Every
 * write is fenced by `assertWrite` with the remote's rclone type before it is sent.
 */

export interface RcloneOptions {
  /** `RCLONE_BIN`; default `rclone` from `PATH` (the image has it in /usr/local/bin). */
  binary: string
  /** `RCLONE_CONFIG`. */
  config: string
  log?: (line: string, error?: unknown) => void
  /** How long rclone has to answer after a start; default 20 s. */
  startTimeoutMs?: number
  /** `ORIGINALS_BWLIMIT`: rclone's `--bwlimit` timetable, Moscow time; none — no limit. */
  bwlimit?: string
}

interface Feed {
  source: UploadSource
  /** Aborts the read in progress when the write is given up. */
  signal: AbortSignal
  /** A read failed or the write ended: no more bytes from this feed. */
  closed: boolean
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

/**
 * `operations/list` gives `Path` from the remote's root, the listed folder included
 * (`originals/lora/yadisk/x` for the folder `originals/lora`), while `list` promises paths
 * relative to the folder that was listed: the folder's own prefix goes.
 */
export function listedPath(path: string, folder: string): string {
  const base = folder.replace(/\/+$/u, '')
  if (base === '') return path
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path
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
  readonly #kinds = new Map<string, RemoteKind>()
  readonly #feeds = new Map<string, Feed>()
  #server: Server | null = null
  #serverUrl: string | null = null

  constructor(options: RcloneOptions) {
    this.#options = options
  }

  /** One rc command; anything but reading is refused before it is sent. */
  async call(command: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    assertReadCommand(command)
    return this.#send(command, body, signal)
  }

  async #send(command: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
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
      if (object) out.push({ ...object, path: listedPath(object.path, relative(path)) })
    }
    return out
  }

  async stat(remote: string, path: string, signal?: AbortSignal): Promise<CloudObject | null> {
    let answer: { item?: unknown }
    try {
      answer = (await this.call(
        'operations/stat',
        // The hashes the cloud keeps (Dropbox, Я.Диск) come with the object, nothing is read.
        { fs: fsOf(remote), remote: relative(path), opt: { noMimeType: true, showHash: true } },
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
    this.#kinds.clear()
  }

  async kind(remote: string, signal?: AbortSignal): Promise<RemoteKind> {
    if (!isRemoteName(remote)) return null
    const known = this.#kinds.get(remote)
    if (known !== undefined) return known
    let answer: Record<string, unknown>
    try {
      answer = (await this.call('config/get', { name: remote }, signal)) as Record<string, unknown>
    } catch (error) {
      if (error instanceof TransportError && error.code === 'not_found') return null
      throw error
    }
    // Only the type is kept: the rest of the section holds tokens.
    const kind = typeof answer.type === 'string' && answer.type !== '' ? answer.type : null
    this.#kinds.set(remote, kind)
    return kind
  }

  /** A write command, sent only after the fence passed for every path it touches. */
  async #write(command: string, body: Record<string, unknown>, signal?: AbortSignal) {
    if (!WRITE_COMMANDS.has(command)) {
      throw new TransportError('refused', `${command}: not a writing command of ContentOps`)
    }
    return this.#send(command, body, signal)
  }

  async #fenced(remote: string, op: 'upload' | 'move' | 'remove', ...paths: string[]) {
    for (const path of paths) assertWritePath(op, path)
    if (!isRemoteName(remote))
      throw new TransportError('refused', `${remote}: not an rclone remote`)
    const kind = await this.kind(remote)
    for (const path of paths) assertWrite(kind, op, path)
  }

  async upload(
    remote: string,
    path: string,
    source: UploadSource,
    signal: AbortSignal,
  ): Promise<CloudObject> {
    await this.#fenced(remote, 'upload', path)
    const base = await this.#feedServer()
    const token = randomBytes(24).toString('hex')
    const feed: Feed = { source, signal, closed: false }
    this.#feeds.set(token, feed)
    try {
      await this.#write(
        'operations/copyfile',
        {
          srcFs: `:http,url='${base}':`,
          srcRemote: token,
          dstFs: fsOf(remote),
          dstRemote: relative(path),
          // Our own checks decide (`copy.ts`): rclone neither skips by what lies there nor
          // removes what it uploaded when it finds the sizes or the hashes different.
          _config: { NoCheckDest: true, IgnoreChecksum: true, IgnoreSize: true },
        },
        signal,
      )
    } finally {
      feed.closed = true
      this.#feeds.delete(token)
    }
    const object = await this.stat(remote, path, signal)
    if (!object) throw new TransportError('failed', `${remote}:${path}: not there after the upload`)
    return object
  }

  async move(remote: string, from: string, to: string, signal?: AbortSignal): Promise<CloudObject> {
    await this.#fenced(remote, 'move', from, to)
    if (await this.stat(remote, to, signal)) {
      throw new TransportError(
        'exists',
        `${remote}:${to}: something is there, nothing is overwritten`,
      )
    }
    await this.#write(
      'operations/movefile',
      {
        srcFs: fsOf(remote),
        srcRemote: relative(from),
        dstFs: fsOf(remote),
        dstRemote: relative(to),
      },
      signal,
    )
    const object = await this.stat(remote, to, signal)
    if (!object) throw new TransportError('failed', `${remote}:${to}: not there after the move`)
    return object
  }

  async removePart(remote: string, path: string, signal?: AbortSignal): Promise<void> {
    await this.#fenced(remote, 'remove', path)
    try {
      await this.#write(
        'operations/deletefile',
        { fs: fsOf(remote), remote: relative(path) },
        signal,
      )
    } catch (error) {
      if (error instanceof TransportError && error.code === 'not_found') return
      throw error
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    const starting = this.#starting
    this.#starting = null
    const daemon = this.#daemon ?? (await starting?.catch(() => null)) ?? null
    this.#daemon = null
    if (daemon) await this.#kill(daemon)
    const server = this.#server
    this.#server = null
    this.#serverUrl = null
    for (const feed of this.#feeds.values()) feed.closed = true
    this.#feeds.clear()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    this.#closed = false
  }

  /** The address rclone reads the feeds from: `http://127.0.0.1:<port>/`. */
  async #feedServer(): Promise<string> {
    if (this.#serverUrl) return this.#serverUrl
    const server = createServer((req, res) => {
      this.#serve(req, res).catch((error: unknown) => {
        this.#options.log?.('originals: a feed broke', error)
        res.destroy()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const { port } = server.address() as AddressInfo
    this.#server = server
    this.#serverUrl = `http://127.0.0.1:${port}/`
    return this.#serverUrl
  }

  async #serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = (req.url ?? '').replace(/^\/+/u, '')
    const feed = this.#feeds.get(token)
    if (!feed || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end()
      return
    }
    if (feed.closed || feed.signal.aborted) {
      res.writeHead(410).end()
      return
    }
    // The bytes are hashed from the first one: a read from the middle starts again.
    if (req.headers.range !== undefined) {
      res.writeHead(416).end()
      return
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(feed.source.size),
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const controller = new AbortController()
    const stop = () => controller.abort(feed.signal.reason)
    feed.signal.addEventListener('abort', stop, { once: true })
    res.once('close', () => controller.abort(new Error('rclone stopped reading')))
    try {
      const body = await feed.source.open(controller.signal)
      for await (const chunk of body) {
        if (controller.signal.aborted) throw controller.signal.reason
        if (!res.write(chunk)) {
          await new Promise<void>((resolve) => {
            const done = () => {
              res.off('drain', done)
              res.off('close', done)
              controller.signal.removeEventListener('abort', done)
              resolve()
            }
            res.once('drain', done)
            res.once('close', done)
            controller.signal.addEventListener('abort', done, { once: true })
          })
        }
      }
      res.end()
    } catch {
      // The source refused its bytes or broke: rclone sees a short read, nothing lands, and the
      // feed gives nothing more.
      feed.closed = true
      res.destroy()
    } finally {
      feed.signal.removeEventListener('abort', stop)
    }
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
        ...(this.#options.bwlimit ? [`--bwlimit=${this.#options.bwlimit}`] : []),
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          RCLONE_CONFIG: config,
          GODEBUG: 'tlsmlkem=0',
          // The timetable of --bwlimit is in rclone's local time: Moscow, as on the PC.
          TZ: 'Europe/Moscow',
        },
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
      this.#kinds.clear()
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
