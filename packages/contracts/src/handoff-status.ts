import type { LocalDate, StatusWord } from './domain/common'
import type { HandoffState } from './domain/promo'
import { formatBytes, formatDate, formatPercent } from './format'

export interface HandoffStatusFacts {
  state: HandoffState
  contractor_name: string
  size_bytes: number
  progress: number | null
  sent_on: string | null
  failure: string | null
}

/** Word of a promo handoff (DESIGN §5.7); `today` decides whether the date needs its year. */
export function computeHandoffStatus(facts: HandoffStatusFacts, today: LocalDate): StatusWord {
  switch (facts.state) {
    case 'preparing': {
      const progress = facts.progress === null ? '' : ` · ${formatPercent(facts.progress)}`
      return {
        sign: null,
        word: 'готовится',
        detail: `≈${formatBytes(facts.size_bytes)}${progress}`,
      }
    }
    case 'prepared':
      return { sign: null, word: 'подготовлено', detail: 'ZIP, список файлов, сводка' }
    case 'sent':
      return {
        sign: 'done',
        word: 'передано',
        detail: facts.sent_on
          ? `${facts.contractor_name} ${formatDate(facts.sent_on, today)}`
          : facts.contractor_name,
      }
    case 'failed':
      return { sign: 'trouble', word: 'не собралось', detail: facts.failure }
  }
}
