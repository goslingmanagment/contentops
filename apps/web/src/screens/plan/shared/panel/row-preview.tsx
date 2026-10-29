import type { CatalogEntry, PlanRow } from '@contentops/contracts'
import { PanelHead, PanelTitle } from '@contentops/ui/components/panel-pin'
import { Thumb } from '@contentops/ui/components/thumb'
import { Link } from '@tanstack/react-router'
import { ArrowRightIcon, FilmIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { itemCover, itemCoverById } from '@/lib/item-cover'
import { accountLabel } from '@/lib/words'
import { useCurrentModel } from '@/shell/model/model-context'
import { rowSubtitle, rowTitle, slotText } from '../plan-text'

interface RowPreviewProps {
  row: PlanRow
  /** Запись каталога для длительности и числа фото на обложке. */
  entry: CatalogEntry | undefined
  /** «⋯» строки справа от названия. */
  menu?: ReactNode
}

/**
 * Верх панели строки (DESIGN §4.11): название, куда и когда и «⋯» — в закреплённом верху
 * панели (§3.4); превью 132 × 176 (у видео фупа — 9:16, вписано) и «Открыть объект →» —
 * первым в прокрутке.
 */
export function RowPreview({ row, entry, menu }: RowPreviewProps) {
  const model = useCurrentModel()
  const manifest = row.manifest
  const vertical = manifest?.thumb.ratio === '9:16'
  return (
    <>
      <PanelHead>
        <PanelTitle
          title={rowTitle(row)}
          lines={[
            rowSubtitle(row),
            `${accountLabel(model.accounts, row.account)} · ${slotText(row.date, row.time)}${row.assignee ? ` · ${row.assignee.name}` : ''}`,
          ]}
          menu={menu}
        />
      </PanelHead>
      <div className="flex items-end gap-4">
        <div className="w-33 shrink-0">
          {manifest ? (
            <Thumb
              {...(entry ? itemCover(entry) : itemCoverById(manifest.item_id))}
              seed={manifest.thumb.key}
              mediaAspect={vertical ? '9:16' : undefined}
              className="rounded-lg"
            />
          ) : (
            <div className="flex aspect-[3/4] items-center justify-center rounded-lg border border-input border-dashed text-ink-3">
              <FilmIcon className="size-6" />
            </div>
          )}
        </div>
        {manifest ? (
          <Link
            to="/$model/i/$id"
            params={{ model: model.code, id: manifest.item_id }}
            className="inline-flex items-center gap-1 text-primary-ink text-sm hover:underline"
          >
            Открыть объект
            <ArrowRightIcon className="size-3.5" />
          </Link>
        ) : row.awaiting_montage ? (
          <Link
            to="/$model/i/$id"
            params={{ model: model.code, id: row.awaiting_montage.from_item }}
            className="inline-flex items-center gap-1 text-primary-ink text-sm hover:underline"
          >
            Открыть {row.awaiting_montage.from_item}
            <ArrowRightIcon className="size-3.5" />
          </Link>
        ) : null}
      </div>
    </>
  )
}
