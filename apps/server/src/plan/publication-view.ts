import type { Integration } from '@contentops/contracts/domain/integrations'
import type { PlacementLevel, PlacementVerdict } from '@contentops/contracts/domain/placement'
import type { PlanHub, PublicationState, RowPublication } from '@contentops/contracts/domain/plan'
import { formatStamp, pastVerb } from '@contentops/contracts/format'
import {
  PUBLICATION_STATE_WORD,
  publicationCheck,
  publicationReasonText,
  publicationVerdict,
} from '@contentops/contracts/publication'
import type { Queryable } from '@contentops/db'
import { canCancel, publicationRowState } from '@contentops/hub'
import { sql } from 'drizzle-orm'
import { instantOrNull } from '../commands'
import { kindRule, replaceable } from '../hub/publish-rules'
import { actorRef, type RowRecord } from './records'
import type { PlanState } from './state'

/**
 * The Hub part of a plan row (SPEC §7 «Публикация через Hub», DESIGN §4.11, §5.2): whether the
 * page publishes through Hub, the publication's state and Hub's checks, the work under way and
 * what may be done; and the row's verdict once the publication went to Hub.
 */

export interface PublishContext {
  /** Hub set up for the page and its «Публикация» on, by account code. */
  enabled: ReadonlyMap<string, boolean>
  /** «Hub · статусы на 18:32», by account id. */
  statusesAt: ReadonlyMap<string, string | null>
  /** The latest Hub work of each row. */
  works: ReadonlyMap<string, RowWork>
}

interface RowWork {
  op: 'prepare' | 'send' | 'cancel'
  state: string
  paused: boolean
  error: string | null
}

export async function publishContext(
  q: Queryable,
  state: PlanState,
  integrations: readonly Integration[],
): Promise<PublishContext> {
  const enabled = new Map<string, boolean>()
  for (const integration of integrations) {
    if (integration.kind !== 'hub' || !integration.account) continue
    if (integration.model !== state.model.code) continue
    enabled.set(
      integration.account,
      integration.state !== 'unset' && integration.switches.publish === true,
    )
  }
  const { rows: polls } = await q.execute<{ account_id: string; at: string | null }>(sql`
    SELECT account_id, last_success_at::text AS at FROM hub_sync_state
     WHERE model_id = ${state.model.id}::uuid AND dataset = 'publications' AND scope = 'page'`)
  const { rows: works } = await q.execute<{
    scope: string
    dataset: RowWork['op']
    state: string
    paused_reason: string | null
    error_text: string | null
  }>(sql`
    SELECT DISTINCT ON (scope) scope, dataset, state, paused_reason, error_text
      FROM work_operations
     WHERE model_id = ${state.model.id}::uuid AND kind = 'hub_publish' AND scope LIKE 'row:%'
     ORDER BY scope, created_at DESC`)
  return {
    enabled,
    statusesAt: new Map(polls.map((row) => [row.account_id, instantOrNull(row.at)])),
    works: new Map(
      works.map((row) => [
        row.scope.slice('row:'.length),
        {
          op: row.dataset,
          state: row.state,
          paused: row.paused_reason !== null,
          error: row.error_text,
        },
      ]),
    ),
  }
}

const OPEN = new Set(['pending', 'running', 'retry_wait'])

function stateText(state: PlanState, row: RowRecord, publication: PublicationState): string {
  const now = state.now
  const page = state.view.accounts.find((account) => account.code === row.account)
  const when = (at: string | null) => (at ? formatStamp(at, now) : '')
  switch (publication) {
    case 'draft': {
      const by = actorRef(state.people, row.hub_prepared_by)
      const who = row.hub_prepared_by
        ? `${pastVerb('Подготовил', by.gender)} ${by.name}`
        : 'Подготовлено'
      return `${who} ${when(row.hub_prepared_at)} · черновик в Hub`
    }
    case 'sent': {
      const by = actorRef(state.people, row.hub_sent_by)
      return `${pastVerb('Отправил', by.gender)} ${by.name} ${when(row.hub_sent_at)} · Hub поставит в расписание за 7 дней до выхода`
    }
    case 'scheduled':
      return `Hub поставил в расписание ${page?.label ?? row.account} на ${when(row.slot_at)}`
    case 'published':
      return row.vault_album_ref
        ? `Альбом vault ${when(row.hub_status_at)} · публикация Hub → альбом`
        : `Пост ${when(row.hub_status_at)} · публикация Hub → пост`
    case 'not_published':
      return `Hub: ${publicationReasonText(row.hub_status ?? '', row.hub_status_reason)}`
    case 'unverified':
      return 'Hub не смог проверить выход; решение — у владельца в Hub'
    case 'cancelled':
      return 'Публикация отменена — строку можно подготовить заново или выложить руками'
  }
}

function publicationOf(state: PlanState, row: RowRecord): RowPublication | null {
  if (row.hub_publication_id === null || !row.hub_kind || !row.hub_status) return null
  const current = publicationRowState(row.hub_status)
  const checks = (row.hub_checks?.findings ?? []).map(publicationCheck)
  return {
    id: row.hub_publication_id,
    version: row.hub_version ?? 1,
    kind: row.hub_kind,
    state: current,
    hub_status: row.hub_status,
    text: stateText(state, row, current),
    publish_at: row.slot_at,
    checks: current === 'draft' ? checks : [],
    blocked: current === 'draft' && (row.hub_checks?.blocked ?? false),
    stale:
      current === 'draft' &&
      row.hub_prepared_version !== null &&
      row.row_version > row.hub_prepared_version,
    files: row.hub_files.map((file) => ({
      name: file.name,
      source: file.vault_media_ref ? ('vault' as const) : ('upload' as const),
    })),
    prepared: {
      at: row.hub_prepared_at ?? row.created_at,
      by: actorRef(state.people, row.hub_prepared_by),
    },
    sent: row.hub_sent_at
      ? { at: row.hub_sent_at, by: actorRef(state.people, row.hub_sent_by) }
      : null,
    post_ref: row.platform_post_ref,
    album_ref: row.vault_album_ref,
  }
}

/**
 * Rows that already went out: an exact (Hub) or a person's confirmation of their placement —
 * there is nothing to prepare or send (DESIGN §4.11: «кнопок нет»).
 */
const CONFIRMED_LEVELS: ReadonlySet<PlacementLevel> = new Set<PlacementLevel>([
  'confirmed_exact',
  'confirmed_hub_unmarked',
  'confirmed_manual',
  'confirmed_earlier',
  'confirmed_reupload',
])

export function isConfirmedLevel(level: PlacementLevel): boolean {
  return CONFIRMED_LEVELS.has(level)
}

/**
 * The Hub part of the row; `null` — the page publishes by hand and the row never went to Hub.
 * `level` is the row's own verdict: a row already confirmed offers neither «Подготовить» nor
 * «Отправить».
 */
export function hubView(
  context: PublishContext,
  state: PlanState,
  row: RowRecord,
  level?: PlacementLevel,
): PlanHub | null {
  const enabled = context.enabled.get(row.account) ?? false
  const publication = publicationOf(state, row)
  const work = context.works.get(row.id)
  const pending = work && OPEN.has(work.state) ? work.op : null
  if (!enabled && !publication && !pending) return null
  const price = row.price_mills === null ? null : Number(row.price_mills)
  const rule = kindRule(row.platform, row.surface, price)
  const manual =
    rule.manual ??
    (row.slot_time === null
      ? 'У строки нет времени: Hub публикует ко времени — задайте время или выложите руками'
      : null)
  const error =
    work && OPEN.has(work.state) && work.paused
      ? 'Публикация через Hub выключена для страницы — работа ждёт включения'
      : work?.state === 'failed' || work?.state === 'cancelled'
        ? (work.error ?? 'Не получилось')
        : null
  const open =
    !row.cancelled_at &&
    !row.marked_at &&
    row.manifest_id !== null &&
    (level === undefined || !isConfirmedLevel(level))
  const free = enabled && pending === null
  return {
    enabled,
    manual,
    publication,
    pending,
    error,
    statuses_at: context.statusesAt.get(row.account_id) ?? null,
    can_prepare: free && open && manual === null && replaceable(row.hub_status),
    can_send:
      free && open && publication?.state === 'draft' && !publication.blocked && !publication.stale,
    can_cancel: free && publication !== null && canCancel(publication.hub_status),
  }
}

/** The row's verdict once its publication went to Hub: the link is exact, nothing is matched. */
export function rowVerdict(base: PlacementVerdict, hub: PlanHub | null): PlacementVerdict {
  const publication = hub?.publication
  if (!publication) return base
  return (
    publicationVerdict(base, {
      state: publication.state,
      text: publication.text,
      date: null,
    }) ?? base
  )
}

export { PUBLICATION_STATE_WORD }
