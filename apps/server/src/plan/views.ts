import { addDays, isoWeekOf, weekDates, weekdayIndex } from '@contentops/contracts/clock'
import type { CatalogEntry } from '@contentops/contracts/domain/catalog'
import type { IsoWeek, LocalDate, Sign } from '@contentops/contracts/domain/common'
import type { Integration, IntegrationLine } from '@contentops/contracts/domain/integrations'
import type { PlacementVerdict } from '@contentops/contracts/domain/placement'
import type {
  GapKind,
  PlanDay,
  PlanRow,
  PlanWeek,
  Release,
  SlotGap,
  WeekNorm,
} from '@contentops/contracts/domain/plan'
import { describeIntegration } from '@contentops/contracts/integration-line'
import { isPlacedLevel, markButtonKind } from '@contentops/contracts/placement'
import { vaultAlbumName } from '@contentops/contracts/vault-album'
import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { catalogEntries } from '../catalog/entries'
import { publicIdOf } from '../catalog/ids'
import { instant } from '../commands'
import type { DownloadItem } from '../media/downloads'
import { planWarnings, slotOrder } from './checks'
import {
  compositionOf,
  copyState,
  currentFiles,
  manifestFiles,
  manifestView,
  rowFiles,
  sameComposition,
} from './composition'
import { hubView, type PublishContext, publishContext, rowVerdict } from './publication-view'
import { actorRef, type People, type RowRecord, surfaceOfDb } from './records'
import { evaluateRow, hubCoverage, type PlanState, todayOf } from './state'

/**
 * Views of the plan (DESIGN §4.11–4.12): a row with its composition, files, copy and
 * verdict; a day with its groups, gaps against the norm and releases; a week with column
 * counters. Tasks of a day are rows by date and assignee (the row's or the page's usual one).
 */

function personRef(people: People, id: string | null) {
  const person = id ? people.get(id) : undefined
  return person ? { id: person.id, name: person.name } : null
}

export interface ViewContext {
  q: Queryable
  state: PlanState
  /** Catalog entries of the rows' objects, by internal id. */
  entries: Map<string, CatalogEntry>
  integrations: Integration[]
  /** Publication through Hub (5б): switches, works under way, freshness of the statuses. */
  publish: PublishContext
}

export async function viewContext(
  q: Queryable,
  state: PlanState,
  integrations: Integration[],
  rows: readonly RowRecord[] = state.rows,
): Promise<ViewContext> {
  const ids = [...new Set(rows.flatMap((row) => (row.item_id ? [row.item_id] : [])))]
  const list =
    ids.length > 0
      ? await catalogEntries(
          q,
          state.model,
          sql`AND c.item_id = ANY(${sql.param(ids)}::uuid[])`,
          sql``,
        )
      : []
  return {
    q,
    state,
    entries: new Map(list.map((entry) => [entry.uid, entry])),
    integrations,
    publish: await publishContext(q, state, integrations),
  }
}

const EXPECTED: Record<string, 'fyp' | 'ppv' | 'teaser'> = {
  FYP: 'fyp',
  PPV: 'ppv',
  teaser: 'teaser',
}

async function lastDownload(q: Queryable, modelId: string, rowId: string) {
  const { rows } = await q.execute<{ at: string; by: string; meta_stripped: boolean }>(sql`
    SELECT r.issued_at::text AS at, p.display_name AS by, r.meta_stripped
      FROM download_receipts r JOIN principals p ON p.id = r.principal_id
     WHERE r.model_id = ${modelId}::uuid AND r.plan_row_id = ${rowId}::uuid
     ORDER BY r.issued_at DESC LIMIT 1`)
  const row = rows[0]
  return row ? { at: instant(row.at), by: row.by, meta_stripped: row.meta_stripped } : null
}

/**
 * `warnings`: on a plan row only the amber captions «слишком рано» and «два поста»; in the
 * preview of a batch (`?dry_run=1`) every warning of the check line but the grey one.
 */
export async function rowView(
  context: ViewContext,
  row: RowRecord,
  warnings: 'row' | 'preview' = 'row',
): Promise<PlanRow> {
  const { q, state } = context
  const entry = row.item_id ? context.entries.get(row.item_id) : undefined
  const sealed = row.manifest_id ? await manifestFiles(q, state.model.id, row.manifest_id) : []
  let hasNewer = false
  let manifest: PlanRow['manifest'] = null
  let copy: PlanRow['copy'] = null
  if (row.item_id && row.item_type && row.item_number !== null && entry) {
    const item: DownloadItem = {
      id: row.item_id,
      type: row.item_type,
      public_id: publicIdOf(row.item_type, row.item_number),
      title: row.item_title,
      title_en: row.item_title_en,
    }
    const waitingVersion = row.manifest_id === null && row.uniq_variant_no !== null
    if (row.manifest_id || waitingVersion) {
      const current = compositionOf(
        row.item_type,
        row.surface,
        await currentFiles(q, state.model.id, row.item_id),
        row.uniq_variant_no,
      )
      hasNewer = row.manifest_id !== null && !sameComposition(sealed, current)
      const files = rowFiles(state.model.code, item, row.surface, sealed, {
        account: row.account,
        date: row.slot_date,
        time: row.slot_time,
      })
      const variant = sealed.find((file) => file.variant_no > 0)
      const level = variant ? await uniqLevelOf(q, state.model.id, variant.asset_id) : null
      manifest = manifestView(
        {
          item_id: entry.id,
          item_type: entry.type,
          title: entry.title,
          thumb: entry.cover,
        },
        files,
        row.uniq_variant_no !== null ? { no: row.uniq_variant_no, level: level ?? 'soft' } : null,
      )
      copy = waitingVersion ? { state: 'building', progress: 0 } : await copyState(q, sealed)
    }
  }
  const waiting =
    row.manifest_id === null && (row.expected_type !== null || row.expected_role !== null)
  const awaitingFrom =
    row.input_item_type && row.input_item_number !== null
      ? publicIdOf(row.input_item_type, row.input_item_number)
      : row.item_type && row.item_number !== null
        ? publicIdOf(row.item_type, row.item_number)
        : null
  const page = state.view.accounts.find((account) => account.code === row.account)
  const hub = hubView(context.publish, state, row)
  const verdict = rowVerdict(evaluateRow(state, row, { copy, hasNewerVersion: hasNewer }), hub)
  const open = !row.marked_at && !row.cancelled_at
  return {
    id: row.id,
    date: row.slot_date,
    time: row.slot_time,
    account: row.account,
    surface: surfaceOfDb(row.surface),
    manifest,
    awaiting_montage:
      waiting && awaitingFrom
        ? {
            from_item: awaitingFrom,
            expected_type: EXPECTED[row.expected_role ?? row.expected_type ?? 'FYP'] ?? 'fyp',
            file_keys: row.input_manifest_id
              ? (await manifestFiles(q, state.model.id, row.input_manifest_id)).map((file) =>
                  file.ordinal ? `${file.role}${String(file.ordinal).padStart(2, '0')}` : file.role,
                )
              : [],
          }
        : null,
    assignee: personRef(state.people, row.executor_id),
    mark:
      row.marked_at && row.mark_kind
        ? {
            kind: row.mark_kind,
            at: row.marked_at,
            by: actorRef(state.people, row.marked_by),
            stated_occurred_at: row.stated_occurred_at,
            for_current_manifest: row.marked_manifest_id === row.manifest_id,
          }
        : null,
    cancelled: row.cancelled_at
      ? {
          at: row.cancelled_at,
          by: actorRef(state.people, row.cancelled_by),
          reason: row.cancel_reason,
        }
      : null,
    release_id: row.release_id,
    requires_new_upload: row.requires_new_upload,
    has_newer_version: hasNewer,
    note: row.note,
    album: row.album_name ?? (row.surface === 'vault' && entry ? vaultAlbumName(entry) : null),
    publication: {
      caption: row.caption,
      tiers: row.tier_refs,
      price_mills: row.price_mills === null ? null : Number(row.price_mills),
      repost: row.repost,
    },
    hub,
    copy,
    downloaded: await lastDownload(q, state.model.id, row.id),
    warnings: open
      ? planWarnings(state, {
          row_id: row.id,
          item: candidateItem(row),
          montage_from: row.input_item_id ? { id: row.input_item_id } : null,
          account: row.account,
          surface: row.surface,
          date: row.slot_date,
          time: row.slot_time,
          release_id: row.release_id,
          marked: false,
        }).filter((warning) =>
          warnings === 'preview'
            ? warning.kind !== 'threshold_unset'
            : warning.kind === 'too_early' || warning.kind === 'same_time',
        )
      : [],
    mark_button: markButtonKind(
      page?.platform ?? row.platform,
      surfaceOfDb(row.surface),
      hubCoverage(state, row.account).state,
    ),
    created_by: actorRef(state.people, row.created_by),
    created_at: row.created_at,
    version: row.row_version,
    verdict,
  }
}

export function candidateItem(row: RowRecord) {
  return row.item_id && row.item_type && row.item_number !== null
    ? {
        id: row.item_id,
        type: row.item_type,
        number: row.item_number,
        has_second_person: row.has_second_person,
      }
    : null
}

async function uniqLevelOf(q: Queryable, modelId: string, assetId: string) {
  const { rows } = await q.execute<{ level: 'soft' | 'trim' | 'mirror' | null }>(sql`
    SELECT uniq_level AS level FROM assets WHERE model_id = ${modelId}::uuid AND id = ${assetId}::uuid`)
  return rows[0]?.level ?? null
}

// ---------------------------------------------------------------------------
// Norm, gaps and releases
// ---------------------------------------------------------------------------

const GAP_SURFACE: Record<GapKind, SlotGap['surface']> = {
  fyp: 'fyp',
  wall: 'wall',
  life_vault: 'vault',
  story: 'story',
  release: 'wall',
}

const GAP_TEXT: Record<GapKind, string> = {
  fyp: 'Здесь нужен фуп',
  wall: 'Здесь нужен пост на стену',
  life_vault: 'Здесь нужен лайф в vault',
  story: 'Здесь нужна сториз',
  release: 'Здесь нужен выпуск PPV',
}

function rowMatchesNorm(row: RowRecord, kind: GapKind): boolean {
  switch (kind) {
    case 'fyp':
      return row.surface === 'fyp'
    case 'wall':
      return row.surface === 'wall'
    case 'life_vault':
      return row.surface === 'vault' && row.item_type === 'LIFE'
    case 'story':
      return row.surface === 'story'
    case 'release':
      return false
  }
}

/** Live rows: not cancelled. */
function live(rows: readonly RowRecord[]): RowRecord[] {
  return rows.filter((row) => !row.cancelled_at)
}

/**
 * Empty places of the norm of a page for the dates (SPEC §4, §7): by type and day, not only
 * empty days. The PPV release is one record «раз в N недель от прошлого выпуска на этой
 * странице»: a release of several rows counts once, by its id.
 */
export function gapsOf(
  state: PlanState,
  norms: readonly WeekNorm[],
  dates: readonly LocalDate[],
): SlotGap[] {
  const rows = live(state.rows)
  const gaps: SlotGap[] = []
  for (const norm of norms) {
    const page = rows.filter((row) => row.account === norm.account)
    for (const date of dates) {
      const weekday = weekdayIndex(date)
      const day = page.filter((row) => row.slot_date === date)
      for (const cell of norm.cells) {
        const expected = cell.per_day[weekday] ?? 0
        const present = day.filter((row) => rowMatchesNorm(row, cell.kind)).length
        for (let index = present; index < expected; index++) {
          gaps.push({
            date,
            account: norm.account,
            kind: cell.kind,
            surface: GAP_SURFACE[cell.kind],
            time: cell.time,
            text: GAP_TEXT[cell.kind],
          })
        }
      }
      if (norm.release && weekday === norm.release.weekday && releaseDue(page, date, norm)) {
        gaps.push({
          date,
          account: norm.account,
          kind: 'release',
          surface: 'wall',
          time: norm.release.time,
          text: GAP_TEXT.release,
        })
      }
    }
  }
  return gaps
}

/** Dates of the live releases of a page, one per release id. */
function releaseDates(page: readonly RowRecord[]): LocalDate[] {
  const dates = new Map<string, LocalDate>()
  for (const row of page) {
    if (row.release_id && row.release_date) dates.set(row.release_id, row.release_date)
  }
  return [...dates.values()]
}

/** No release in the week of the date, and the last one is N weeks back or there is none. */
function releaseDue(page: readonly RowRecord[], date: LocalDate, norm: WeekNorm): boolean {
  const release = norm.release
  if (!release) return false
  const week = isoWeekOf(date)
  const dates = releaseDates(page)
  if (dates.some((on) => isoWeekOf(on) === week)) return false
  const start = weekDates(week)[0] as LocalDate
  const before = dates.filter((on) => on < start).sort()
  const last = before.at(-1)
  if (!last) return true
  const weeks = Math.round(
    (Date.parse(weekDates(isoWeekOf(last))[0] as LocalDate) - Date.parse(start)) / -604_800_000,
  )
  return weeks >= release.every_weeks
}

function releaseView(state: PlanState, releaseId: string): Release | null {
  const rows = live(state.rows).filter((row) => row.release_id === releaseId)
  const first = rows[0]
  if (!first?.item_type || first.item_number === null) return null
  return {
    id: releaseId,
    item_id: publicIdOf(first.item_type, first.item_number),
    date: first.release_date ?? first.slot_date,
    row_ids: rows.map((row) => row.id),
    done: rows.filter((row) => row.marked_at || isPlacedLevel(evaluateRow(state, row).level))
      .length,
    accounts: new Set(rows.map((row) => row.account)).size,
  }
}

function strongestSign(signs: readonly (Sign | null)[]): Sign | null {
  if (signs.includes('trouble')) return 'trouble'
  if (signs.includes('turn')) return 'turn'
  return null
}

function hubOf(context: ViewContext, account: string): Integration | undefined {
  return context.integrations.find(
    (integration) => integration.kind === 'hub' && integration.account === account,
  )
}

/** The Hub line of a page when Hub does not work there (DESIGN §3.11). */
function hubLine(
  context: ViewContext,
  account: string,
  accountLabel: string | null,
): IntegrationLine | null {
  const integration = hubOf(context, account)
  return integration && integration.state !== 'working'
    ? describeIntegration(integration, { now: context.state.now, accountLabel })
    : null
}

/** One line for the whole day when Hub is equally not working on every page. */
function modelHubLine(context: ViewContext): IntegrationLine | null {
  const hubs = context.state.view.accounts.map((account) => hubOf(context, account.code))
  const [first] = hubs
  if (!first || first.state === 'working') return null
  if (!hubs.every((hub) => hub?.state === first.state)) return null
  return describeIntegration(first, { now: context.state.now, accountLabel: null })
}

export function normsOf(state: PlanState): WeekNorm[] {
  return state.norms
}

/** The tasks filter «Мои»: rows the person posts, by the row or by the page. */
function isMine(row: RowRecord, personId: string | null): boolean {
  return personId === null || row.executor_id === personId
}

function sortRows(rows: readonly RowRecord[]): RowRecord[] {
  return [...rows].sort((left, right) =>
    slotOrder(left.slot_date, left.slot_time).localeCompare(
      slotOrder(right.slot_date, right.slot_time),
    ),
  )
}

const NEEDS_STEP = new Set<PlacementVerdict['level']>([
  'planned',
  'missed',
  'blocked_second_person',
])

export async function dayView(
  context: ViewContext,
  date: LocalDate,
  mine: string | null,
  withCancelled: boolean,
): Promise<PlanDay> {
  const { state } = context
  const all = state.rows.filter((row) => row.slot_date === date)
  const active = sortRows(all.filter((row) => !row.cancelled_at && isMine(row, mine)))
  const cancelled = all.filter((row) => row.cancelled_at && isMine(row, mine))
  const shown = withCancelled ? [...active, ...sortRows(cancelled)] : active
  const views: PlanRow[] = []
  for (const row of shown) views.push(await rowView(context, row))
  const week = weekDates(isoWeekOf(date))
  const dots = week.map((day) => ({
    date: day,
    sign: strongestSign(
      live(state.rows)
        .filter((row) => row.slot_date === day && isMine(row, mine))
        .map((row) => evaluateRow(state, row).sign),
    ),
  }))
  const norms = normsOf(state)
  const step = views.filter(
    (view) =>
      !view.cancelled && (NEEDS_STEP.has(view.verdict.level) || view.verdict.sign === 'turn'),
  )
  return {
    date,
    week_dots: dots,
    integration: modelHubLine(context),
    groups: state.view.accounts.map((account) => ({
      account: account.code,
      assignee: personRef(state.people, account.usual_assignee),
      integration: hubLine(context, account.code, account.label),
      // Hub posts without a plan are found from stage 5 on.
      unplanned_posts: 0,
    })),
    rows: views,
    gaps: gapsOf(state, norms, [date]),
    releases: [...new Set(shown.flatMap((row) => (row.release_id ? [row.release_id] : [])))]
      .map((id) => releaseView(state, id))
      .filter((release): release is Release => release !== null),
    cancelled_count: cancelled.length,
    download_size_bytes: step.reduce(
      (sum, row) => sum + (row.copy?.state === 'ready' ? row.copy.size_bytes : 0),
      0,
    ),
  }
}

function normHint(norm: WeekNorm): string {
  const days = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс']
  const labels = { fyp: 'Фуп', wall: 'Стена', life_vault: 'Лайф в vault', story: 'Сториз' }
  const cells = norm.cells
    .filter((cell) => cell.per_day.some((count) => count > 0))
    .map((cell) => {
      const which = cell.per_day.every((count) => count > 0)
        ? 'каждый день'
        : cell.per_day.flatMap((count, index) => (count > 0 ? [days[index]] : [])).join(', ')
      return `${labels[cell.kind]}: ${which}${cell.time ? ` ${cell.time}` : ''}`
    })
  if (norm.release) {
    const every =
      norm.release.every_weeks === 1 ? 'каждую неделю' : `раз в ${norm.release.every_weeks} нед.`
    cells.push(`Выпуск PPV: ${every}, ${days[norm.release.weekday]} ${norm.release.time}`)
  }
  return cells.join(' · ')
}

export async function weekView(context: ViewContext, week: IsoWeek): Promise<PlanWeek> {
  const { state } = context
  const dates = weekDates(week)
  const rows = sortRows(live(state.rows).filter((row) => dates.includes(row.slot_date)))
  const views: PlanRow[] = []
  for (const row of rows) views.push(await rowView(context, row))
  const norms = normsOf(state)
  const gaps = gapsOf(state, norms, dates)
  const releaseIds = [...new Set(rows.flatMap((row) => (row.release_id ? [row.release_id] : [])))]
  return {
    week,
    dates,
    columns: state.view.accounts.map((account) => {
      const norm = norms.find((candidate) => candidate.account === account.code)
      return {
        account: account.code,
        empty: gaps.filter((gap) => gap.account === account.code).length,
        missed: views.filter(
          (view) => view.account === account.code && view.verdict.level === 'missed',
        ).length,
        norm_hint: norm ? normHint(norm) : '',
        integration: hubLine(context, account.code, null),
      }
    }),
    rows: views,
    gaps,
    releases: releaseIds
      .map((id) => releaseView(state, id))
      .filter((release): release is Release => release !== null)
      .filter((release) => dates.includes(release.date)),
  }
}

/** Every date of the model's plan the counters care about: today in Moscow. */
export function todayRows(state: PlanState): RowRecord[] {
  const today = todayOf(state)
  return live(state.rows).filter((row) => row.slot_date === today)
}

export { addDays }
