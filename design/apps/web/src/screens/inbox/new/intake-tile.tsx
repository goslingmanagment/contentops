import type { InboxGroup } from '@contentops/contracts'
import { Checkbox } from '@contentops/ui/components/checkbox'
import { FolderTab } from '@contentops/ui/components/folder-tile'
import { cn } from '@contentops/ui/lib/utils'
import { GroupCover } from '../shared/group-cover'
import { GroupStateLine } from '../shared/group-state-line'
import type { GroupStateView } from '../shared/group-texts'

interface IntakeTileProps {
  group: InboxGroup
  meta: string
  state: GroupStateView
  selected: boolean
  /** Выбрано несколько: галочки у выбранных видны всегда, а не только при наведении. */
  multi: boolean
  onToggle: (key: string) => void
}

/**
 * Плитка группы (DESIGN §4.8), как папка раздела ≈211 × 206: язычок и мозаика первых
 * кадров, название так, как его написала модель, — до двух строк, как у плитки объекта,
 * серая строка «Кастом · сегодня 11:02 · 1,9 ГБ» и состояние. Плитки ряда одной высоты:
 * короткое название оставляет место внизу, а не между строками. Выделение — как у
 * плитки объекта (§4.2): подложка и рамка 2 px.
 */
export function IntakeTile({ group, meta, state, selected, multi, onToggle }: IntakeTileProps) {
  return (
    <div
      data-selected={selected}
      className="group/tile relative flex h-full min-w-0 flex-col gap-2.5 rounded-2xl p-2 pb-1.5 text-center transition-colors duration-120 hover:bg-accent data-[selected=true]:bg-primary-tint data-[selected=true]:ring-2 data-[selected=true]:ring-primary data-[selected=true]:ring-inset"
    >
      <div className="relative pt-2.5">
        <FolderTab className="absolute top-0 left-3 h-2.5 w-16" />
        <div className="relative rounded-2xl bg-folder p-1.5">
          <GroupCover group={group} />
        </div>
        <TileCheck
          checked={selected}
          pinned={selected && multi}
          label={group.title}
          onToggle={() => onToggle(group.id)}
        />
      </div>
      <div className="flex min-w-0 flex-col items-center px-1">
        <p className="line-clamp-2 w-full break-words text-lg leading-6" title={group.title}>
          {group.title}
        </p>
        <p className="w-full truncate text-muted-foreground text-sm">{meta}</p>
        {/* Состояние решает судьбу группы: длинное слово переносится, а не обрезается. */}
        <div className="flex min-h-6 w-full items-center justify-center py-0.5">
          <GroupStateLine view={state} wrap="center" />
        </div>
      </div>
    </div>
  )
}

/** Галочка при наведении: выбрать, не открывая (§3.3). */
function TileCheck({
  checked,
  pinned,
  label,
  onToggle,
}: {
  checked: boolean
  pinned: boolean
  label: string
  onToggle: () => void
}) {
  return (
    <span
      className={cn(
        'absolute top-5 left-3.5 flex size-6 items-center justify-center rounded-md bg-background/90 opacity-0 shadow-xs transition-opacity duration-120 group-hover/tile:opacity-100',
        pinned && 'opacity-100',
      )}
    >
      <Checkbox
        checked={checked}
        aria-label={`Выбрать «${label}»`}
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
      />
    </span>
  )
}
