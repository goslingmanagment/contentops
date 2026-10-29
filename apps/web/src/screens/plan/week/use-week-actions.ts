import {
  formatBytes,
  formatNumber,
  type IsoWeek,
  type LocalDate,
  type PlanRow,
  type PlanWeek,
} from '@contentops/contracts'
import type { ItemMenuModel } from '@contentops/ui/components/item-menu'
import { useCurrentModel } from '@/shell/model/model-context'
import { useMarkActions } from '../shared/actions/use-mark-actions'
import { usePlanDownload } from '../shared/actions/use-plan-download'
import { markableRows } from '../shared/row-action'
import type { PlanAccess } from '../shared/use-plan-access'

/**
 * Действия недели целиком (DESIGN §4.12): «Скачать неделю ▾» — архив по страницам и дням,
 * «⋯ → Отметить в планировщике · 12» — строки впереди, которые отмечает КМ; у КМ — только
 * его строки, число видно до нажатия (§1.5).
 */
export function useWeekActions(
  week: IsoWeek,
  data: PlanWeek | undefined,
  today: LocalDate,
  access: PlanAccess,
) {
  const model = useCurrentModel()
  const marks = useMarkActions()
  const zip = usePlanDownload()
  const canAct = access.canAct
  const mineOnly = access.role === 'manager' && access.personId !== null
  const ahead = data
    ? markableRows(
        data.rows.filter(
          (row) => row.date >= today && (!mineOnly || row.assignee?.id === access.personId),
        ),
      ).mark
    : []
  const menu: ItemMenuModel = {
    actions:
      canAct && ahead.length > 0
        ? [
            {
              id: 'scheduled',
              label: `Отметить в планировщике · ${formatNumber(ahead.length)}`,
              onSelect: () => marks.markMany(ahead, 'scheduled'),
            },
          ]
        : [],
  }
  // Скачать есть что — только строки с копией; объём — у недели и у каждой страницы.
  const withCopies = (data?.rows ?? []).filter(
    (row) => row.manifest !== null && row.cancelled === null && row.copy !== null,
  )
  const bytesOf = (rows: readonly PlanRow[]) =>
    rows.reduce((sum, row) => sum + (row.copy?.state === 'ready' ? row.copy.size_bytes : 0), 0)
  const download =
    canAct && withCopies.length > 0
      ? {
          options: [
            { id: 'all', label: 'Все страницы', hint: formatBytes(bytesOf(withCopies)) },
            ...model.accounts.flatMap((account) => {
              const pageRows = withCopies.filter((row) => row.account === account.code)
              return pageRows.length > 0
                ? [{ id: account.code, label: account.label, hint: formatBytes(bytesOf(pageRows)) }]
                : []
            }),
          ],
          onDownload: (id: string, strip: boolean) =>
            zip.download({ scope: 'week', week }, id === 'all' ? null : id, strip),
        }
      : null
  return { menu, download }
}
