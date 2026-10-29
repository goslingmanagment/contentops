import type {
  AccountCode,
  CatalogEntry,
  ItemId,
  LocalDate,
  PlanRow,
  SurfaceKind,
  WeekNorm,
} from '@contentops/contracts'
import { Thumb } from '@contentops/ui/components/thumb'
import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { type ReactNode, useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useItemLoader } from '@/data/plan'
import { itemCover } from '@/lib/item-cover'
import { accountOf } from '@/lib/words'
import type { PlanDialogPreset } from '@/shell/dialogs/plan-dialog-context'
import { useCurrentModel } from '@/shell/model/model-context'
import { pickVersions } from '../dialog/fyp-versions'
import { allowedSurfaces, blockedReason, normTime } from '../dialog/rules'
import { useCreateRows } from '../shared/actions/use-create-rows'
import { useRowActions } from '../shared/actions/use-row-actions'
import { rowTitle } from '../shared/plan-text'
import { RowThumb } from '../shared/row-thumb'
import { canMove } from './week-layout'

/** Что тащат: строку недели (перенос) или плитку из ящика «Ещё не залито» (постановка). */
export type WeekDragData =
  | { kind: 'row'; row: PlanRow }
  | { kind: 'item'; entry: CatalogEntry; surface: SurfaceKind }

/** Куда отпускают: ячейку «день × страница» или подпись дня. */
export type WeekDropData =
  | { kind: 'cell'; date: LocalDate; account: AccountCode }
  | { kind: 'day'; date: LocalDate }

function isDragData(value: unknown): value is WeekDragData {
  return typeof value === 'object' && value !== null && 'kind' in value
}

function isDropData(value: unknown): value is WeekDropData {
  return typeof value === 'object' && value !== null && 'kind' in value && 'date' in value
}

interface WeekDndProps {
  norms: readonly WeekNorm[]
  canAct: boolean
  /** Плитку отпустили на подпись дня: окно «В план» со страницами по норме. */
  onOpenDialog: (items: readonly ItemId[], preset: PlanDialogPreset) => void
  children: ReactNode
}

/**
 * Перетаскивание в неделе (DESIGN §4.12): плитка из ящика на ячейку — строка сразу, с
 * проверкой и полоской «Поставлено · … · Отменить»; на подпись дня — окно «В план»;
 * строка в другую ячейку — перенос. Нажатие без сдвига остаётся выделением.
 */
export function WeekDnd({ norms, canAct, onOpenDialog, children }: WeekDndProps) {
  const model = useCurrentModel()
  const toast = useActionToast()
  const rows = useRowActions()
  const create = useCreateRows()
  const loadItem = useItemLoader(model.code)
  const [dragging, setDragging] = useState<WeekDragData | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const placeItem = async (
    entry: CatalogEntry,
    surface: SurfaceKind,
    date: LocalDate,
    code: AccountCode,
  ) => {
    const account = accountOf(model.accounts, code)
    if (!account) {
      return
    }
    const blocked =
      blockedReason(entry, account) ??
      (allowedSurfaces(entry.type, account.platform).includes(surface)
        ? null
        : 'сюда такое место не ставится')
    if (blocked) {
      toast.show({ message: `Не поставлено: ${blocked}`, tone: 'error' })
      return
    }
    const versions =
      surface === 'fyp' ? pickVersions((await loadItem(entry.id)).fyp_versions, [code]) : []
    create.create([
      {
        item_id: entry.id,
        account: code,
        surface,
        date,
        time: normTime(norms, code, surface),
        fyp_version: versions[0] ? { no: versions[0].no, level: account.uniq_level } : null,
        assignee: null,
        note: null,
        requires_new_upload: false,
        awaiting_montage: null,
        marked: null,
      },
    ])
  }

  const moveRow = (row: PlanRow, date: LocalDate, code: AccountCode) => {
    if (row.date === date && row.account === code) {
      return
    }
    if (!canMove(row)) {
      toast.show({
        message: 'Отмеченную строку перенести нельзя — сначала снимите отметку',
        tone: 'error',
      })
      return
    }
    const time = code === row.account ? row.time : (normTime(norms, code, row.surface) ?? row.time)
    rows.move(row, { date, time, account: code })
  }

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null)
    const drag = event.active.data.current
    const drop = event.over?.data.current
    if (!canAct || !isDragData(drag) || !isDropData(drop)) {
      return
    }
    if (drop.kind === 'day') {
      if (drag.kind === 'item') {
        onOpenDialog([drag.entry.id], { date: drop.date, surface: drag.surface })
      }
      return
    }
    if (drag.kind === 'row') {
      moveRow(drag.row, drop.date, drop.account)
      return
    }
    void placeItem(drag.entry, drag.surface, drop.date, drop.account)
  }

  const onDragStart = (event: DragStartEvent) => {
    const drag = event.active.data.current
    setDragging(isDragData(drag) ? drag : null)
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {dragging ? <DragPreview drag={dragging} /> : null}
      </DragOverlay>
    </DndContext>
  )
}

/** Перетаскиваемая плитка: та же мини-строка с тенью §7.5. */
function DragPreview({ drag }: { drag: WeekDragData }) {
  const title = drag.kind === 'row' ? rowTitle(drag.row) : drag.entry.title
  const id = drag.kind === 'row' ? drag.row.manifest?.item_id : drag.entry.id
  return (
    <div className="flex h-11 w-56 cursor-grabbing items-center gap-2 rounded-lg bg-background px-1.5 shadow-lg">
      {drag.kind === 'row' ? (
        <RowThumb row={drag.row} size="mini" />
      ) : (
        <Thumb
          {...itemCover(drag.entry)}
          showCaptions={false}
          className="w-7 shrink-0 rounded-md"
        />
      )}
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm">{title}</span>
        {id ? <span className="text-ink-3 text-xs">{id}</span> : null}
      </span>
    </div>
  )
}
