import { formatNumber } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import type { GroupHeaderState } from '@contentops/ui/components/grouped-virtual-grid'
import { type BacklogGroup, groupLabel } from './backlog'

interface GroupHeaderProps {
  group: BacklogGroup
  state: GroupHeaderState
  /** «показать» у свёрнутых фупов и «скрыть» у раскрытых фупов и «Уже в плане». */
  onToggle?: () => void
}

/**
 * Заголовок группы 16/22 (DESIGN §4.3): «PPV 4», «Фупы 488 · показать»; число — 13 серым,
 * как у заголовков групп в других списках. Нажатие на название выделяет всю группу
 * (§3.3); у свёрнутой группы выделять нечего.
 */
export function GroupHeader({ group, state, onToggle }: GroupHeaderProps) {
  const title = (
    <>
      {groupLabel(group.kind)}
      <span className="ml-1.5 font-normal text-ink-3 text-sm tabular-nums">
        {formatNumber(group.total)}
      </span>
    </>
  )
  return (
    <div className="flex h-full items-end gap-2 px-2 pb-3">
      {group.collapsed ? (
        <h2 className="text-lg">{title}</h2>
      ) : (
        <h2 className="text-lg">
          <button
            type="button"
            onClick={state.selectAll}
            title="Выделить всю группу"
            className="rounded-sm transition-colors duration-120 hover:text-primary-ink"
          >
            {title}
          </button>
        </h2>
      )}
      {onToggle ? (
        <>
          <span aria-hidden className="text-ink-3">
            ·
          </span>
          <Button variant="link" size="sm" onClick={onToggle} className="text-base">
            {group.collapsed ? 'показать' : 'скрыть'}
          </Button>
        </>
      ) : null}
    </div>
  )
}
