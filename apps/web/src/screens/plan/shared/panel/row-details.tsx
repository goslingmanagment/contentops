import {
  type CatalogEntry,
  type CheckCase,
  formatNumber,
  type PlanRow,
  plural,
  type Release,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { ItemMenuButton, type ItemMenuModel } from '@contentops/ui/components/item-menu'
import { PanelMain } from '@contentops/ui/components/panel-pin'
import type { ReactNode } from 'react'
import { accountLabel, accountOf } from '@/lib/words'
import { useCurrentModel } from '@/shell/model/model-context'
import { MarkControl } from '../mark-control'
import { rowsWord } from '../plan-text'
import { rowActionOf } from '../row-action'
import { PairBlock, RowFacts } from './row-facts'
import { RowFiles } from './row-files'
import { RowPreview } from './row-preview'

export interface RowDetailsHandlers {
  /** Меню «⋯» строки — то же, что в строке и по правому клику (§3.6). */
  menuFor: (row: PlanRow) => ItemMenuModel
  onUploadMontage: (row: PlanRow) => void
  /** «Выпуск PPV-076: …» выделяет строки выпуска. */
  onSelectRelease: (release: Release) => void
}

interface RowDetailsProps extends RowDetailsHandlers {
  row: PlanRow
  entry: CatalogEntry | undefined
  /** Случай сверки строки ◆: пара прямо в панели. */
  checkCase: CheckCase | undefined
  release: Release | undefined
  /** Правка «Перенести…», «Заметка», «Передать другому», если открыта. */
  editor: ReactNode
  canAct: boolean
}

/**
 * Рабочее место строки (DESIGN §4.11): название, «⋯» и главная кнопка — в закреплённом
 * верху панели (§3.4); в прокрутке — превью, «Как дела», пара для ◆, «Скачать для
 * <страницы>» и выпуск.
 */
export function RowDetails({
  row,
  entry,
  checkCase,
  release,
  editor,
  canAct,
  menuFor,
  onUploadMontage,
  onSelectRelease,
}: RowDetailsProps) {
  const model = useCurrentModel()
  const action = rowActionOf(row, canAct)
  const menu = menuFor(row)
  const hasMenu = menu.actions.length > 0 || (menu.dangerActions?.length ?? 0) > 0
  const account = accountOf(model.accounts, row.account)
  // У ◆ главное действие — в паре ниже: «Это оно» или «Разобрать».
  const showMain = action.kind !== 'none' && action.kind !== 'check'
  return (
    <>
      <RowPreview
        row={row}
        entry={entry}
        menu={
          hasMenu ? <ItemMenuButton menu={menu} size="icon-sm" label="Действия строки" /> : null
        }
      />
      {showMain ? (
        <PanelMain>
          <MarkControl
            row={row}
            canAct={canAct}
            variant="panel"
            onCheck={() => undefined}
            onUploadMontage={() => onUploadMontage(row)}
          />
        </PanelMain>
      ) : null}
      {editor}
      <RowFacts row={row} />
      {checkCase && account ? (
        <PairBlock checkCase={checkCase} platformLabel={account.label} />
      ) : null}
      <RowFiles row={row} accountLabel={accountLabel(model.accounts, row.account)} />
      {release ? <ReleaseLine release={release} onSelect={() => onSelectRelease(release)} /> : null}
    </>
  )
}

/** «Выпуск PPV-076: 14 строк на 5 страницах, сделано 3». */
function ReleaseLine({ release, onSelect }: { release: Release; onSelect: () => void }) {
  const pages = `${formatNumber(release.accounts)} ${plural(release.accounts, ['странице', 'страницах', 'страницах'])}`
  return (
    <InfoSection title={`Выпуск ${release.item_id}`}>
      <p className="text-base">
        {rowsWord(release.row_ids.length)} на {pages}, сделано {formatNumber(release.done)}
      </p>
      <Button variant="link" size="inline" className="self-start text-sm" onClick={onSelect}>
        Выделить строки выпуска
      </Button>
    </InfoSection>
  )
}
