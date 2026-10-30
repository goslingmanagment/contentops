import { daysBetween, mskDate, mskInstant } from '@contentops/contracts/clock'
import type { AccountCode, LocalDate, LocalTime } from '@contentops/contracts/domain/common'
import { type ItemId, itemTypeOf } from '@contentops/contracts/domain/item-type'
import type { PlacementVerdict, SurfaceKind } from '@contentops/contracts/domain/placement'
import type { PlanWarning } from '@contentops/contracts/domain/plan'
import { type ThresholdKey, thresholdFor } from '@contentops/contracts/domain/system'
import {
  capitalize,
  formatDate,
  formatDaysAgo,
  formatDaysSpan,
  formatShortDay,
  formatWeekdayShort,
} from '@contentops/contracts/format'
import { isInPlanLevel, isPlacedLevel } from '@contentops/contracts/placement'
import { accountOf, evaluateRow, evaluateTrack, type FactsContext } from '../fixtures/facts'
import type { PlanRowRecord } from '../fixtures/world-types'

/** The check line of the «В план» window and the amber captions of plan rows (DESIGN §4.13). */

export interface RowCandidate {
  row_id: string | null
  item_id: ItemId | null
  /** «Под монтаж»: the raw object the row waits a montage from. */
  montage_from?: ItemId | null
  account: AccountCode
  surface: SurfaceKind
  date: LocalDate
  time: LocalTime | null
}

/** The threshold for the row: an exception for its page or type wins over the common one. */
function threshold(
  context: FactsContext,
  key: ThresholdKey,
  candidate: RowCandidate,
): number | null {
  return thresholdFor(context.world.thresholds, key, {
    model: context.model.model.code,
    account: candidate.account,
    type: candidate.item_id ? itemTypeOf(candidate.item_id) : null,
  })
}

/** The object a row stands for: the object itself or the raw it waits a montage from. */
function objectOfRow(row: PlanRowRecord): ItemId | null {
  return row.item_id ?? row.awaiting_montage?.from_item ?? null
}

/**
 * Last date the object was placed on the page, the row date included; the candidate row
 * itself is not counted. Tracks and plan rows without a track both count.
 */
export function lastPlacedOn(
  context: FactsContext,
  itemId: ItemId,
  account: AccountCode,
  until: LocalDate,
  exceptRow: string | null = null,
): LocalDate | null {
  let last: LocalDate | null = null
  const consider = (verdict: PlacementVerdict) => {
    if (!isPlacedLevel(verdict.level) || !verdict.date || verdict.date > until) return
    if (!last || verdict.date > last) last = verdict.date
  }
  const rowsWithTrack = new Set<string>()
  for (const track of context.model.tracks) {
    if (track.plan_row_id) rowsWithTrack.add(track.plan_row_id)
    if (track.item_id !== itemId || track.account !== account) continue
    if (exceptRow && track.plan_row_id === exceptRow) continue
    consider(evaluateTrack(context, track))
  }
  for (const row of context.model.plan_rows.values()) {
    if (row.item_id !== itemId || row.account !== account) continue
    if (row.id === exceptRow || rowsWithTrack.has(row.id)) continue
    consider(evaluateRow(context, row))
  }
  return last
}

/**
 * Rows of the same object on the same page and place that still wait in the plan — on any
 * day, the same one and past ones included (a missed row, a row «в планировщике»).
 * The nearest to the candidate date goes first.
 */
export function samePlaceRows(context: FactsContext, candidate: RowCandidate): PlanRowRecord[] {
  const object = candidate.item_id ?? candidate.montage_from ?? null
  if (!object) return []
  const distance = (row: PlanRowRecord) => Math.abs(daysBetween(candidate.date, row.date))
  return [...context.model.plan_rows.values()]
    .filter(
      (row) =>
        row.id !== candidate.row_id &&
        !row.cancelled &&
        row.account === candidate.account &&
        row.surface === candidate.surface &&
        objectOfRow(row) === object &&
        isInPlanLevel(evaluateRow(context, row).level),
    )
    .sort((left, right) => distance(left) - distance(right) || left.date.localeCompare(right.date))
}

function minutesOf(time: LocalTime): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
}

function today(context: FactsContext): LocalDate {
  return mskDate(context.now)
}

/**
 * «было 13.09 — 9 дней назад» when the row is for today; otherwise days are counted to the
 * row date and said so: «было 12.08, к сб 26 будет 45 дней». Another year gets its year and
 * the span in words.
 */
export function sincePhrase(context: FactsContext, last: LocalDate, date: LocalDate): string {
  const now = today(context)
  const when = formatDate(last, now)
  const days = daysBetween(last, date)
  if (date === now || days >= 365) return `было ${when} — ${formatDaysAgo(daysBetween(last, now))}`
  return `было ${when}, к ${formatShortDay(date)} будет ${formatDaysSpan(days)}`
}

/** Where the same object already waits: the day with its time and the state word, if any. */
function slotParts(context: FactsContext, row: PlanRowRecord) {
  const day = `${formatWeekdayShort(row.date)} ${formatDate(row.date, today(context))}`
  const word = evaluateRow(context, row).word
  const state = row.awaiting_montage ? 'ждёт монтаж' : word === 'в плане' ? null : word
  return { slot: `${day}, ${row.time ?? 'весь день'}`, state }
}

/** «вт 22.09, 20:00 · в планировщике». */
function slotPhrase(context: FactsContext, row: PlanRowRecord): string {
  const { slot, state } = slotParts(context, row)
  return [slot, state].filter(Boolean).join(' · ')
}

/**
 * A warning and the same thing without the page name: «слишком рано, было 13.09 — 9 дней
 * назад». The page-free phrase lets the «В план» window say every chosen page in one line.
 */
interface CheckedWarning {
  warning: PlanWarning
  page_text: string
}

function checkedWarnings(context: FactsContext, candidate: RowCandidate): CheckedWarning[] {
  const checked: CheckedWarning[] = []
  const label = accountOf(context.model, candidate.account).label
  const tolerance = threshold(context, 'time_tolerance_min', candidate) ?? 30
  const [twin] = samePlaceRows(context, candidate)
  if (twin) {
    const { slot, state } = slotParts(context, twin)
    checked.push({
      warning: {
        kind: 'already_planned',
        date: twin.date,
        text: `уже в плане: ${label} · ${slotPhrase(context, twin)}`,
      },
      page_text: `уже в плане на ${slot}${state ? ` (${state})` : ''}`,
    })
  }
  let thresholdUnset = false
  if (candidate.item_id) {
    const earlyDays = threshold(context, 'too_early_days', candidate)
    const last = lastPlacedOn(
      context,
      candidate.item_id,
      candidate.account,
      candidate.date,
      candidate.row_id,
    )
    if (earlyDays === null) {
      thresholdUnset = true
    } else if (last && daysBetween(last, candidate.date) < earlyDays) {
      const since = sincePhrase(context, last, candidate.date)
      checked.push({
        warning: {
          kind: 'too_early',
          account: candidate.account,
          days: daysBetween(last, candidate.date),
          text: `слишком рано: на ${label} ${since}`,
        },
        page_text: `слишком рано, ${since}`,
      })
    }
  }
  for (const row of context.model.plan_rows.values()) {
    if (row.id === candidate.row_id || row.cancelled || row.account !== candidate.account) continue
    if (
      row.date !== candidate.date ||
      !row.time ||
      !candidate.time ||
      !row.item_id ||
      row.item_id === candidate.item_id
    )
      continue
    const gap = Math.abs(minutesOf(row.time) - minutesOf(candidate.time))
    if (gap === 0) {
      checked.push({
        warning: {
          kind: 'same_time',
          other_item: row.item_id,
          text: `в ${candidate.time} на ${label} уже стоит ${row.item_id} — два поста в одно время`,
        },
        page_text: `в ${candidate.time} уже стоит ${row.item_id} — два поста в одно время`,
      })
    } else if (gap < tolerance * 2) {
      checked.push({
        warning: {
          kind: 'too_close',
          other_item: row.item_id,
          text: `посты ближе часа: на ${label} ${row.item_id} в ${row.time} — при допуске ±${tolerance} мин Hub может их спутать`,
        },
        page_text: `посты ближе часа — ${row.item_id} в ${row.time}`,
      })
    }
  }
  // Порог не задан — серое, поэтому последним: янтарь выше него.
  if (thresholdUnset) {
    const text = 'порог «слишком рано» не задан'
    checked.push({ warning: { kind: 'threshold_unset', text }, page_text: text })
  }
  return checked
}

export function planWarnings(context: FactsContext, candidate: RowCandidate): PlanWarning[] {
  return checkedWarnings(context, candidate).map((checked) => checked.warning)
}

/**
 * The check of one future row (`rows:check`): the one sentence under the «В план» form —
 * the first warning, or «Повторов нет» — and the same without the page name, `page_text`,
 * from which the window says several chosen pages in one line.
 */
export function checkLine(context: FactsContext, candidate: RowCandidate) {
  const checked = checkedWarnings(context, candidate)
  const warnings = checked.map((entry) => entry.warning)
  const [first] = checked
  if (first) {
    return {
      tone: first.warning.kind === 'threshold_unset' ? ('muted' as const) : ('attention' as const),
      text: capitalize(first.warning.text),
      page_text: first.page_text,
      warnings,
    }
  }
  const label = accountOf(context.model, candidate.account).label
  const last = candidate.item_id
    ? lastPlacedOn(context, candidate.item_id, candidate.account, candidate.date, candidate.row_id)
    : null
  const since = last ? sincePhrase(context, last, candidate.date) : null
  return {
    tone: 'muted' as const,
    text: since ? `Повторов нет · на ${label} ${since}` : `Повторов нет · на ${label} ещё не было`,
    page_text: since ?? 'не было',
    warnings,
  }
}

/** Instant of a row slot, for ordering rows by time within a day. */
export function slotOrder(date: LocalDate, time: LocalTime | null): string {
  return time ? mskInstant(date, time) : mskInstant(date, '00:00')
}
