import { addMinutes } from '@contentops/contracts/clock'
import type { ConflictDetails } from '@contentops/contracts/domain/errors'
import { DomainError } from '../../domain-error'
import type { MockState } from '../../state'

/**
 * Versions of settings records (people, thresholds, tags). A change carries `If-Match`;
 * a stale version answers 412 with who changed the record and what it holds now.
 */

interface VersionedRecord {
  version: number
}

interface VersionCheck<Record extends VersionedRecord> {
  /** Field for «… изменил «Допуск времени»». */
  field: string
  /** With `?demo=conflict` the owner's other device changes the record first. */
  rival: (record: Record) => void
  /** What the record holds now, for «Показать тот вариант». */
  valueOf: (record: Record) => unknown
}

/** Settings are changed only by the owner, so the rival is the owner on another device. */
const RIVAL_NAME = 'Дмитрий'

export function checkVersion<Record extends VersionedRecord>(
  state: MockState,
  ifMatch: number | null,
  record: Record,
  check: VersionCheck<Record>,
): void {
  // The demo conflict happens once per record: while it is untouched, the rival edits it.
  if (state.demo === 'conflict' && record.version === 1) {
    check.rival(record)
    record.version += 1
  }
  if (ifMatch === null) {
    throw new DomainError('precondition_required', 'Нужна версия записи (If-Match)')
  }
  if (ifMatch !== record.version) {
    const details: ConflictDetails = {
      changed_by: RIVAL_NAME,
      changed_at: addMinutes(state.clock.now(), -1),
      field: check.field,
      current_version: record.version,
      current_value: check.valueOf(record),
    }
    throw new DomainError('version_mismatch', 'Запись уже изменили', details)
  }
}
