import { daysBetween, mskInstant } from '@contentops/contracts/clock'
import type { RowCheckResult } from '@contentops/contracts/commands/plan'
import type { LocalDate, LocalTime } from '@contentops/contracts/domain/common'
import type { ItemId } from '@contentops/contracts/domain/item-type'
import type { PlacementLevel, PlacementVerdict } from '@contentops/contracts/domain/placement'
import type { PlanWarning } from '@contentops/contracts/domain/plan'
import {
  capitalize,
  formatDate,
  formatDaysAgo,
  formatDaysSpan,
  formatShortDay,
  formatWeekdayShort,
} from '@contentops/contracts/format'
import { isInPlanLevel } from '@contentops/contracts/placement'
import { itemTypeOfDb, publicIdOf } from '../catalog/ids'
import { accountOf, type DbItemType, type DbSurface, type RowRecord } from './records'
import { evaluatePlacementRecord, evaluateRow, type PlanState, threshold, todayOf } from './state'

/**
 * The rules of putting a row into the plan (SPEC §7, DESIGN §4.13) — the same for a person in
 * «В план» and for an agent by API (`rows:check`, `rows?dry_run=1`). Hard refusals: the type
 * goes only to its surfaces, the second person never to OnlyFans (an unchecked legacy object is
 * asked once). Everything else is a warning and «Поставить» stays available: already in this
 * page's plan, too early by the threshold, two posts in one time, posts closer than two
 * tolerances, the threshold not set.
 */

/** A future (or an existing) row as the rules see it. */
export interface Candidate {
  row_id: string | null
  item: {
    id: string
    type: DbItemType
    number: number
    has_second_person: boolean | null
  } | null
  /** «Под монтаж»: the raw object the row waits a montage from. */
  montage_from: { id: string } | null
  account: string
  surface: DbSurface
  date: LocalDate
  time: LocalTime | null
  release_id: string | null
  /** «Уже залито», «выложено вне плана», «Было» — created already marked. */
  marked: boolean
}

/** Types by surface (SPEC §7): the table «тип ставится только на свои поверхности». */
const SURFACE_TYPES: Record<DbSurface, readonly DbItemType[]> = {
  wall: ['PPV', 'SET', 'LIFE'],
  fyp: ['FYP'],
  vault: ['PPV', 'SXT', 'LIFE'],
  story: ['PPV'],
  mass_dm: ['PPV'],
}

const SURFACE_WORD: Record<DbSurface, string> = {
  wall: 'на стену',
  fyp: 'в фуп',
  vault: 'в vault',
  story: 'в сториз',
  mass_dm: 'в рассылку',
}

const TYPE_WORD: Record<DbItemType, string> = {
  PPV: 'PPV',
  SET: 'сет',
  SXT: 'секстинг',
  CUS: 'кастом',
  FYP: 'фуп',
  LIFE: 'лайф',
  RAW: 'сырьё',
  PRM: 'промо-подборка',
}

export interface Refusal {
  code: 'not_found' | 'invalid_request' | 'second_person_onlyfans'
  text: string
  /** The legacy object was never checked for a second person: ask once (SPEC §7). */
  question?: { kind: 'second_person'; item_id: ItemId }
}

/** The one hard rule and the surface table; `null` — the row may be put. */
export function refusalOf(state: PlanState, candidate: Candidate): Refusal | null {
  const page = state.view.accounts.find((account) => account.code === candidate.account)
  if (!page) return { code: 'not_found', text: `Страницы ${candidate.account} нет` }
  const item = candidate.item
  if (!item) {
    return candidate.montage_from ? null : { code: 'invalid_request', text: 'Не выбран объект' }
  }
  if (item.type === 'CUS') {
    return {
      code: 'invalid_request',
      text: 'кастом в план не ставится — он выходит как PPV',
    }
  }
  if (candidate.surface === 'fyp' && page.platform === 'onlyfans') {
    return { code: 'invalid_request', text: 'фупов на OnlyFans нет' }
  }
  if (!SURFACE_TYPES[candidate.surface].includes(item.type)) {
    return {
      code: 'invalid_request',
      text: `${TYPE_WORD[item.type]} ${SURFACE_WORD[candidate.surface]} не ставится`,
    }
  }
  // Stories are put only as the teaser of a PPV release (decision 28.09.2026); a story that
  // already went out is recorded marked.
  if (candidate.surface === 'story' && !candidate.release_id && !candidate.marked) {
    return { code: 'invalid_request', text: 'сториз ставится только тизером выпуска PPV' }
  }
  if (page.platform === 'onlyfans') {
    if (item.has_second_person === true) {
      return { code: 'second_person_onlyfans', text: 'нельзя: второй человек в кадре' }
    }
    if (item.has_second_person === null) {
      return {
        code: 'second_person_onlyfans',
        text: 'есть второй человек в кадре? Без ответа на OnlyFans не ставится',
        question: { kind: 'second_person', item_id: publicIdOf(item.type, item.number) },
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/**
 * Rows of the same object on the same page and surface that still wait in the plan — on any
 * day, the same and past ones included (a missed row, a row «в планировщике»); a row waiting
 * for a montage from the same raw counts too. The nearest to the candidate date goes first.
 */
export function samePlaceRows(state: PlanState, candidate: Candidate): RowRecord[] {
  const object = candidate.item?.id ?? null
  const montage = candidate.montage_from?.id ?? null
  if (!object && !montage) return []
  const distance = (row: RowRecord) => Math.abs(daysBetween(candidate.date, row.slot_date))
  return state.rows
    .filter(
      (row) =>
        row.id !== candidate.row_id &&
        !row.cancelled_at &&
        row.account === candidate.account &&
        row.surface === candidate.surface &&
        ((object !== null && row.item_id === object) ||
          (montage !== null && row.input_item_id === montage)) &&
        isInPlanLevel(evaluateRow(state, row).level),
    )
    .sort(
      (left, right) =>
        distance(left) - distance(right) || left.slot_date.localeCompare(right.slot_date),
    )
}

/**
 * «Слишком рано» counts placements of the exact and candidate levels (SPEC §5): a KM mark
 * alone or a legacy claim does not; the vault never does, and rows of one release are no
 * repeat of each other.
 */
const TOO_EARLY_LEVELS: ReadonlySet<PlacementLevel> = new Set<PlacementLevel>([
  'confirmed_exact',
  'confirmed_hub_unmarked',
  'confirmed_manual',
  'confirmed_earlier',
  'confirmed_reupload',
  'candidate',
  'candidates_multiple',
  'partial_match',
  'mismatch',
  'conflict',
  'surface_unknown',
])

/** Last date the object went out on the page up to the date; the candidate row not counted. */
export function lastPlacedOn(
  state: PlanState,
  itemId: string,
  account: string,
  until: LocalDate,
  except: { row_id: string | null; release_id: string | null },
): LocalDate | null {
  let last: LocalDate | null = null
  const consider = (verdict: PlacementVerdict) => {
    if (!TOO_EARLY_LEVELS.has(verdict.level) || !verdict.date || verdict.date > until) return
    if (!last || verdict.date > last) last = verdict.date
  }
  const counted = (row: RowRecord | undefined) =>
    !row ||
    (row.id !== except.row_id &&
      (except.release_id === null || row.release_id !== except.release_id))
  for (const row of state.rows) {
    if (row.item_id !== itemId || row.account !== account || row.surface === 'vault') continue
    if (!counted(row)) continue
    consider(evaluateRow(state, row))
  }
  for (const placement of state.placements) {
    if (placement.plan_row_id || placement.item_id !== itemId) continue
    if (placement.account !== account || placement.surface === 'vault') continue
    consider(evaluatePlacementRecord(state, placement))
  }
  return last
}

function minutesOf(time: LocalTime): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
}

/**
 * «было 13.09 — 9 дней назад» when the row is for today; otherwise days are counted to the row
 * date and said so: «было 12.08, к сб 26 будет 45 дней». Another year gets its year.
 */
export function sincePhrase(state: PlanState, last: LocalDate, date: LocalDate): string {
  const now = todayOf(state)
  const when = formatDate(last, now)
  const days = daysBetween(last, date)
  if (date === now || days >= 365) return `было ${when} — ${formatDaysAgo(daysBetween(last, now))}`
  return `было ${when}, к ${formatShortDay(date)} будет ${formatDaysSpan(days)}`
}

function slotParts(state: PlanState, row: RowRecord) {
  const day = `${formatWeekdayShort(row.slot_date)} ${formatDate(row.slot_date, todayOf(state))}`
  const word = evaluateRow(state, row).word
  const waiting = row.manifest_id === null && (row.expected_type || row.expected_role)
  const status = waiting ? 'ждёт монтаж' : word === 'в плане' ? null : word
  return { slot: `${day}, ${row.slot_time ?? 'весь день'}`, state: status }
}

interface CheckedWarning {
  warning: PlanWarning
  /** The same without the page name, for one line over several pages. */
  page_text: string
}

function itemIdOf(row: RowRecord): ItemId | null {
  return row.item_type && row.item_number !== null
    ? publicIdOf(row.item_type, row.item_number)
    : null
}

function checkedWarnings(state: PlanState, candidate: Candidate): CheckedWarning[] {
  const checked: CheckedWarning[] = []
  const label = accountOf(state.view, candidate.account).label
  const type = candidate.item ? itemTypeOfDb(candidate.item.type) : null
  const tolerance =
    threshold(state, 'time_tolerance_min', { account: candidate.account, type }) ?? 30
  const [twin] = samePlaceRows(state, candidate)
  if (twin) {
    const { slot, state: status } = slotParts(state, twin)
    checked.push({
      warning: {
        kind: 'already_planned',
        date: twin.slot_date,
        text: `уже в плане: ${label} · ${[slot, status].filter(Boolean).join(' · ')}`,
      },
      page_text: `уже в плане на ${slot}${status ? ` (${status})` : ''}`,
    })
  }
  let thresholdUnset = false
  if (candidate.item && candidate.surface !== 'vault') {
    const earlyDays = threshold(state, 'too_early_days', { account: candidate.account, type })
    const last = lastPlacedOn(state, candidate.item.id, candidate.account, candidate.date, {
      row_id: candidate.row_id,
      release_id: candidate.release_id,
    })
    if (earlyDays === null) {
      thresholdUnset = true
    } else if (last && daysBetween(last, candidate.date) < earlyDays) {
      const since = sincePhrase(state, last, candidate.date)
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
  for (const row of state.rows) {
    if (row.id === candidate.row_id || row.cancelled_at || row.account !== candidate.account)
      continue
    const other = itemIdOf(row)
    if (row.slot_date !== candidate.date || !row.slot_time || !candidate.time || !other) continue
    if (row.item_id === candidate.item?.id) continue
    if (candidate.release_id && row.release_id === candidate.release_id) continue
    const gap = Math.abs(minutesOf(row.slot_time) - minutesOf(candidate.time))
    if (gap === 0) {
      checked.push({
        warning: {
          kind: 'same_time',
          other_item: other,
          text: `в ${candidate.time} на ${label} уже стоит ${other} — два поста в одно время`,
        },
        page_text: `в ${candidate.time} уже стоит ${other} — два поста в одно время`,
      })
    } else if (gap < tolerance * 2) {
      checked.push({
        warning: {
          kind: 'too_close',
          other_item: other,
          text: `посты ближе часа: на ${label} ${other} в ${row.slot_time} — при допуске ±${tolerance} мин Hub может их спутать`,
        },
        page_text: `посты ближе часа — ${other} в ${row.slot_time}`,
      })
    }
  }
  // The threshold not set is grey, so it goes last: amber goes first.
  if (thresholdUnset) {
    const text = 'порог «слишком рано» не задан'
    checked.push({ warning: { kind: 'threshold_unset', text }, page_text: text })
  }
  return checked
}

export function planWarnings(state: PlanState, candidate: Candidate): PlanWarning[] {
  return checkedWarnings(state, candidate).map((checked) => checked.warning)
}

export type CheckLine = RowCheckResult

/**
 * The check of one future row (`rows:check`): one sentence under the «В план» form — the
 * refusal, the first warning, or «Повторов нет» — and the same without the page name.
 */
export function checkLine(state: PlanState, candidate: Candidate): CheckLine {
  const refusal = refusalOf(state, candidate)
  if (refusal) {
    return {
      tone: 'attention',
      text: capitalize(refusal.text),
      page_text: refusal.text,
      blocked: true,
      warnings: [],
      question: refusal.question ?? null,
    }
  }
  const checked = checkedWarnings(state, candidate)
  const warnings = checked.map((entry) => entry.warning)
  const [first] = checked
  if (first) {
    return {
      tone: first.warning.kind === 'threshold_unset' ? 'muted' : 'attention',
      text: capitalize(first.warning.text),
      page_text: first.page_text,
      blocked: false,
      warnings,
      question: null,
    }
  }
  const label = accountOf(state.view, candidate.account).label
  const last = candidate.item
    ? lastPlacedOn(state, candidate.item.id, candidate.account, candidate.date, {
        row_id: candidate.row_id,
        release_id: candidate.release_id,
      })
    : null
  const since = last ? sincePhrase(state, last, candidate.date) : null
  return {
    tone: 'muted',
    text: since ? `Повторов нет · на ${label} ${since}` : `Повторов нет · на ${label} ещё не было`,
    page_text: since ?? 'не было',
    blocked: false,
    warnings,
    question: null,
  }
}

/** Instant of a row slot, for ordering rows by time within a day. */
export function slotOrder(date: LocalDate, time: LocalTime | null): string {
  return time ? mskInstant(date, time) : mskInstant(date, '00:00')
}
