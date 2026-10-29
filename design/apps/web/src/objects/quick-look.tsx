import {
  type CatalogEntry,
  formatDate,
  type MarkupState,
  type PageSummaryEntry,
  type Tag,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { DownloadButton } from '@contentops/ui/components/download-button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { PlacementLine } from '@contentops/ui/components/placement-line'
import { StatusWord } from '@contentops/ui/components/status-word'
import { Thumb } from '@contentops/ui/components/thumb'
import { useNavigate } from '@tanstack/react-router'
import { useToday } from '@/data/api-session'
import { useRole } from '@/data/session'
import { itemCover } from '@/lib/item-cover'
import { useCurrentModel } from '@/shell/model/model-context'
import { downloadOptionsFor } from './download-options'
import { metaLine } from './item-facts'
import { placementEntries } from './placement-text'
import { useObjectActions } from './use-object-actions'

const MARKUP_WORD: Record<MarkupState, { sign?: 'done'; text: string }> = {
  confirmed: { sign: 'done', text: 'подтверждена' },
  partial: { text: 'подтверждена частично' },
  draft: { text: 'черновик' },
}

interface QuickLookProps {
  entry: CatalogEntry
  summaries: readonly PageSummaryEntry[] | undefined
  tags: readonly Tag[] | undefined
}

/**
 * Быстрый взгляд на один объект, не открывая его (DESIGN §3.4): обложка 132, мета-строка,
 * «где залито» по страницам, разметка и три кнопки. Синяя кнопка экрана — здесь.
 */
export function QuickLook({ entry, summaries, tags }: QuickLookProps) {
  const today = useToday()
  const model = useCurrentModel()
  const navigate = useNavigate()
  const role = useRole()
  const actions = useObjectActions([entry])
  const canAct = role === 'owner' || role === 'manager'
  const markup = MARKUP_WORD[entry.markup]
  const tagNames = entry.tags.map((key) => tags?.find((tag) => tag.key === key)?.ru ?? key)

  return (
    <>
      <InfoSection title={entry.id}>
        <div className="flex gap-4">
          <Thumb {...itemCover(entry)} className="w-33 shrink-0" />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-lg">{entry.title}</p>
            <p className="text-muted-foreground text-sm">{metaLine(entry)}</p>
            <p className="text-ink-3 text-sm tabular-nums">
              пришёл {formatDate(entry.arrived_on, today)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button
            onClick={() =>
              void navigate({ to: '/$model/i/$id', params: { model: model.code, id: entry.id } })
            }
          >
            Открыть
          </Button>
          {canAct ? (
            <>
              <Button variant="secondary" onClick={actions.planIds}>
                В план
              </Button>
              <DownloadButton options={downloadOptionsFor([entry])} onDownload={actions.download} />
            </>
          ) : null}
        </div>
      </InfoSection>
      <InfoSection title="Где залито">
        <PlacementLine
          entries={placementEntries(model.accounts, summaries, today)}
          onSelectPage={() =>
            void navigate({ to: '/$model/i/$id', params: { model: model.code, id: entry.id } })
          }
          className="-ml-2 grid grid-cols-1 gap-y-0 [&>li[aria-hidden]]:hidden"
        />
      </InfoSection>
      <InfoSection
        title="Разметка"
        aside={<StatusWord sign={markup.sign}>{markup.text}</StatusWord>}
      >
        <p className="text-muted-foreground">
          {tagNames.length > 0 ? `Теги: ${tagNames.join(', ')}` : 'Теги не заполнены'}
        </p>
      </InfoSection>
    </>
  )
}
