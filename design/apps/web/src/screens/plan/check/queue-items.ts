import type {
  Account,
  CheckCase,
  CheckList,
  IntegrationLine,
  UnverifiedRow,
} from '@contentops/contracts'
import type { CaseGroup } from './case-groups'
import type { HubLines } from './hub-lines'

/**
 * Строки виртуального списка «Сверить»: заголовки страниц, случаи и внизу одна серая
 * строка «Hub не смог проверить N». Высоты фиксированы (DESIGN §7.3): строка случая 64.
 * Пустая очередь — одна строка «Сверять нечего» на месте случаев, серая строка остаётся.
 */

type Unverified = CheckList['unverified']

export type QueueItem =
  | { kind: 'group'; key: string; account: Account; line: IntegrationLine | null; first: boolean }
  | { kind: 'case'; key: string; entry: CheckCase }
  | { kind: 'unverified'; key: string; unverified: Unverified; open: boolean }
  | { kind: 'reason'; key: string; reason: string; count: number; open: boolean }
  | { kind: 'unverified-row'; key: string; row: UnverifiedRow }
  | { kind: 'rows-pending'; key: string }
  | { kind: 'empty'; key: string; filtered: boolean }

const HEIGHT: Record<QueueItem['kind'], number> = {
  group: 52,
  case: 64,
  unverified: 56,
  reason: 40,
  'unverified-row': 44,
  'rows-pending': 44,
  empty: 96,
}

/** Первый заголовок стоит без отступа сверху: 40 вместо 52. */
export function queueItemHeight(item: QueueItem): number {
  return item.kind === 'group' && item.first ? 40 : HEIGHT[item.kind]
}

export interface UnverifiedState {
  /** «Почему» раскрыто. */
  open: boolean
  /** Раскрытые причины. */
  reasons: readonly string[]
}

interface QueueInput {
  groups: readonly CaseGroup[]
  hubLines: HubLines
  unverified: Unverified | null
  state: UnverifiedState
  /** Строки «не проверено»; `undefined` — ещё грузятся. */
  rows: readonly UnverifiedRow[] | undefined
  /** Случаи есть, но все скрыты чипами: «По этим фильтрам ничего · Сбросить». */
  filtered: boolean
}

function unverifiedItems(input: QueueInput): QueueItem[] {
  const { unverified, state, rows } = input
  if (!unverified || unverified.total === 0) {
    return []
  }
  const items: QueueItem[] = [
    { kind: 'unverified', key: 'unverified', unverified, open: state.open },
  ]
  if (!state.open) {
    return items
  }
  for (const group of unverified.groups) {
    const open = state.reasons.includes(group.reason)
    items.push({ kind: 'reason', key: `reason:${group.reason}`, ...group, open })
    if (!open) {
      continue
    }
    if (!rows) {
      items.push({ kind: 'rows-pending', key: `pending:${group.reason}` })
      continue
    }
    for (const row of rows.filter((candidate) => candidate.reason === group.reason)) {
      items.push({ kind: 'unverified-row', key: `row:${row.id}`, row })
    }
  }
  return items
}

export function buildQueue(input: QueueInput): QueueItem[] {
  if (input.groups.length === 0) {
    return [{ kind: 'empty', key: 'empty', filtered: input.filtered }, ...unverifiedItems(input)]
  }
  const items: QueueItem[] = input.groups.flatMap((group, index): QueueItem[] => [
    {
      kind: 'group',
      key: `group:${group.account.code}`,
      account: group.account,
      line: input.hubLines.byAccount.get(group.account.code) ?? null,
      first: index === 0,
    },
    ...group.cases.map((entry): QueueItem => ({ kind: 'case', key: entry.id, entry })),
  ])
  return [...items, ...unverifiedItems(input)]
}
