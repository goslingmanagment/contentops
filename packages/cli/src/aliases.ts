import { BatchResultSchema } from '@contentops/contracts/domain/pagination'
import { type PlanRow, PlanWeekSchema } from '@contentops/contracts/domain/plan'
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
  /** The alias found nothing to act on: the route is not called, `report` answers alone. */
  nothing?: boolean
  /** What the alias's `report` needs besides the route's answer (rows it left out, labels). */
  note?: unknown
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
  /** What stdout gets instead of the route's answer (`null` when nothing was called). */
  report?(answer: unknown, call: RouteCall): unknown
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

/** One row of a week alias's report: the row, in short, and what happened to it. */
interface WeekOutcome {
  id: string
  row: string
  ok: boolean
  code: string | null
}

/** The rows of one page's week, in the plan's order; `--week` and `--account` are required. */
async function pageWeek(flags: AliasFlags, context: AliasContext) {
  const model = one(flags, 'model')
  const week = one(flags, 'week')
  const account = one(flags, 'account')
  const plan = PlanWeekSchema.parse(await context.read('plan.week', { model, week }))
  return { model, rows: plan.rows.filter((row) => row.account === account) }
}

/** «SET-074 · 2026-11-12 19:00 · wall» */
function rowLabel(row: PlanRow): string {
  const what = row.manifest?.item_id ?? row.awaiting_montage?.from_item ?? 'row'
  return `${what} · ${row.date}${row.time ? ` ${row.time}` : ''} · ${row.surface}`
}

/**
 * The call of a week alias: the rows it takes go to the batch route, the rest are reported with
 * the reason the plan gives; no row to take — no call.
 */
function weekCall(
  model: string,
  rows: readonly PlanRow[],
  take: (row: PlanRow) => boolean,
  skip: (row: PlanRow) => string,
  body: (rows: PlanRow[]) => unknown,
): RouteCall {
  const taken = rows.filter(take)
  const outcomes: WeekOutcome[] = rows.map((row) => ({
    id: row.id,
    row: rowLabel(row),
    ok: false,
    code: taken.includes(row) ? null : skip(row),
  }))
  return {
    flags: { model },
    body: body(taken),
    nothing: taken.length === 0,
    note: outcomes,
  }
}

/** Per row: the batch answer for the rows sent, the reason for the rows left out. */
function weekReport(answer: unknown, call: RouteCall): { rows: WeekOutcome[] } {
  const results = BatchResultSchema.safeParse(answer)
  const byId = new Map((results.success ? results.data.results : []).map((one) => [one.id, one]))
  return {
    rows: (call.note as WeekOutcome[]).map((outcome) => {
      const result = outcome.code === null ? byId.get(outcome.id) : undefined
      return result ? { ...outcome, ok: result.ok, code: result.code } : outcome
    }),
  }
}

const WEEK_FLAGS = {
  model: 'model code',
  week: 'ISO week, e.g. 2026-W46 (Monday to Sunday, Moscow)',
  account: 'page code, e.g. ari-1',
}

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
  /**
   * An agent runs a page's week (decision of the owner 11.11.2026, SPEC §7): «Подготовить» every
   * row the server takes (`hub.can_prepare`) that has no current draft yet. Per row: `ok`, or
   * why not (`hub_off`, `manual`, `pending`, `prepared`, `not_ready`, or the batch's code).
   */
  'plan.prepare-week': {
    summary: 'prepare in Hub the rows of a page’s week the server takes (per-row outcome)',
    route: 'plan.prepareMany',
    flags: WEEK_FLAGS,
    toRoute: async (flags, context) => {
      const { model, rows } = await pageWeek(flags, context)
      const current = (row: PlanRow) =>
        row.hub?.publication?.state === 'draft' && !row.hub.publication.stale
      return weekCall(
        model,
        rows,
        (row) => row.hub?.can_prepare === true && !current(row),
        (row) =>
          !row.hub
            ? 'hub_off'
            : row.hub.pending
              ? 'pending'
              : row.hub.manual
                ? 'manual'
                : current(row)
                  ? 'prepared'
                  : 'not_ready',
        (taken) => ({ row_ids: taken.map((row) => row.id) }),
      )
    },
    report: weekReport,
  },
  /**
   * The send of the same week: only the rows an agent may send now (`hub.agent_send.allowed` —
   * free posts the owner approved, the draft as approved, nothing found by Hub). Per row: `ok`,
   * or the reason of the rule (`not_approved`, `changed`, `spent`, `paid`, `kind`, `release`,
   * `hub_findings`), or `hub_off`, `pending`, `not_prepared`, `not_ready`.
   */
  'plan.send-week': {
    summary: 'send through Hub the rows of a page’s week an agent may send (per-row outcome)',
    route: 'plan.sendMany',
    flags: WEEK_FLAGS,
    toRoute: async (flags, context) => {
      const { model, rows } = await pageWeek(flags, context)
      return weekCall(
        model,
        rows,
        (row) => row.hub?.agent_send?.allowed === true && row.hub.publication !== null,
        (row) =>
          row.hub?.agent_send?.reason ??
          (!row.hub
            ? 'hub_off'
            : row.hub.pending
              ? 'pending'
              : row.hub.publication?.state === 'draft'
                ? 'not_ready'
                : 'not_prepared'),
        (taken) => ({
          rows: taken.map((row) => ({ id: row.id, version: row.hub?.publication?.version ?? 1 })),
        }),
      )
    },
    report: weekReport,
  },
}
