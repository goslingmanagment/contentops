import { addDays, mskInstant, weekdayIndex } from '../clock'
import type { CatalogEntry } from '../domain/catalog'
import type { AccountCode, LocalDate, LocalTime } from '../domain/common'
import type { ItemId } from '../domain/item-type'
import { formatItemId } from '../domain/item-type'
import { numberRange } from './catalog-generator'
import { DIANA, NIKITA, type WeekContext } from './lora-plan-week'
import { PERSON } from './people'
import type { BuiltRow, RowSpec } from './plan-builder'

/**
 * Three past weeks 31.08–20.09 laid out by the norm, with the outcomes the screens need:
 * «Hub не смог проверить 38» (31 on Fansly 3, 7 on OF Free while Hub is down),
 * «Решённые · 12», and last week's «пусто 3» and «пропущено 2».
 */

const FIRST_DAY: LocalDate = '2026-08-31'
const DAYS = 21
const at = (date: LocalDate, time: LocalTime) => mskInstant(date, time)

/** Empty places of last week: no row was ever put there. */
const SKIPPED = new Set(['lora-1|fyp|2026-09-19', 'lora-2|fyp|2026-09-20', 'lora-3|fyp|2026-09-20'])
/** Rows the КМ never marked: ▲ «пропущено». */
const MISSED = new Set(['lora-vip-of|wall|2026-09-16', 'lora-1|wall|2026-09-18'])
/** F2 FYP rows answered by «Это оно» in the last 14 days. */
const RESOLVED_FROM: LocalDate = '2026-09-08'
const MISMATCH_DAY: LocalDate = '2026-09-15'

export interface HistoryPools {
  fypF1: ItemId[]
  fypShared: ItemId[]
  walls: ItemId[]
  life: ItemId[]
  vip: ItemId[]
  free: ItemId[]
}

export function historyPools(entries: readonly CatalogEntry[]): HistoryPools {
  const ids = (type: 'fyp' | 'set', numbers: number[]) =>
    numbers.map((number) => formatItemId(type, number))
  const life = entries
    .filter((entry) => entry.type === 'life' && (entry.life_chat_count ?? 0) > 0)
    .filter((entry) => entry.id !== 'LIFE-191' && entry.id !== 'LIFE-141')
    .sort((left, right) => right.id.localeCompare(left.id))
    .slice(0, 3)
    .map((entry) => entry.id)
  const vip = entries
    .filter(
      (entry) =>
        entry.type === 'ppv' &&
        entry.ppv_kind === 'bundle' &&
        !entry.second_person &&
        !['PPV-032', 'PPV-061', 'PPV-067'].includes(entry.id),
    )
    .filter((entry) => Number(entry.id.slice(4)) >= 40 && Number(entry.id.slice(4)) <= 66)
    .map((entry) => entry.id)
    .slice(0, 15)
  return {
    fypF1: ids('fyp', numberRange(751, 762)),
    fypShared: ids('fyp', numberRange(769, 789)),
    walls: ids('set', numberRange(43, 64, [50])),
    life,
    vip,
    free: ids('set', numberRange(30, 41)),
  }
}

function take(pool: ItemId[], index: number): ItemId {
  const id = pool[index % pool.length]
  if (!id) throw new Error('Пустой набор объектов для истории плана')
  return id
}

interface DayCounters {
  f1Fyp: number
  shared: number
  wall: number
  life: number
  vip: number
  free: number
  f3Confirmed: number
  freeConfirmed: number
}

/** Rows of the three past weeks with their outcomes. */
export function buildPastWeeks(context: WeekContext, pools: HistoryPools): BuiltRow[] {
  const { row, evidence, issued } = context
  const built: BuiltRow[] = []
  const counters: DayCounters = {
    f1Fyp: 0,
    shared: 0,
    wall: 0,
    life: 0,
    vip: 0,
    free: 0,
    f3Confirmed: 0,
    freeConfirmed: 0,
  }

  const scheduled = (date: LocalDate) => ({
    kind: 'scheduled' as const,
    at: at(addDays(date, -1), '22:00'),
  })
  const posted = (date: LocalDate, time: LocalTime, by: string) => ({
    kind: 'posted' as const,
    at: at(date, time),
    by,
  })
  const exact = (
    item: ItemId,
    account: AccountCode,
    date: LocalDate,
    slot: LocalTime,
    postedAt: LocalTime,
    uniq?: number,
  ) =>
    evidence.hubExact(at(date, postedAt), 'file_name', issued(item, account, date, slot, { uniq }))

  const push = (spec: RowSpec) => {
    if (SKIPPED.has(`${spec.account}|${spec.surface}|${spec.date}`)) return
    const missed = MISSED.has(`${spec.account}|${spec.surface}|${spec.date}`)
    built.push(row(missed ? { ...spec, mark: undefined, evidence: [] } : spec))
  }

  for (let offset = 0; offset < DAYS; offset++) {
    const date = addDays(FIRST_DAY, offset)
    const weekday = weekdayIndex(date)
    const wall = take(pools.walls, counters.wall++)
    const shared = take(pools.fypShared, counters.shared++)

    if ([1, 3, 5, 6].includes(weekday)) {
      const item = take(pools.fypF1, counters.f1Fyp++)
      push({
        date,
        time: '03:00',
        account: 'lora-1',
        surface: 'fyp',
        item,
        assignee: PERSON.diana,
        mark: scheduled(date),
        evidence: [exact(item, 'lora-1', date, '03:00', '03:03')],
        stats: { views: 400 + offset * 37, likes: 30 + offset, on: '2026-09-22' },
      })
    }
    push({
      date,
      time: '20:00',
      account: 'lora-1',
      surface: 'wall',
      item: wall,
      assignee: PERSON.diana,
      mark: scheduled(date),
      evidence: [exact(wall, 'lora-1', date, '20:00', '20:02')],
    })
    push({
      date,
      time: '03:00',
      account: 'lora-2',
      surface: 'fyp',
      item: shared,
      version: { no: 1, level: 'soft' },
      assignee: PERSON.diana,
      mark: scheduled(date),
      evidence: sharedFypEvidence(context, shared, date),
      stats: { views: 700 + offset * 41, likes: 44 + offset, on: '2026-09-22' },
    })
    push({
      date,
      time: '20:00',
      account: 'lora-2',
      surface: 'wall',
      item: wall,
      assignee: PERSON.diana,
      mark: scheduled(date),
      evidence: [exact(wall, 'lora-2', date, '20:00', '20:01')],
    })
    const f3Evidence = (item: ItemId, slot: LocalTime, postedAt: LocalTime, uniq?: number) =>
      counters.f3Confirmed++ < 11 ? [exact(item, 'lora-3', date, slot, postedAt, uniq)] : []
    push({
      date,
      time: '03:00',
      account: 'lora-3',
      surface: 'fyp',
      item: shared,
      version: { no: 2, level: 'trim' },
      assignee: PERSON.diana,
      mark: scheduled(date),
      evidence: f3Evidence(shared, '03:00', '03:02', 2),
    })
    push({
      date,
      time: '20:00',
      account: 'lora-3',
      surface: 'wall',
      item: wall,
      assignee: PERSON.diana,
      mark: scheduled(date),
      evidence: f3Evidence(wall, '20:00', '20:03'),
    })

    if (weekday === 1) {
      const life = take(pools.life, counters.life++)
      for (const account of ['lora-1', 'lora-2', 'lora-3'] as const) {
        push({
          date,
          time: '11:40',
          account,
          surface: 'vault',
          item: life,
          assignee: PERSON.diana,
          album: 'Lifestyle',
          mark: posted(date, '11:45', PERSON.diana),
          evidence: [evidence.hubExact(at(date, '11:45'), 'album')],
        })
      }
    }
    if (weekday <= 4) {
      const item = take(pools.vip, counters.vip++)
      push({
        date,
        time: '20:00',
        account: 'lora-vip-of',
        surface: 'wall',
        item,
        assignee: PERSON.nikita,
        mark: posted(date, '20:04', PERSON.nikita),
        evidence: [evidence.manualConfirm(NIKITA, at(addDays(date, 1), '11:00'), 'pair')],
      })
    }
    if ([1, 3, 5, 6].includes(weekday)) {
      const item = take(pools.free, counters.free++)
      const confirmed = counters.freeConfirmed++ < 5
      push({
        date,
        time: '19:00',
        account: 'lora-of',
        surface: 'wall',
        item,
        assignee: PERSON.nikita,
        mark: posted(date, '19:03', PERSON.nikita),
        evidence: confirmed
          ? [evidence.manualConfirm(NIKITA, at(addDays(date, 1), '11:10'), 'pair')]
          : [],
      })
    }
  }
  return built
}

/** F2 FYP evidence: exact by name, or a candidate confirmed by Диана in the last 14 days. */
function sharedFypEvidence(context: WeekContext, item: ItemId, date: LocalDate) {
  const { evidence, issued } = context
  if (date < RESOLVED_FROM) {
    return [
      evidence.hubExact(
        at(date, '03:04'),
        'file_name',
        issued(item, 'lora-2', date, '03:00', { uniq: 1 }),
      ),
    ]
  }
  const confirmAt = at(addDays(date, 1), '10:20')
  const hub =
    date === MISMATCH_DAY
      ? evidence.hubMismatch(at(date, '03:05'), 'duration', '0:09', '0:11')
      : evidence.hubCandidate(at(date, '03:05'), 5, '1 видео 0:09 = 0:09 · имя не наше')
  return [hub, evidence.manualConfirm(DIANA, confirmAt, 'pair')]
}
