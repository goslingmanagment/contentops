import type { InboxGroup } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { ItemMenuButton, type ItemMenuModel } from '@contentops/ui/components/item-menu'
import { StatusSign } from '@contentops/ui/components/status-sign'
import { Thumb } from '@contentops/ui/components/thumb'
import { cn } from '@contentops/ui/lib/utils'
import { Link } from '@tanstack/react-router'
import { useToday } from '@/data/api-session'
import { itemCoverById } from '@/lib/item-cover'
import { useCurrentModel } from '@/shell/model/model-context'
import { groupKind } from '../shared/draft-cover'
import {
  acceptedLine,
  acceptedSource,
  acceptedTitle,
  daysLeft,
  rejectedLine,
} from './decided-texts'

interface DecidedRowProps {
  group: InboxGroup
  selected: boolean
  restoring: boolean
  onRestore: (id: string) => void
  /** «⋯» принятой строки — меню объекта, в который её приняли. */
  menu: ItemMenuModel | null
}

const ROW =
  'relative flex h-13 min-w-0 items-center gap-3 rounded-lg px-2 transition-colors duration-120 hover:bg-accent data-[selected=true]:bg-primary-tint'

/**
 * Строка «Решённого» (DESIGN §4.10), 52: миниатюра 40 × 40, что стало с группой и кто
 * решил. Принятая строка — ссылка на объект, в «⋯» — его меню («Сменить тип», «Удалить»).
 * У отклонённых — сколько дней осталось и «Вернуть в работу».
 */
export function DecidedRow({ group, selected, restoring, onRestore, menu }: DecidedRowProps) {
  const today = useToday()
  const model = useCurrentModel().code
  const state = group.state
  if (state.kind === 'accepted') {
    const cover = itemCoverById(state.item_id)
    const source = acceptedSource(group)
    return (
      <div data-selected={selected} className={ROW}>
        <Thumb
          seed={cover.seed}
          kind={cover.kind}
          family={cover.family}
          aspect="1:1"
          showCaptions={false}
          className="w-10 shrink-0 rounded-md"
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <StatusSign kind="done" />
            {/* Вся строка ведёт в объект: подложка ссылки растянута на строку. */}
            <Link
              to="/$model/i/$id"
              params={{ model, id: state.item_id }}
              onClick={(event) => event.stopPropagation()}
              className="truncate outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring"
            >
              {acceptedTitle(group, state)}
            </Link>
          </span>
          <span
            className={cn('truncate text-ink-3', source.path ? 'font-mono text-xs' : 'text-sm')}
          >
            {source.text}
          </span>
        </span>
        <span className="shrink-0 text-ink-3 text-sm tabular-nums">
          {acceptedLine(state, today)}
        </span>
        {menu ? (
          <ItemMenuButton
            menu={menu}
            label={`Действия ${state.item_id}`}
            size="icon-sm"
            className="relative z-10 -mr-1"
          />
        ) : null}
      </div>
    )
  }
  if (state.kind !== 'rejected') {
    return null
  }
  const [first] = group.files
  return (
    <div data-selected={selected} className={ROW}>
      <Thumb
        seed={first?.thumb.key ?? `draft:${group.id}`}
        src={first?.thumb.url}
        kind={groupKind(group)}
        aspect="1:1"
        showCaptions={false}
        className="w-10 shrink-0 rounded-md"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{group.title}</span>
        <span className="truncate text-muted-foreground text-sm">{rejectedLine(state, today)}</span>
      </span>
      <span className="shrink-0 text-ink-3 text-sm">{daysLeft(state)}</span>
      <Button
        variant="outline"
        size="sm"
        disabled={restoring}
        onClick={(event) => {
          event.stopPropagation()
          onRestore(group.id)
        }}
      >
        Вернуть в работу
      </Button>
    </div>
  )
}
