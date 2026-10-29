import { formatNumber, type PlanRow, SURFACE_LABEL, type SurfaceKind } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { CheckCheckIcon, CheckIcon } from 'lucide-react'
import { accountLabel } from '@/lib/words'
import { useCurrentModel } from '@/shell/model/model-context'
import { useMarkActions } from '../actions/use-mark-actions'
import { isDoneRow } from '../plan-text'
import { MARK_KIND_LABEL, markableRows, rememberedMarkKind } from '../row-action'

const SURFACE_ORDER: readonly SurfaceKind[] = ['wall', 'fyp', 'vault', 'story', 'dm']

/** «стена 3 · фуп 4»: сколько строк на каждом месте. */
function compositionLine(rows: readonly PlanRow[]): string {
  return SURFACE_ORDER.flatMap((surface) => {
    const count = rows.filter((row) => row.surface === surface).length
    return count > 0 ? [`${SURFACE_LABEL[surface]} ${formatNumber(count)}`] : []
  }).join(' · ')
}

/**
 * Несколько выбранных строк в панели (DESIGN §3.4): сколько, по каким местам и страницам,
 * и те же отметки, что в полосе выделения.
 */
export function SelectionDetails({ rows }: { rows: readonly PlanRow[] }) {
  const model = useCurrentModel()
  const marks = useMarkActions()
  const { mark, confirm } = markableRows(rows)
  const pages = [...new Set(rows.map((row) => row.account))]
    .map((code) => accountLabel(model.accounts, code))
    .join(', ')
  const done = rows.filter(isDoneRow).length
  const kind = rememberedMarkKind()
  return (
    <InfoSection title={`Выбрано ${formatNumber(rows.length)}`}>
      <p className="text-base">{compositionLine(rows)}</p>
      <p className="text-ink-3 text-sm">
        {pages}
        {done > 0 ? ` · сделано ${formatNumber(done)}` : ''}
      </p>
      <div className="flex flex-col items-stretch gap-2 pt-1">
        {mark.length > 0 ? (
          <Button pending={marks.pending} onClick={() => marks.markMany(mark, kind)}>
            <CheckIcon />
            Отметить {formatNumber(mark.length)}: {MARK_KIND_LABEL[kind]}
          </Button>
        ) : null}
        {confirm.length > 0 ? (
          <Button
            variant={mark.length > 0 ? 'outline' : 'default'}
            pending={marks.pending}
            onClick={() => marks.markConfirmMany(confirm)}
          >
            <CheckCheckIcon />
            Отметить и подтвердить {formatNumber(confirm.length)}
          </Button>
        ) : null}
      </div>
    </InfoSection>
  )
}
