import type { Account, CatalogEntry, CheckCase } from '@contentops/contracts'
import type { Decision, PendingAction } from '../use-case-decisions'

/** Что получает тело панели пары любого вида случая (DESIGN §4.15). */
export interface CaseBodyProps {
  entry: CheckCase
  account: Account
  /** Наш объект из индекса модели: состав и длительность. */
  ours: CatalogEntry | undefined
  /** «Только чтение» видит пару без кнопок. */
  canDecide: boolean
  pending: PendingAction | null
  onDecide: (decision: Decision) => void
  /** «Залить заново»: окно «В план» для этого объекта. */
  onReupload: () => void
  /** Панель открыта с «Привязать…»: поиск по каталогу сразу в фокусе. */
  focusSearch: boolean
}
