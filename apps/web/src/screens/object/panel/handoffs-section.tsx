import { formatBytes, formatNumber, type Handoff } from '@contentops/contracts'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { StatusSign } from '@contentops/ui/components/status-sign'
import { usePromoCollection } from '@/data/promo'
import { useObjectPage } from '../object-context'

/** «GaranTTeam 18.09 · 60 видео · 2,65 ГБ». */
function handoffDetail(handoff: Handoff): string {
  const parts = [
    handoff.status.detail,
    handoff.video_count > 0 ? `${formatNumber(handoff.video_count)} видео` : null,
    handoff.photo_count > 0 ? `${formatNumber(handoff.photo_count)} фото` : null,
    handoff.state === 'sent' ? formatBytes(handoff.size_bytes) : null,
  ]
  return parts.filter((part): part is string => part !== null).join(' · ')
}

/** «Передачи» подборки промо (DESIGN §4.5): «✓ передано GaranTTeam 18.09 · 60 видео · 2,65 ГБ». */
export function HandoffsSection() {
  const { detail, model } = useObjectPage()
  const collection = usePromoCollection(model.code, detail.entry.id).data
  const handoffs = collection?.handoffs ?? []
  return (
    <InfoSection title="Передачи">
      {handoffs.length === 0 ? (
        <p className="text-ink-3">Ещё не передавали</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {handoffs.map((handoff) => (
            <li key={handoff.id} className="flex items-start gap-1.5 text-sm">
              {handoff.status.sign ? (
                <StatusSign kind={handoff.status.sign} className="mt-0.5 shrink-0" />
              ) : null}
              <span>
                {handoff.status.word}
                <span className="text-ink-3"> · {handoffDetail(handoff)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </InfoSection>
  )
}
