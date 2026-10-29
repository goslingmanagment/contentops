import { formatNumber, type MarkKind, type PlanRow, type Release } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { DownloadButton } from '@contentops/ui/components/download-button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@contentops/ui/components/dropdown-menu'
import type { ItemMenuModel } from '@contentops/ui/components/item-menu'
import { SelectionBar } from '@contentops/ui/components/selection-bar'
import { CheckCheckIcon, CheckIcon, ChevronDownIcon } from 'lucide-react'
import { useMarkActions } from './actions/use-mark-actions'
import { usePlanDownload } from './actions/use-plan-download'
import { useRowActions } from './actions/use-row-actions'
import { markableRows, rememberedMarkKind } from './row-action'
import type { RowEditMode } from './row-menu'

interface RowsSelectionBarProps {
  rows: readonly PlanRow[]
  /** Выделены ровно строки выпуска: «Скачать выпуск ▾» вместо «Скачать N ▾». */
  release: Release | null
  onClear: () => void
  /** «Перенести…», «Передать другому…» — правка в панели для всех выбранных. */
  onEdit: (mode: Extract<RowEditMode, 'move' | 'assignee'>) => void
  /** «Показать» в итоге пакета выделяет непрошедшие строки (§3.3). */
  onShowFailed: (rowIds: readonly string[]) => void
  /** Открыта панель, места мало: скачивание уходит в «⋯» полосы. */
  compact?: boolean
}

/**
 * Полоса выделения строк плана (DESIGN §3.3, §4.11): «Отметить N ▾», «Отметить и
 * подтвердить M» (строки, которые Hub не проверяет, — своей кнопкой, два вида не
 * смешиваются), «Скачать N ▾»; в «⋯» — перенос, передача и отмена строк.
 */
export function RowsSelectionBar({
  rows,
  release,
  onClear,
  onEdit,
  onShowFailed,
  compact = false,
}: RowsSelectionBarProps) {
  const marks = useMarkActions({ onShowFailed })
  const actions = useRowActions()
  const zip = usePlanDownload()
  const { mark, confirm } = markableRows(rows)
  const withItems = rows.filter((row) => row.manifest !== null)
  const open = rows.filter((row) => row.mark === null && row.cancelled === null)
  const confirmFirst = mark.length === 0

  const downloadAll = () =>
    release
      ? zip.download({ scope: 'release', release: release.id }, null, true)
      : actions.downloadAll(withItems, true)
  const downloadLabel = release ? 'Скачать выпуск' : `Скачать ${formatNumber(withItems.length)}`
  const menu: ItemMenuModel = {
    actions: [
      ...(compact && withItems.length > 0
        ? [{ id: 'download', label: downloadLabel, onSelect: downloadAll }]
        : []),
      ...(open.length > 0
        ? [
            { id: 'move', label: 'Перенести…', onSelect: () => onEdit('move') },
            { id: 'assignee', label: 'Передать другому…', onSelect: () => onEdit('assignee') },
          ]
        : []),
    ],
    dangerActions:
      open.length > 0
        ? [{ id: 'cancel', label: 'Отменить строки…', onSelect: () => actions.cancel(open) }]
        : [],
  }

  return (
    <SelectionBar count={rows.length} onClear={onClear} menu={menu}>
      {mark.length > 0 ? (
        <MarkManyButton
          count={mark.length}
          pending={marks.pending}
          onMark={(kind) => marks.markMany(mark, kind)}
        />
      ) : null}
      {confirm.length > 0 ? (
        <Button
          variant={confirmFirst ? 'default' : 'bar'}
          pending={marks.pending}
          onClick={() => marks.markConfirmMany(confirm)}
        >
          <CheckCheckIcon />
          Отметить и подтвердить {formatNumber(confirm.length)}
        </Button>
      ) : null}
      {!compact && withItems.length > 0 ? (
        release ? (
          <DownloadButton
            label="Скачать выпуск"
            variant="bar"
            options={[{ id: 'all', label: 'Весь выпуск' }]}
            onDownload={(_, strip) =>
              zip.download({ scope: 'release', release: release.id }, null, strip)
            }
          />
        ) : (
          <DownloadButton
            label={`Скачать ${formatNumber(withItems.length)}`}
            variant="bar"
            options={[{ id: 'platform', label: 'Для заливки' }]}
            onDownload={(_, strip) => actions.downloadAll(withItems, strip)}
          />
        )
      ) : null}
    </SelectionBar>
  )
}

interface MarkManyButtonProps {
  count: number
  pending: boolean
  onMark: (kind: MarkKind) => void
}

/** «Отметить 12 ▾»: по умолчанию — вариант, выбранный в прошлый раз (§4.11). */
function MarkManyButton({ count, pending, onMark }: MarkManyButtonProps) {
  return (
    <div className="inline-flex">
      <Button
        pending={pending}
        className="rounded-r-none"
        onClick={() => onMark(rememberedMarkKind())}
      >
        <CheckIcon />
        Отметить {formatNumber(count)}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            aria-label="Как отметить"
            disabled={pending}
            className="w-8 rounded-l-none border-l border-l-primary-foreground/30"
          >
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem onSelect={() => onMark('posted')}>Выложено</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onMark('scheduled')}>В планировщике</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
