import { InfoPanel } from '@contentops/ui/components/info-panel'
import { useObjectPage } from '../object-context'
import { PageDetail } from '../placement/page-detail'
import { FlagsSection } from './flags-section'
import { HandoffsSection } from './handoffs-section'
import { HistoryTab } from './history-tab'
import { MarkupSection } from './markup-section'
import { OrderSection } from './order-section'
import { ProvenanceSection } from './provenance-section'
import { YdiskSection } from './ydisk-section'

interface ObjectPanelProps {
  width: 'default' | 'narrow'
  onClose: () => void
}

/**
 * Панель «Сведения / История» объекта (DESIGN §4.4): раскрытая страница «где залито»
 * сверху, затем разметка, отметки, происхождение, Я.Диск и заказ или передачи.
 */
export function ObjectPanel({ width, onClose }: ObjectPanelProps) {
  const { detail, search, setSearch } = useObjectPage()
  const page = detail.pages.find((candidate) => candidate.account === search.page)
  const type = detail.entry.type
  return (
    <InfoPanel
      width={width}
      onClose={onClose}
      value={search.tab === 'history' ? 'history' : 'info'}
      onValueChange={(tab) =>
        setSearch({ tab: tab === 'history' ? 'history' : undefined }, { replace: true })
      }
      tabs={[
        {
          value: 'info',
          label: 'Сведения',
          content: (
            <>
              {page ? <PageDetail page={page} /> : null}
              <MarkupSection />
              {type === 'promo' ? null : <FlagsSection />}
              <ProvenanceSection />
              <YdiskSection />
              {type === 'custom' ? <OrderSection /> : null}
              {type === 'promo' ? <HandoffsSection /> : null}
            </>
          ),
        },
        { value: 'history', label: 'История', content: <HistoryTab /> },
      ]}
    />
  )
}
