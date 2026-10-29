import { formatNumber, type LegacyProgress, type LegacyRoot, plural } from '@contentops/contracts'
import { Progress } from '@contentops/ui/components/progress'
import { StatusWord } from '@contentops/ui/components/status-word'
import { cn } from '@contentops/ui/lib/utils'
import { ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'

function foldersWord(count: number): string {
  return plural(count, ['папка', 'папки', 'папок'])
}

/** «Разобрано 973 папки из 1 200 · старых имён 30 · не разобрано 0». */
function progressText(progress: LegacyProgress): string {
  return [
    `Разобрано ${formatNumber(progress.processed_folders)} ${foldersWord(progress.processed_folders)} из ${formatNumber(progress.total_folders)}`,
    `старых имён ${formatNumber(progress.old_names)}`,
    `не разобрано ${formatNumber(progress.unresolved)}`,
  ].join(' · ')
}

/** «принято 74 · старых имён 3 · спорных 3 · ждёт 0»; у корней, где разбор идёт, — «идут». */
function rootText(root: LegacyRoot): string {
  const value = (count: number | null) => (count === null ? '—' : formatNumber(count))
  return [
    `принято ${value(root.accepted)}`,
    `старых имён ${value(root.old_names)}`,
    `спорных ${formatNumber(root.disputed)}`,
    root.waiting === null ? 'идут' : `ждёт ${formatNumber(root.waiting)}`,
  ].join(' · ')
}

/** Доля разобранного в корне для полоски 160 × 6; у корней «идут» — без полоски. */
function rootShare(root: LegacyRoot): number | null {
  if (root.accepted === null || root.waiting === null) {
    return null
  }
  const total = root.accepted + root.disputed + root.waiting
  return total === 0 ? 100 : Math.round((root.accepted / total) * 100)
}

/**
 * Строка хода импорта (DESIGN §4.9): одна строка; нажатие раскрывает корни в порядке
 * SPEC с полоской 160 × 6. Если импорт стоит — ▲ с причиной прямо в строке.
 */
export function ImportLine({ progress }: { progress: LegacyProgress }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="-mx-2 flex h-10 items-center gap-2 rounded-lg px-2 text-left transition-colors duration-120 hover:bg-accent"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            'size-4 shrink-0 text-ink-3 transition-transform duration-120',
            open && 'rotate-90',
          )}
        />
        <span className="truncate tabular-nums">{progressText(progress)}</span>
        {progress.stalled ? (
          <StatusWord sign="trouble" className="ml-2">
            {progress.stalled}
          </StatusWord>
        ) : null}
      </button>
      {open ? (
        <ul className="flex flex-col gap-1 pb-2 pl-6">
          {progress.roots.map((root) => {
            const share = rootShare(root)
            return (
              <li
                key={root.root}
                className="grid h-8 grid-cols-[18rem_10rem_1fr] items-center gap-4"
              >
                <span className="truncate">{root.root}</span>
                {share === null ? (
                  <span />
                ) : (
                  <Progress
                    value={share}
                    aria-label={`${root.root}: ${share} %`}
                    className="h-1.5 w-40"
                  />
                )}
                <span className="truncate text-muted-foreground text-sm tabular-nums">
                  {rootText(root)}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
