import type { ThumbRef } from './domain/common'
import type { ItemId, ItemType } from './domain/item-type'
import { parseItemId } from './domain/item-type'
import { hashString } from './hash'

/**
 * What a thumbnail shows, read from its key. Keys of the prototype: `PPV-073` (cover),
 * `PPV-073/frame03`, `FYP-0801/u2`, `draft:g-2254/1`, `legacy:ppv-032-milk`.
 * Synthetic covers (DESIGN §7.9) pick their family and motif from `seed`.
 */
export interface ThumbSubject {
  item_id: ItemId | null
  type: ItemType | null
  /** File or frame inside the object: `master`, `frame03`, `ph07`. */
  part: string | null
  /** Stable number for picking a family and a motif. */
  seed: number
}

export function thumbSubject(ref: ThumbRef): ThumbSubject {
  const [head = '', part = null] = ref.key.split('/', 2)
  const parsed = parseItemId(head)
  return {
    item_id: parsed ? head : null,
    type: parsed?.type ?? null,
    part,
    seed: hashString(ref.key),
  }
}
