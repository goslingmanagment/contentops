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
}
