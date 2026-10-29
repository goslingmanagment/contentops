import { formatNumber, ITEM_TYPE_INFO, plural } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import type { GroupHeaderState } from '@contentops/ui/components/grouped-virtual-grid'
import type { SearchGroup } from './search-groups'

/** «у трёх папок»: малые числа словами, как в речи. */
const GENITIVE: Readonly<Record<number, string>> = { 2: 'двух', 3: 'трёх', 4: 'четырёх' }

function foldersText(count: number): string {
  return `${GENITIVE[count] ?? formatNumber(count)} ${plural(count, ['папки', 'папок', 'папок'])}`
}

interface SearchGroupHeaderProps {
  group: SearchGroup
  state: GroupHeaderState
  /** Номер, который был у нескольких папок: «PPV-032». */
  oldNumber: string | null
  /** «ещё 12 →»: вся группа, чип «Тип» включается сам. */
  onMore: () => void
}

/**
 * Заголовок группы результатов 16/22: «PPV 14 · ещё 9 →» или «Старый номер PPV-032 был
 * у трёх папок». Нажатие на название выделяет показанное в группе (§3.3).
 */
export function SearchGroupHeader({ group, state, oldNumber, onMore }: SearchGroupHeaderProps) {
  const title =
    group.kind === 'old-number' ? (
      `Старый номер ${oldNumber ?? ''} был у ${foldersText(group.items.length)}`
    ) : (
      <>
        {ITEM_TYPE_INFO[group.kind].folder}
        <span className="ml-1.5 font-normal text-ink-3 text-sm tabular-nums">
          {formatNumber(group.total)}
        </span>
      </>
    )
  return (
    <div className="flex h-full items-end gap-2 px-2 pb-3">
      <h2 className="text-lg">
        <button
          type="button"
          onClick={state.selectAll}
          title="Выделить показанное в группе"
          className="rounded-sm transition-colors duration-120 hover:text-primary-ink"
        >
          {title}
        </button>
      </h2>
      {group.more > 0 ? (
        <>
          <span aria-hidden className="text-ink-3">
            ·
          </span>
          <Button variant="link" size="sm" onClick={onMore} className="text-base">
            ещё {formatNumber(group.more)} →
          </Button>
        </>
      ) : null}
    </div>
  )
}
