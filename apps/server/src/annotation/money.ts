import type { Queryable, Tx } from '@contentops/db'
import type { ProviderName } from '@contentops/vision'
import { sql } from 'drizzle-orm'
import { annotationKey, type Budget } from './settings'

/**
 * Money of the markup (SPEC §8.3 «резерв стоимости до отправки», лимиты на поставщика и
 * маршрут): a request goes only after its reserve fits the budget's window, the provider's share
 * and the route's cap, all counted under one lock, so two workers never spend the same dollar.
 * Counted: the cost of answered requests, the reserve of requests in flight, the reserve of
 * requests whose outcome is unknown (their cost is set to it).
 */

/** The lock of the billing area (`pg_advisory_xact_lock`): the whole budget is one area. */
const BILLING_LOCK = 'contentops.annotation.billing'

export interface Spent {
  total: number
  provider: number
  route: number
}

/** Dollars of the window from `since`: everything, one provider's, one route's. */
export async function spentSince(
  q: Queryable,
  since: string,
  provider: ProviderName,
  route: string,
): Promise<Spent> {
  const { rows } = await q.execute<{ total: number; provider: number; route: number }>(sql`
    WITH spent AS (
      SELECT provider, route,
             coalesce(cost_usd, CASE WHEN state = 'running' THEN reserved_usd END, 0) AS usd
        FROM annotation_runs
       WHERE created_at >= ${since}::timestamptz
    )
    SELECT coalesce(sum(usd), 0)::float8 AS total,
           coalesce(sum(usd) FILTER (WHERE provider = ${provider}), 0)::float8 AS provider,
           coalesce(sum(usd) FILTER (WHERE route = ${route}), 0)::float8 AS route
      FROM spent`)
  return rows[0] ?? { total: 0, provider: 0, route: 0 }
}

export type Reservation =
  | { ok: true }
  /** The key whose raise releases the paused work, and the reason in words. */
  | { ok: false; key: string; reason: string }

const dollars = (usd: number) => `$${usd.toFixed(2)}`

/**
 * Takes the lock and checks that `amount` fits; the caller inserts its running run in the same
 * transaction, so the reserve is counted from the moment the lock is let go.
 */
export async function reserve(
  tx: Tx,
  input: {
    budget: Budget
    provider: ProviderName
    providerLimit: number | null
    route: string
    routeKey: string | null
    routeLimit: number | null
    amount: number
  },
): Promise<Reservation> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${BILLING_LOCK}, 0))`)
  const spent = await spentSince(tx, input.budget.since, input.provider, input.route)
  if (spent.total + input.amount > input.budget.usd) {
    return {
      ok: false,
      key: annotationKey.budget,
      reason: `бюджет ${dollars(input.budget.usd)}: потрачено ${dollars(spent.total)}, на запрос нужно до ${dollars(input.amount)}`,
    }
  }
  if (input.providerLimit !== null && spent.provider + input.amount > input.providerLimit) {
    return {
      ok: false,
      key: annotationKey.limit(input.provider),
      reason: `лимит ${input.provider} ${dollars(input.providerLimit)}: потрачено ${dollars(spent.provider)}`,
    }
  }
  if (
    input.routeKey &&
    input.routeLimit !== null &&
    spent.route + input.amount > input.routeLimit
  ) {
    return {
      ok: false,
      key: input.routeKey,
      reason: `лимит маршрута ${input.route} ${dollars(input.routeLimit)}: потрачено ${dollars(spent.route)}`,
    }
  }
  return { ok: true }
}
