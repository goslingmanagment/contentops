import { access, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'

/** A check of `/healthz`, sync or async: throwing or giving `false` makes it red. */
export type HealthCheck = () => unknown

const CHECK_TIMEOUT_MS = 3000

/** Same answer as `mountpoint -q`: another device than the parent, or the root itself. */
export async function isMountpoint(path: string): Promise<boolean> {
  const target = resolve(path)
  try {
    const [self, parent] = await Promise.all([stat(target), stat(dirname(target))])
    return self.dev !== parent.dev || self.ino === parent.ino
  } catch {
    return false
  }
}

/** SPEC §12.2: while disk E: is not mounted in the VM, `/healthz` is red. */
export function mountsCheck(paths: readonly string[]): HealthCheck {
  return async () => {
    const mounted = await Promise.all(paths.map(isMountpoint))
    return mounted.every(Boolean)
  }
}

/**
 * File that `ops/up.sh` leaves in a storage root once `mountpoint -q` passed on the host.
 * Without the disk the root is an empty immutable directory of the system disk (ops/README),
 * so the mark is missing; inside a container this is the only honest check.
 */
export const VOLUME_MARK = '.contentops-volume'

export async function hasVolumeMark(path: string): Promise<boolean> {
  try {
    await access(join(path, VOLUME_MARK))
    return true
  } catch {
    return false
  }
}

/** Paths of `REQUIRE_VOLUMES` without the mark. */
export async function missingVolumes(paths: readonly string[]): Promise<string[]> {
  const marked = await Promise.all(paths.map(hasVolumeMark))
  return paths.filter((_, index) => !marked[index])
}

export function volumesCheck(paths: readonly string[]): HealthCheck {
  return async () => (await missingVolumes(paths)).length === 0
}

async function passes(check: HealthCheck): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((done) => {
    timer = setTimeout(() => done(false), CHECK_TIMEOUT_MS)
  })
  try {
    return (await Promise.race([Promise.resolve().then(check), timeout])) !== false
  } finally {
    clearTimeout(timer)
  }
}

/** `GET /healthz`: 200 `{ok: true}` when every check passes, else 503 with the failed names. */
export function registerHealth(app: FastifyInstance, checks: Record<string, HealthCheck>): void {
  app.get('/healthz', { schema: { hide: true } }, async (request, reply) => {
    const names = Object.keys(checks)
    const results = await Promise.all(
      names.map(async (name) => {
        try {
          return await passes(checks[name] as HealthCheck)
        } catch (error) {
          request.log.warn({ err: error, check: name }, 'health check failed')
          return false
        }
      }),
    )
    const failed = names.filter((_, index) => !results[index])
    if (failed.length === 0) return { ok: true }
    request.log.warn({ failed }, 'healthz red')
    return reply.code(503).send({ ok: false, failed })
  })
}
