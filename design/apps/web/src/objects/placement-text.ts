import {
  type Account,
  type AccountCode,
  formatDate,
  type LocalDate,
  type PageSummaryEntry,
} from '@contentops/contracts'
import type { ObjectTileSign } from '@contentops/ui/components/object-tile'
import type { PlacementEntry } from '@contentops/ui/components/placement-line'

/**
 * Где залит объект — словами для плиток, строк и быстрого взгляда (DESIGN §4.2, §4.4).
 * Пара «объект × страница», которой нет в сводке, значит «не видели».
 */

function summaryOn(
  summaries: readonly PageSummaryEntry[] | undefined,
  account: Account,
): PageSummaryEntry | undefined {
  return summaries?.find((entry) => entry.account === account.code)
}

/** Строка «где залито» по страницам: ✓ с датой, ◆ «сверить», серое слово. */
export function placementEntries(
  accounts: readonly Account[],
  summaries: readonly PageSummaryEntry[] | undefined,
  today: LocalDate,
): PlacementEntry[] {
  return accounts.map((account) => {
    const summary = summaryOn(summaries, account)
    if (!summary) {
      return { page: account.label, text: 'не видели' }
    }
    const sign = summary.sign ?? undefined
    if (sign === 'done') {
      return {
        page: account.label,
        sign,
        text: summary.last_on ? formatDate(summary.last_on, today) : summary.word,
      }
    }
    if (sign === 'turn') {
      return { page: account.label, sign, text: 'сверить' }
    }
    const date =
      summary.last_on && sign === undefined ? ` ${formatDate(summary.last_on, today)}` : ''
    return { page: account.label, sign, text: `${summary.word}${date}` }
  })
}

/** «Fansly 1, Fansly 2, Fansly 3» → «Fansly 1–3»: подряд идущие номера одной площадки. */
function compressLabels(labels: readonly string[]): string[] {
  const result: string[] = []
  let run: { prefix: string; from: number; to: number } | null = null
  const flush = () => {
    if (run) {
      result.push(
        run.from === run.to ? `${run.prefix} ${run.from}` : `${run.prefix} ${run.from}–${run.to}`,
      )
      run = null
    }
  }
  for (const label of labels) {
    const match = /^(.*\S)\s+(\d+)$/.exec(label)
    const prefix = match?.[1]
    const number = Number(match?.[2])
    if (prefix && run && run.prefix === prefix && run.to + 1 === number) {
      run.to = number
      continue
    }
    flush()
    if (prefix && Number.isFinite(number)) {
      run = { prefix, from: number, to: number }
    } else {
      result.push(label)
    }
  }
  flush()
  return result
}

/** Третья колонка строки списка: «Fansly 1–3, OF VIP» или «ещё нигде». */
export function placedPagesText(
  accounts: readonly Account[],
  summaries: readonly PageSummaryEntry[] | undefined,
): string {
  const placed = accounts
    .filter((account) => (summaryOn(summaries, account)?.placed_on.length ?? 0) > 0)
    .map((account) => account.label)
  return placed.length > 0 ? compressLabels(placed).join(', ') : 'ещё нигде'
}

function signOn(
  entry: PageSummaryEntry,
  kind: ObjectTileSign['kind'],
  accounts: readonly Account[] | undefined,
): ObjectTileSign {
  const page = accounts?.find((account) => account.code === entry.account)?.label
  return {
    kind,
    label: entry.word,
    hint: page ? `${entry.word} · ${page}` : undefined,
  }
}

/**
 * Знак на плитке — только ◆ или ▲ (DESIGN §4.2): беда сильнее хода. На плитке — слово
 * состояния («сверить», «пропущено»), на узкой плитке — только знак; слово и страница — в
 * подсказке, подробности — в быстром взгляде и в объекте. Слово не сокращается (§5.2).
 * Экран одной страницы («Ещё не залито › Fansly 1») передаёт `page`: знак — только о ней,
 * ▲ «пропущено» на OF VIP на вкладке Fansly 1 не показывается.
 */
export function tileSignOf(
  summaries: readonly PageSummaryEntry[] | undefined,
  accounts?: readonly Account[],
  page?: AccountCode,
): ObjectTileSign | undefined {
  const relevant = page ? summaries?.filter((entry) => entry.account === page) : summaries
  const trouble = relevant?.find((entry) => entry.sign === 'trouble')
  if (trouble) {
    return signOn(trouble, 'trouble', accounts)
  }
  const turn = relevant?.find((entry) => entry.sign === 'turn')
  return turn ? signOn(turn, 'turn', accounts) : undefined
}
