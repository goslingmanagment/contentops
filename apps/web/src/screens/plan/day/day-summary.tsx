import { type Account, formatNumber, type PlanDay, plural } from '@contentops/contracts'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { StatusWord } from '@contentops/ui/components/status-word'
import { isDoneRow } from '../shared/plan-text'

interface DaySummaryProps {
  day: PlanDay
  accounts: readonly Account[]
}

function placesWord(count: number): string {
  return `${formatNumber(count)} ${plural(count, ['место', 'места', 'мест'])} нормы`
}

/**
 * Панель без выделения (DESIGN §3.4): по каждой странице — сколько строк, сколько
 * сделано, где нужен человек и сколько мест нормы пусто.
 */
export function DaySummary({ day, accounts }: DaySummaryProps) {
  const active = day.rows.filter((row) => row.cancelled === null)
  return (
    <InfoSection
      title={`${formatNumber(active.length)} ${plural(active.length, ['строка', 'строки', 'строк'])} в дне`}
    >
      <ul className="flex flex-col">
        {accounts.map((account) => {
          const rows = active.filter((row) => row.account === account.code)
          const gaps = day.gaps.filter((gap) => gap.account === account.code).length
          if (rows.length === 0 && gaps === 0) {
            return null
          }
          const done = rows.filter(isDoneRow).length
          const trouble = rows.filter((row) => row.verdict.sign === 'trouble').length
          const turn = rows.filter((row) => row.verdict.sign === 'turn').length
          return (
            <li key={account.code} className="flex min-h-9 items-center gap-3 py-1">
              <span className="w-20 shrink-0 text-base">{account.label}</span>
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
                <span className="text-muted-foreground tabular-nums">
                  сделано {formatNumber(done)} из {formatNumber(rows.length)}
                </span>
                {trouble > 0 ? (
                  <StatusWord sign="trouble">{formatNumber(trouble)}</StatusWord>
                ) : null}
                {turn > 0 ? <StatusWord sign="turn">{formatNumber(turn)}</StatusWord> : null}
                {gaps > 0 ? <span className="text-ink-3">{placesWord(gaps)}</span> : null}
              </span>
            </li>
          )
        })}
      </ul>
    </InfoSection>
  )
}
