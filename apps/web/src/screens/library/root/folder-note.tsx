import { formatNumber, plural } from '@contentops/contracts'
import { StatusWord } from '@contentops/ui/components/status-word'
import { IntegrationPhrase } from '@/shell/integration/integration-phrase'
import type { FolderNote } from './library-folders'

/** «1 заказ просрочен», «2 заказа просрочены», «5 заказов просрочено». */
function overdueText(count: number): string {
  const noun = plural(count, ['заказ', 'заказа', 'заказов'])
  const verb = plural(count, ['просрочен', 'просрочены', 'просрочено'])
  return `${formatNumber(count)} ${noun} ${verb}`
}

/**
 * Третья строка папки (DESIGN §4.1): «+3 за неделю» серым, «▲ 1 заказ просрочен» или
 * строка интеграции на «Ещё не залито».
 */
export function FolderNoteView({ note }: { note: FolderNote | null }) {
  if (!note) {
    return null
  }
  switch (note.kind) {
    case 'week':
      return <span className="tabular-nums">+{formatNumber(note.count)} за неделю</span>
    case 'overdue':
      return <StatusWord sign="trouble">{overdueText(note.count)}</StatusWord>
    case 'integration':
      return <IntegrationPhrase line={note.line} short={note.short} className="max-w-full" />
  }
}
