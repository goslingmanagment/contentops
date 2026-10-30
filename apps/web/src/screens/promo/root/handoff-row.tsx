import { formatDate, type Handoff, mskDate } from '@contentops/contracts'
import { Thumb } from '@contentops/ui/components/thumb'
import { cn } from '@contentops/ui/lib/utils'
import { useToday } from '@/data/api-session'
import { HandoffStatus } from '../shared/handoff-status'
import { mediaComposition } from '../shared/promo-text'

interface HandoffRowProps {
  handoff: Handoff
  /** Название подборки из индекса: «КП2 офис нейлон». */
  title: string | null
  selected: boolean
  /** Открыть подборку с этой передачей в панели. */
  onOpen: () => void
}

/**
 * Строка списка «Передачи» 52 (DESIGN §4.17): дата, подрядчик, подборка, «60 видео ·
 * 2,65 ГБ», состояние. Нажатие открывает подборку с этой передачей в панели.
 */
export function HandoffRow({ handoff, title, selected, onOpen }: HandoffRowProps) {
  const today = useToday()
  const collection = title ? `${handoff.collection_id} · ${title}` : handoff.collection_id
  return (
    <div
      data-selected={selected}
      className={cn(
        'relative flex h-13 min-w-0 items-center gap-3 rounded-lg px-2 transition-colors duration-120 hover:bg-accent',
        selected && 'bg-primary-tint hover:bg-primary-tint',
      )}
    >
      <Thumb
        seed={handoff.collection_id}
        kind="promo"
        aspect="1:1"
        showCaptions={false}
        className="w-10 shrink-0 rounded-md"
      />
      <span className="w-12 shrink-0 text-muted-foreground text-sm tabular-nums">
        {formatDate(handoff.sent_on ?? mskDate(handoff.created_at), today)}
      </span>
      <span className="w-36 shrink-0 truncate text-base">{handoff.contractor_name}</span>
      {/* Нажатие в любом месте строки открывает подборку; клавиши слушает список. */}
      <button
        type="button"
        tabIndex={-1}
        onClick={onOpen}
        className="min-w-0 flex-1 truncate text-left text-base outline-none after:absolute after:inset-0 after:rounded-lg"
      >
        {collection}
      </button>
      <span className="w-52 shrink-0 truncate text-muted-foreground text-sm tabular-nums">
        {mediaComposition(handoff)}
      </span>
      <HandoffStatus
        status={handoff.status}
        progress={handoff.state === 'preparing' ? handoff.progress : null}
        short
        className="w-40 shrink-0"
      />
    </div>
  )
}
