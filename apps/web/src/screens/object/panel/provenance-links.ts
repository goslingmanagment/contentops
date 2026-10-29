import type { ItemType, ProvenanceRelation } from '@contentops/contracts'

export interface LinkKind {
  id: string
  relation: ProvenanceRelation
  direction: 'out' | 'in'
  /** Как читается связь от этого объекта: «Сделано из», «Из него». */
  label: string
  /** Для каких типов объекта связь имеет смысл. */
  types?: readonly ItemType[]
}

/** Виды связи в «+ Связь…» (DESIGN §4.4): словами, как их читают в строке. */
export const LINK_KINDS: readonly LinkKind[] = [
  { id: 'made-from', relation: 'made_from', direction: 'out', label: 'Сделано из' },
  { id: 'made-into', relation: 'made_from', direction: 'in', label: 'Из него' },
  {
    id: 'ppv-from-custom',
    relation: 'ppv_from_custom',
    direction: 'out',
    label: 'PPV из кастома',
    types: ['ppv'],
  },
  {
    id: 'custom-to-ppv',
    relation: 'ppv_from_custom',
    direction: 'in',
    label: 'PPV сделан из него',
    types: ['custom'],
  },
  { id: 'remontage-of', relation: 'remontage', direction: 'out', label: 'Перемонтаж из' },
  { id: 'remontage', relation: 'remontage', direction: 'in', label: 'Перемонтаж' },
]

export function linkKindsFor(type: ItemType): LinkKind[] {
  return LINK_KINDS.filter((kind) => !kind.types || kind.types.includes(type))
}
