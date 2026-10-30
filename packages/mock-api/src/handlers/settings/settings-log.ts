import type { ModelCode } from '@contentops/contracts/domain/common'
import type { JournalEvent } from '@contentops/contracts/domain/journal'
import type { LogEntry } from '../../handler'

interface SettingsChange {
  action: string
  phrase: string
  changes?: JournalEvent['changes']
}

/**
 * A settings change goes to the journal of every model it touches (DESIGN §4.19: «автор,
 * область, было → стало»). Journals are per model, so a change for all models appears in
 * each of them.
 */
export function logSettingsChange(
  log: (entry: LogEntry) => void,
  models: readonly ModelCode[],
  change: SettingsChange,
): void {
  for (const model of models) {
    log({ area: 'settings', model, ...change })
  }
}
