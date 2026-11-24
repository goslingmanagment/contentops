/**
 * What the check and the copy of the originals share (SPEC §9.4): the cut of a stalled stream and
 * several streams in one run.
 *
 * MEGA drops a stream to ~100 KiB/s now and then while the others go on (the PC's nightly copy,
 * 24.11.2026: 1 stream ≈ 2 MiB/s, 10 streams ≈ 7 MiB/s), so a run keeps `ORIGINALS_STREAMS`
 * streams going, each with its own cut: no bytes for `idleMs`, or not done in
 * `baseMs + size / minBytesPerSec`.
 */

export const DEFAULT_STREAMS = 8

export interface StreamLimits {
  /** No bytes for this long — the stream is stalled; default 2 min. */
  idleMs: number
  /** A file may take `baseMs + size / minBytesPerSec`; default 10 min and 256 KiB/s. */
  baseMs: number
  minBytesPerSec: number
}

export const DEFAULT_LIMITS: StreamLimits = {
  idleMs: 2 * 60_000,
  baseMs: 10 * 60_000,
  minBytesPerSec: 256 * 1024,
}

export class Stalled extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Stalled'
  }
}

/**
 * The cut of one stream of `size` bytes: `signal` aborts with `Stalled` when no `tick()` came for
 * `idleMs` or the whole took too long, and with the parent's reason when the run is stopped.
 */
export class StreamWatch {
  readonly #controller = new AbortController()
  readonly #parent: AbortSignal
  readonly #limits: StreamLimits
  readonly #stop: () => void
  #idle: NodeJS.Timeout | undefined
  readonly #deadline: NodeJS.Timeout

  constructor(size: number, limits: StreamLimits, parent: AbortSignal) {
    this.#parent = parent
    this.#limits = limits
    this.#stop = () => this.#controller.abort(parent.reason)
    parent.addEventListener('abort', this.#stop, { once: true })
    const limitMs = limits.baseMs + (size / limits.minBytesPerSec) * 1000
    this.#deadline = setTimeout(
      () => this.#controller.abort(new Stalled(`not done in ${Math.round(limitMs / 60_000)} min`)),
      limitMs,
    )
    this.tick()
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  /** Bytes moved: the idle cut starts again. */
  tick(): void {
    clearTimeout(this.#idle)
    if (this.#controller.signal.aborted) return
    this.#idle = setTimeout(
      () =>
        this.#controller.abort(
          new Stalled(`no bytes for ${Math.round(this.#limits.idleMs / 1000)} s`),
        ),
      this.#limits.idleMs,
    )
  }

  /** Why the stream was cut for slowness; null — it was not (or the run itself stopped). */
  get stalled(): string | null {
    const reason: unknown = this.#controller.signal.reason
    return !this.#parent.aborted && reason instanceof Stalled ? reason.message : null
  }

  stop(): void {
    clearTimeout(this.#idle)
    clearTimeout(this.#deadline)
    this.#parent.removeEventListener('abort', this.#stop)
  }
}

export interface LaneOptions<T, R> {
  /** Items going at once; at least 1. */
  streams: number
  signal: AbortSignal
  /** Why no more items are taken (asked before each, sticky once given); null — go on. */
  stop: () => string | null
  /** One item; it does not throw but when the run is stopped. */
  run: (item: T) => Promise<R>
  /** After each item, one at a time, in the order they end. */
  done: (item: T, result: R) => Promise<void>
}

/**
 * Takes `items` in their order, `streams` at a time: the order is the order they start in. When
 * `stop` gives a reason, nothing more is started and the ones going end on their own. Returns
 * that reason, or null when every item went.
 */
export async function lanes<T, R>(
  items: readonly T[],
  options: LaneOptions<T, R>,
): Promise<string | null> {
  let next = 0
  let stopped: string | null = null
  let failed = false
  let chain: Promise<void> = Promise.resolve()
  const lane = async (): Promise<void> => {
    for (;;) {
      if (options.signal.aborted || failed) return
      stopped ??= options.stop()
      if (stopped !== null || next >= items.length) return
      const item = items[next] as T
      next += 1
      try {
        const result = await options.run(item)
        const finished = chain.then(() => options.done(item, result))
        chain = finished.catch(() => {})
        await finished
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  const count = Math.max(1, Math.min(options.streams, items.length))
  const settled = await Promise.allSettled(Array.from({ length: count }, lane))
  if (options.signal.aborted) throw options.signal.reason
  const rejected = settled.find((result) => result.status === 'rejected')
  if (rejected) throw rejected.reason
  return stopped
}
