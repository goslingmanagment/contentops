import type { ItemFile } from '../domain/files'
import type { ItemId } from '../domain/item-type'
import { synthesizeFiles } from './item-files'
import type { ItemRecord } from './world-types'

/**
 * States of the object page that the §9.3 table names but the generator does not give:
 * PPV-076 — the master is still being compressed (DESIGN §4.4, «мастер собирается»).
 */

type RecordPatch = (record: ItemRecord) => void

function withMasterState(files: ItemFile[], state: ItemFile['state']): ItemFile[] {
  return files.map((file) => (file.role === 'master' ? { ...file, state } : file))
}

const PATCHES: Record<ItemId, RecordPatch> = {
  'PPV-076': (record) => {
    const files = record.files ?? synthesizeFiles(record.entry)
    record.files = withMasterState(files, {
      kind: 'processing',
      label: 'сжимается',
      progress: 0.62,
    })
  },
}

/** Applies after the detailed records, so it can build on their files. */
export function applyObjectPageStates(records: Map<ItemId, ItemRecord>) {
  for (const [id, patch] of Object.entries(PATCHES)) {
    const record = records.get(id)
    if (record) patch(record)
  }
}
