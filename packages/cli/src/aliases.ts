import { orderAddress, parseTelegramRef } from '@contentops/contracts/order-link'
import { UsageError } from './args'
import type { RouteKey } from './table'

/**
 * Friendly commands on top of the route table. `contentops <area> <name>` of an alias
 * calls `route` with the flags `toRoute` computes from the alias's own flags; global
 * options (`--json`, `--wait`, `--body`, `--if-match`, `--idempotency-key`) work as usual.
 * Keys are `area.name` and never repeat a route of the table (checked by a test).
 */

/** Flags as typed: every flag may repeat, so each has a list of values. */
export type AliasFlags = Record<string, string[]>

/** What an alias turns into: flags of its route (path params, query keys) and the body. */
export interface RouteCall {
  flags: Record<string, string | readonly string[]>
  /** JSON body of the call; leave it out to take `--body` from the command line. */
  body?: unknown
}

export interface AliasContext {
  /** A read (GET) of any route before the call, e.g. to find an ID; flags as in `RouteCall`. */
  read(route: RouteKey, flags: RouteCall['flags']): Promise<unknown>
}

export interface Alias {
  /** One line for `contentops routes` and `--help`. */
  summary: string
  /** The route the alias calls. */
  route: RouteKey
  /** The alias's own flags: name → help line. Any other flag is a usage error. */
  flags: Record<string, string>
  /** Throw `UsageError` for input it cannot use. */
  toRoute(flags: AliasFlags, context: AliasContext): RouteCall | Promise<RouteCall>
}

/** The single value of a required flag. */
export function one(flags: AliasFlags, name: string): string {
  const value = optional(flags, name)
  if (value === undefined) throw new UsageError(`--${name} is required`)
  return value
}

/** The single value of a flag, or `undefined` when it is not given. */
export function optional(flags: AliasFlags, name: string): string | undefined {
  const values = flags[name] ?? []
  if (values.length > 1) throw new UsageError(`--${name} is given more than once`)
  return values[0]
}

export { UsageError }

export const aliases: Record<string, Alias> = {
  /** A link someone pasted from the interface → the object: `…/#/lora/i/PPV-073`. */
  'objects.open': {
    summary: 'an object by its link from the interface (…/#/lora/i/PPV-073)',
    route: 'objects.get',
    flags: { link: 'link to the object page in the interface' },
    toRoute: (flags) => {
      const link = one(flags, 'link')
      const match = /\/([a-z0-9-]+)\/i\/([^/?#]+)/.exec(link)
      if (!match) throw new UsageError(`--link is not a link to an object page: ${link}`)
      return { flags: { model: match[1] as string, id: decodeURIComponent(match[2] as string) } }
    },
  },
  /**
   * The routine `customs-daily` (SPEC §8.2): the order of a Telegram card by the card's link,
   * in any spelling (`https://t.me/c/…`, `tg:<chat>/<topic>/<message>`). 404 — no order yet.
   */
  'orders.find': {
    summary: 'an order by the link to its Telegram card (exit 1 with not_found: no order yet)',
    route: 'orders.get',
    flags: { model: 'model code', tg: 'link to the order card in Telegram' },
    toRoute: (flags) => {
      const link = one(flags, 'tg')
      const ref = parseTelegramRef(link)
      if (!ref) throw new UsageError(`--tg is not a link to a Telegram message: ${link}`)
      return { flags: { model: one(flags, 'model'), order: orderAddress(ref) } }
    },
  },
  /**
   * The dry run of the legacy import (PLAN этап 3 `import plan`): the parse of the latest frozen
   * snapshot, nothing written but the report in the operation. `--wait` prints it.
   */
  'import.plan': {
    summary: 'dry run of the legacy import over the latest snapshot (report in the operation)',
    route: 'legacy.plan',
    flags: {
      model: 'model code',
      snapshot: 'work id of a finished snapshot (default: the latest)',
    },
    toRoute: (flags) => {
      const snapshot = optional(flags, 'snapshot')
      return { flags: { model: one(flags, 'model'), ...(snapshot ? { snapshot } : {}) } }
    },
  },
  /** The metadata pass of stage 3 (SPEC §6.3): claims, number claims, cases, the reserve. */
  'import.parse': {
    summary: 'metadata pass of the legacy import: claims, number claims, cases, number reserve',
    route: 'legacy.parse',
    flags: {
      model: 'model code',
      snapshot: 'work id of a finished snapshot (default: the latest)',
    },
    toRoute: (flags) => {
      const snapshot = optional(flags, 'snapshot')
      return { flags: { model: one(flags, 'model'), ...(snapshot ? { snapshot } : {}) } }
    },
  },
  /**
   * The bytes of the old corpus root by root (SPEC §6.3): `--root "1. PPV"` (can repeat),
   * `--folder` for one folder; groups without a dispute are accepted by the import itself.
   */
  'import.bytes': {
    summary: 'bytes of the old corpus for roots (or one folder) through ordinary intake',
    route: 'legacy.bytes',
    flags: {
      model: 'model code',
      root: 'top folder of the old disk, e.g. "1. PPV" (can repeat)',
      folder: 'one folder inside the roots (optional)',
      snapshot: 'work id of a finished snapshot (default: the latest)',
      force: '"true" to go out of the order of SPEC §6.3',
    },
    toRoute: (flags) => {
      const roots = flags.root ?? []
      if (roots.length === 0) throw new UsageError('--root is required')
      const folder = optional(flags, 'folder')
      const snapshot = optional(flags, 'snapshot')
      const force = optional(flags, 'force')
      return {
        flags: {
          model: one(flags, 'model'),
          root: roots,
          ...(folder ? { folder } : {}),
          ...(snapshot ? { snapshot } : {}),
          ...(force ? { force } : {}),
        },
      }
    },
  },
  /** The reconciliation with the snapshot (SPEC §6.3), the exit artifact of stage 3. */
  'import.reconcile': {
    summary: 'reconciliation of the import with the snapshot (report in the operation)',
    route: 'legacy.reconcile',
    flags: {
      model: 'model code',
      snapshot: 'work id of a finished snapshot (default: the latest)',
    },
    toRoute: (flags) => {
      const snapshot = optional(flags, 'snapshot')
      return { flags: { model: one(flags, 'model'), ...(snapshot ? { snapshot } : {}) } }
    },
  },
}
