import { isoWeekOf, weekDates, weekdayIndex } from '@contentops/contracts/clock'
import type { DownloadKind } from '@contentops/contracts/commands/objects'
import type { AccountCode, IsoWeek, LocalDate, Sign } from '@contentops/contracts/domain/common'
import type { Integration, IntegrationLine } from '@contentops/contracts/domain/integrations'
import type { SurfaceKind } from '@contentops/contracts/domain/placement'
import type {
  NormKind,
  PlanDay,
  PlanRow,
  PlanWeek,
  Release,
  SlotGap,
  WeekNorm,
} from '@contentops/contracts/domain/plan'
import type { Delivery, DeliveryOptions } from '@contentops/contracts/download-files'
import { formatDuration } from '@contentops/contracts/format'
import { describeIntegration } from '@contentops/contracts/integration-line'
import { isPlacedLevel, markButtonKind } from '@contentops/contracts/placement'
import { vaultAlbumName } from '@contentops/contracts/vault-album'
import {
  accountOf,
  evaluateRow,
  evaluateTrack,
  type FactsContext,
  hubCoverage,
} from '../fixtures/facts'
import { actorOf } from '../fixtures/people'
import type { ItemRecord, PlanRowRecord, ReleaseRecord } from '../fixtures/world-types'
import { recordDelivery, rowOptions } from './delivery'
import { planWarnings, slotOrder } from './plan-warnings'

/** Plan views: a row, a day with its groups and gaps, a week with column counters. */

function personRef(context: FactsContext, id: string | null) {
  if (!id) return null
  const person = context.world.people.find((candidate) => candidate.id === id)
  return person ? { id: person.id, name: person.name } : null
}

type RowFileKind = Extract<DownloadKind, 'platform' | 'teaser' | 'photos'>

/** «Фото 21 шт., по порядку» · «Фото 12 шт. и 2 видео, по порядку». */
function framesLabel(delivery: Delivery): string {
  const photos = delivery.files.filter((member) => member.file.media === 'photo').length
  const videos = delivery.files.length - photos
  const parts = [photos > 0 ? `Фото ${photos} шт.` : '', videos > 0 ? `${videos} видео` : '']
  return `${parts.filter(Boolean).join(' и ')}, по порядку`
}

/**
 * What a row ships on its page (DESIGN §4.11): the platform copy of the master, the
 * teaser and PPV photos; a set gives its picked frames in order, life and sexting their
 * files in order — as «Для заливки» of the object (§4.4).
 */
function planFiles(
  record: ItemRecord,
  surface: SurfaceKind,
  options: DeliveryOptions,
): { key: RowFileKind; label: string; download_name: string }[] {
  const entry = record.entry
  const file = (key: RowFileKind, label: (delivery: Delivery) => string) => {
    const delivery = recordDelivery(record, key, options)
    return delivery.files.length > 0
      ? [{ key, label: label(delivery), download_name: delivery.name }]
      : []
  }
  const master = file('platform', () =>
    entry.duration_s ? `Мастер ${formatDuration(entry.duration_s)}` : 'Мастер',
  )
  switch (entry.type) {
    case 'fyp':
    case 'custom':
      return entry.photo_custom ? file('platform', framesLabel) : master
    case 'ppv':
      if (surface === 'story') return file('teaser', () => 'Тизер')
      return [...master, ...file('teaser', () => 'Тизер'), ...file('photos', framesLabel)]
    case 'set':
    case 'life':
    case 'sexting':
      return file('platform', framesLabel)
    default:
      return []
  }
}

export function manifestOf(context: FactsContext, row: PlanRowRecord): PlanRow['manifest'] {
  if (!row.item_id) return null
  const record = context.model.items.get(row.item_id)
  if (!record) return null
  const entry = record.entry
  return {
    item_id: entry.id,
    item_type: entry.type,
    title: entry.title,
    thumb: entry.cover,
    fyp_version: row.fyp_version,
    files: planFiles(record, row.surface, rowOptions(context.model, row)),
  }
}

/**
 * `warnings`: on a plan row only the amber captions «слишком рано» and «два поста»; in the
 * preview of a batch (`?dry_run=1`) every warning of the check line but the grey one.
 */
export function planRowView(
  context: FactsContext,
  row: PlanRowRecord,
  warnings: 'row' | 'preview' = 'row',
): PlanRow {
  const account = accountOf(context.model, row.account)
  const hub = hubCoverage(context, row.account, row.surface)
  const people = context.world.people
  const entry = row.item_id ? context.model.items.get(row.item_id)?.entry : undefined
  return {
    id: row.id,
    date: row.date,
    time: row.time,
    account: row.account,
    surface: row.surface,
    manifest: manifestOf(context, row),
    awaiting_montage: row.awaiting_montage,
    assignee: personRef(context, row.assignee),
    mark: row.mark
      ? {
          kind: row.mark.kind,
          at: row.mark.at,
          by: actorOf(row.mark.by, people),
          stated_occurred_at: row.mark.stated_occurred_at,
          for_current_manifest: row.mark.for_current_manifest,
        }
      : null,
    cancelled: row.cancelled
      ? {
          at: row.cancelled.at,
          by: actorOf(row.cancelled.by, people),
          reason: row.cancelled.reason,
        }
      : null,
    release_id: row.release_id,
    requires_new_upload: row.requires_new_upload,
    has_newer_version: row.has_newer_version,
    note: row.note,
    album: row.album ?? (row.surface === 'vault' && entry ? vaultAlbumName(entry) : null),
    copy: row.copy,
    downloaded: row.downloaded
      ? {
          at: row.downloaded.at,
          by: actorOf(row.downloaded.by, people).name,
          meta_stripped: row.downloaded.meta_stripped,
        }
      : null,
    warnings:
      row.mark || row.cancelled
        ? []
        : planWarnings(context, {
            row_id: row.id,
            item_id: row.item_id,
            account: row.account,
            surface: row.surface,
            date: row.date,
            time: row.time,
            montage_from: row.awaiting_montage?.from_item ?? null,
          }).filter((warning) =>
            warnings === 'preview'
              ? warning.kind !== 'threshold_unset'
              : warning.kind === 'too_early' || warning.kind === 'same_time',
          ),
    mark_button: markButtonKind(account.platform, row.surface, hub.state),
    created_by: actorOf(row.created_by, people),
    created_at: row.created_at,
    version: row.version,
    verdict: evaluateRow(context, row),
  }
}

const NORM_SURFACE: Record<NormKind, SurfaceKind> = {
  fyp: 'fyp',
  wall: 'wall',
  life_vault: 'vault',
  story: 'story',
}

const GAP_TEXT: Record<NormKind, string> = {
  fyp: 'Здесь нужен фуп',
  wall: 'Здесь нужен пост на стену',
  life_vault: 'Здесь нужен лайф в vault',
  story: 'Здесь нужна сториз',
}

function rowMatchesNorm(context: FactsContext, row: PlanRowRecord, kind: NormKind): boolean {
  if (row.surface !== NORM_SURFACE[kind]) return false
  if (kind !== 'life_vault') return true
  const type = row.item_id ? context.model.items.get(row.item_id)?.entry.type : undefined
  return type === 'life'
}

/** Empty places of the norm for a page and a day. */
function gapsOf(
  context: FactsContext,
  norm: WeekNorm,
  date: LocalDate,
  rows: readonly PlanRowRecord[],
): SlotGap[] {
  const weekday = weekdayIndex(date)
  const gaps: SlotGap[] = []
  for (const cell of norm.cells) {
    const expected = cell.per_day[weekday] ?? 0
    const present = rows.filter(
      (row) => row.account === norm.account && rowMatchesNorm(context, row, cell.kind),
    ).length
    for (let index = present; index < expected; index++) {
      gaps.push({
        date,
        account: norm.account,
        kind: cell.kind,
        surface: NORM_SURFACE[cell.kind],
        time: cell.time,
        text: GAP_TEXT[cell.kind],
      })
    }
  }
  return gaps
}

function activeRows(context: FactsContext, dates: ReadonlySet<LocalDate>): PlanRowRecord[] {
  return [...context.model.plan_rows.values()]
    .filter((row) => dates.has(row.date) && !row.cancelled)
    .sort((left, right) =>
      slotOrder(left.date, left.time).localeCompare(slotOrder(right.date, right.time)),
    )
}

function releaseView(context: FactsContext, release: ReleaseRecord): Release {
  const rows = [...context.model.plan_rows.values()].filter(
    (row) => row.release_id === release.id && !row.cancelled,
  )
  return {
    id: release.id,
    item_id: release.item_id,
    date: release.date,
    row_ids: rows.map((row) => row.id),
    done: rows.filter((row) => row.mark || isPlacedLevel(evaluateRow(context, row).level)).length,
    accounts: new Set(rows.map((row) => row.account)).size,
  }
}

function strongestSign(signs: readonly (Sign | null)[]): Sign | null {
  if (signs.includes('trouble')) return 'trouble'
  if (signs.includes('turn')) return 'turn'
  return null
}

function hubIntegration(context: FactsContext, account: AccountCode): Integration | undefined {
  return context.world.integrations.find(
    (integration) => integration.kind === 'hub' && integration.account === account,
  )
}

/** The Hub line of a page when Hub does not work there (DESIGN §3.11). */
function hubLine(
  context: FactsContext,
  account: AccountCode,
  accountLabel: string | null,
): IntegrationLine | null {
  const integration = hubIntegration(context, account)
  return integration && integration.state !== 'working'
    ? describeIntegration(integration, { now: context.now, accountLabel })
    : null
}

/** One line for the whole day when Hub is equally not working on every page. */
function modelHubLine(context: FactsContext): IntegrationLine | null {
  const hubs = context.model.model.accounts.map((account) => hubIntegration(context, account.code))
  const [first] = hubs
  if (!first || first.state === 'working') return null
  if (!hubs.every((hub) => hub?.state === first.state)) return null
  return describeIntegration(first, { now: context.now, accountLabel: null })
}

/** «Hub видел 1 пост без плана»: open «пост без плана» cases of the page posted that day. */
function unplannedPosts(context: FactsContext, account: AccountCode, date: LocalDate): number {
  return context.model.tracks.filter((track) => {
    if (track.account !== account) return false
    const verdict = evaluateTrack(context, track)
    return verdict.level === 'unplanned_post' && verdict.date === date
  }).length
}

export function planDay(
  context: FactsContext,
  date: LocalDate,
  mineOf: string | null,
  withCancelled = false,
): PlanDay {
  const allRows = [...context.model.plan_rows.values()].filter((row) => row.date === date)
  const dayRows = activeRows(context, new Set([date]))
  const isMine = (row: PlanRowRecord) => !mineOf || row.assignee === mineOf
  const cancelled = allRows.filter((row) => row.cancelled && isMine(row))
  const active = dayRows.filter(isMine)
  const rows = withCancelled ? [...active, ...cancelled] : active
  const week = weekDates(isoWeekOf(date))
  // Точки считаются по тем же строкам, что в списке: при «Мои» — только свои строки и
  // посты без плана на своих страницах.
  const dots = week.map((day) => {
    const signs = activeRows(context, new Set([day]))
      .filter(isMine)
      .map((row) => evaluateRow(context, row).sign)
    const unplanned = context.model.model.accounts.some(
      (account) =>
        (!mineOf || account.usual_assignee === mineOf) &&
        unplannedPosts(context, account.code, day) > 0,
    )
    return { date: day, sign: strongestSign(unplanned ? [...signs, 'turn'] : signs) }
  })
  const views = rows.map((row) => planRowView(context, row))
  return {
    date,
    week_dots: dots,
    integration: modelHubLine(context),
    groups: context.model.model.accounts.map((account) => ({
      account: account.code,
      assignee: personRef(context, account.usual_assignee),
      integration: hubLine(context, account.code, account.label),
      unplanned_posts: unplannedPosts(context, account.code, date),
    })),
    rows: views,
    gaps: [...context.model.norms.values()].flatMap((norm) => gapsOf(context, norm, date, dayRows)),
    releases: context.model.releases
      .filter((release) => rows.some((row) => row.release_id === release.id))
      .map((release) => releaseView(context, release)),
    cancelled_count: cancelled.length,
    download_size_bytes: active.reduce(
      (sum, row) => sum + (row.copy?.state === 'ready' ? row.copy.size_bytes : 0),
      0,
    ),
  }
}

function normHint(norm: WeekNorm): string {
  const days = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс']
  const labels: Record<NormKind, string> = {
    fyp: 'Фуп',
    wall: 'Стена',
    life_vault: 'Лайф в vault',
    story: 'Сториз',
  }
  return norm.cells
    .filter((cell) => cell.per_day.some((count) => count > 0))
    .map((cell) => {
      const which = cell.per_day.every((count) => count > 0)
        ? 'каждый день'
        : cell.per_day.flatMap((count, index) => (count > 0 ? [days[index]] : [])).join(', ')
      return `${labels[cell.kind]}: ${which}${cell.time ? ` ${cell.time}` : ''}`
    })
    .join(' · ')
}

export function planWeek(context: FactsContext, week: IsoWeek): PlanWeek {
  const dates = weekDates(week)
  const rows = activeRows(context, new Set(dates))
  const gaps = dates.flatMap((date) =>
    [...context.model.norms.values()].flatMap((norm) =>
      gapsOf(
        context,
        norm,
        date,
        rows.filter((row) => row.date === date),
      ),
    ),
  )
  const views = rows.map((row) => planRowView(context, row))
  return {
    week,
    dates,
    columns: context.model.model.accounts.map((account) => {
      const norm = context.model.norms.get(account.code)
      return {
        account: account.code,
        empty: gaps.filter((gap) => gap.account === account.code).length,
        missed: views.filter(
          (row) => row.account === account.code && row.verdict.level === 'missed',
        ).length,
        norm_hint: norm ? normHint(norm) : '',
        integration: hubLine(context, account.code, null),
      }
    }),
    rows: views,
    gaps,
    releases: context.model.releases
      .filter((release) => dates.includes(release.date))
      .map((release) => releaseView(context, release)),
  }
}
