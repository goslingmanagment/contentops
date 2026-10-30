import { CONTRACTOR_FORMAT_LABEL, type Handoff, type PromoCollection } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { PanelFrame, type PanelFrameWidth } from '@contentops/ui/components/panel-frame'
import { DownloadIcon, PlusIcon, RotateCcwIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useDeliverDownload } from '@/actions/use-deliver-download'
import { useRole } from '@/data/session'
import { useCurrentModel } from '@/shell/model/model-context'
import { HandoffStatus } from '../shared/handoff-status'
import { mediaComposition, memberRefOf } from '../shared/promo-text'
import { usePromoActions } from '../shared/use-promo-actions'
import { HandoffFiles } from './handoff-files'
import { HandoffSummary } from './handoff-summary'

interface HandoffStatePanelProps {
  collection: PromoCollection
  handoff: Handoff
  /** «Новая передача», «Подготовить заново»: шаг 1 той же подборки. */
  onNew: () => void
  /** «Собрать заново» завёл новую передачу — панель переходит к ней. */
  onStarted: (handoffId: string) => void
  onClose: () => void
  width: PanelFrameWidth
  history: ReactNode
}

/**
 * Шаг 2 передачи (DESIGN §4.17, §5.7): «готовится» с ходом, «подготовлено» — ZIP со
 * списком файлов, сводка для Telegram и «Передано», ✓ «передано» с досылкой новой
 * передачей, ▲ «не собралось» с «Собрать заново». Главная кнопка — под заголовком.
 */
export function HandoffStatePanel({
  collection,
  handoff,
  onNew,
  onStarted,
  onClose,
  width,
  history,
}: HandoffStatePanelProps) {
  const model = useCurrentModel().code
  const role = useRole()
  // «Только чтение» видит передачу и её историю, но не скачивает и не передаёт (SPEC §11.1).
  const editable = role === 'owner' || role === 'manager'
  const actions = usePromoActions()
  const deliver = useDeliverDownload()
  // A prepared handoff keeps its own format, whatever the contractor has now (SPEC §7.1).
  const format = handoff.format

  const download = () => {
    if (handoff.zip_name && handoff.zip_url) {
      deliver(model, [
        {
          kind: 'ready',
          download_url: handoff.zip_url,
          file_name: handoff.zip_name,
          size_bytes: handoff.size_bytes,
        },
      ])
    }
  }
  const rebuild = () =>
    actions.prepare({
      channel: collection.channel,
      collection: collection.id,
      contractor: handoff.contractor_id,
      stripMetadata: handoff.strip_metadata,
      excludeAlreadyHanded: false,
      members: handoff.member_keys.map(memberRefOf),
      sizeBytes: handoff.size_bytes,
      onStarted,
    })

  const buttons: Record<Handoff['state'], ReactNode> = {
    preparing: null,
    prepared: (
      <>
        <Button
          onClick={() => actions.markSent({ channel: collection.channel, handoff })}
          aria-busy={actions.marking || undefined}
        >
          {actions.marking ? '…' : 'Передано'}
        </Button>
        <Button variant="secondary" onClick={download}>
          <DownloadIcon />
          Скачать ZIP
        </Button>
      </>
    ),
    sent: (
      <Button variant="secondary" onClick={onNew}>
        <PlusIcon />
        Новая передача
      </Button>
    ),
    failed: (
      <Button onClick={rebuild} aria-busy={actions.preparing || undefined}>
        <RotateCcwIcon />
        {actions.preparing ? '…' : 'Собрать заново'}
      </Button>
    ),
  }

  return (
    <PanelFrame
      label={`Передача ${collection.id}`}
      title={`Передача ${collection.id}`}
      subtitle={
        <HandoffStatus
          status={handoff.status}
          progress={handoff.state === 'preparing' ? handoff.progress : null}
          className="w-full"
        />
      }
      width={width}
      onClose={onClose}
      actions={editable ? buttons[handoff.state] : null}
    >
      <InfoSection title="Подрядчик">
        <p className="text-base">{handoff.contractor_name}</p>
        <p className="text-muted-foreground text-sm">
          {format ? `${CONTRACTOR_FORMAT_LABEL[format]} · ` : ''}
          {handoff.strip_metadata ? 'метаданные стёрты' : 'метаданные оставлены'}
        </p>
      </InfoSection>
      <InfoSection title="Состав">
        <p className="text-base tabular-nums">{mediaComposition(handoff)}</p>
        {editable && handoff.state === 'prepared' ? (
          // До «Передано» состав можно поменять в подборке и подготовить заново.
          <Button variant="link" size="inline" className="self-start" onClick={onNew}>
            Подготовить заново
          </Button>
        ) : null}
      </InfoSection>
      {handoff.state === 'prepared' || handoff.state === 'sent' ? (
        <>
          <HandoffSummary text={handoff.summary_text} />
          <HandoffFiles handoff={handoff} />
        </>
      ) : null}
      {history}
    </PanelFrame>
  )
}
